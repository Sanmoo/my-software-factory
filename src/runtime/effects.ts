/**
 * The external effects a worker session can produce — the shared
 * vocabulary of the host-side continuity check and of the guardrail that runs
 * inside the worker container. One classifier, one set of keys: the host reads
 * a session's journal with exactly the rules the guardrail writes it with, so
 * "was this action mutating, and which effect is it?" has a single answer.
 *
 * The classification is deliberately asymmetric. A command is "safe" only
 * when it belongs to the closed allowlist of things that cannot mutate state
 * outside the worktree (reading, local git, tests, local files); the four
 * supported effects are recognised from their arguments; ANYTHING ELSE is
 * "unknown" — never safe by omission, never safe because it looks read-only to
 * a model. An unknown call that was interrupted therefore stops the recovery
 * instead of being replayed: the safe delivery of an unresolvable mutation is
 * a pause, not a repetition.
 */

import { createHash } from "node:crypto";

export type EffectKind = "push" | "pr" | "comment" | "label";

/** One external effect a single tool call would realise. `key` is its stable
 *  identity: two calls with the same key ask for the same effect. */
export interface EffectAction {
  kind: EffectKind;
  key: string;
  /** The operator's words, for the diagnosis (never a credential). */
  detail: string;
  /** git push / gh pr create: the branch the effect belongs to. */
  branch?: string;
  /** git push: the commit the session intended to publish, when it resolved one. */
  sha?: string;
  /** gh pr comment / gh issue comment: the number AND the exact body, so a
   *  re-read can prove whether that comment landed. */
  target?: "pr" | "issue";
  number?: number;
  body?: string;
  /** gh issue edit --add-label: the label name. */
  label?: string;
}

export type CommandSafety =
  /** Nothing outside the worktree can change. */
  | { safety: "safe" }
  /** A recognised external mutation, by effect. */
  | { safety: "effect"; actions: EffectAction[] }
  /** Not provably free of external effect: an interrupted call of this class
   *  is not replayable (the host pauses the recovery). */
  | { safety: "unknown"; reason: string };

/**
 * Commands that never run another program. Deliberately narrow: an interpreter
 * or a command runner (`node`, `npm`, `python`, `make`, `env`, `xargs`,
 * `find -exec`, `awk`, `sed`) can run arbitrary code — including an external
 * mutation — so it is NOT safe, and an interrupted call of that class pauses
 * the recovery. Same for `docker`: the worker inherits the HOST daemon
 * (ADR 0003) and no reconciliation covers it.
 *
 * Membership alone does not make a call safe: many of these write to the paths
 * they are given, so {@link classifySegment} also refuses any operand that
 * names a path outside the worktree.
 */
const SAFE_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "echo", "printf",
  "pwd", "true", "false", "test", "[", "stat", "file", "du", "df", "which", "type",
  "sleep", "date", "basename", "dirname", "realpath", "readlink", "mkdir", "cp",
  "mv", "rm", "touch", "chmod", "chown", "ln", "diff", "tree", "column", "tee",
  "seq", "yes", "printenv", "id", "whoami", "uname", "nproc",
  "rg", "grep", "egrep", "fgrep", "fd", "jq", "yq", "git", "patch", "tar",
  "unzip", "zip", "gzip", "gunzip", "base64", "sha256sum", "md5sum",
]);

/** The git subcommands whose own effect stays in the clone. `push` is
 *  classified separately ({@link classifyGitPush}); everything absent from
 *  this set is unknown. The subcommand name alone is not enough: `git init
 *  /tmp/x` or `git config --global` still write outside, so the operand scan
 *  in {@link classifySegment} and the `config` guard below apply as well. */
const SAFE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add", "commit", "status", "diff", "log", "show", "branch", "checkout",
  "switch", "restore", "reset", "stash", "rebase", "merge", "cherry-pick",
  "revert", "rev-parse", "rev-list", "cat-file", "config", "fetch", "pull",
  "remote", "tag", "worktree", "ls-files", "ls-tree", "blame", "describe",
  "show-ref", "for-each-ref", "gc", "prune", "clean", "mv", "rm", "apply",
  "init", "clone", "submodule", "notes", "shortlog", "whatchanged", "reflog",
  "symbolic-ref", "update-ref", "check-ignore", "check-attr", "hash-object",
  "count-objects", "fsck", "format-patch", "am", "bisect", "grep",
]);

/** The `gh` invocations that only read. Every `gh` write is either one of the
 *  four recognised effects (classified before this set is consulted) or
 *  unknown — this set never grants safety to a mutation, and it is the ONE
 *  place a read-only invocation is listed. */
const SAFE_GH_INVOCATIONS: ReadonlySet<string> = new Set([
  "pr view", "pr list", "pr diff", "pr checks", "pr status",
  "issue view", "issue list", "issue status",
  "auth", "search", "repo view", "repo list", "run view", "run list",
  "workflow view", "workflow list", "release view", "release list",
]);

/** Commands that are never safe when they appear as a whole segment. */
const NETWORK_OR_UNKNOWN: ReadonlySet<string> = new Set([
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "netcat", "telnet", "ftp",
  "aws", "gcloud", "az", "kubectl", "helm", "terraform", "pulumi", "ansible",
  "eval", "exec", "source", ".", "bash", "sh", "zsh", "fish", "su", "sudo",
  "npx", "systemctl", "service", "crontab", "at", "mail", "sendmail",
]);

/**
 * Classify a shell command for the recovery decision. Compound commands are
 * split on `&&`, `||`, `;` and newlines; every segment must be provably safe
 * or a recognised effect — one unknown segment makes the whole call unknown.
 * A pipe (`|`) is treated as unknown: the right side can do anything with the
 * left side's output and its own effect is not decidable here.
 */
export function classifyCommand(command: string): CommandSafety {
  const trimmed = command.trim();
  if (trimmed === "") return { safety: "safe" };
  const scan = scanShell(trimmed);
  // `$(…)`, a backtick, `<(…)`/`>(…)`: each runs a command whose text is not
  // visible here, so the effect is not this call's to classify.
  if (scan.substitution) {
    return { safety: "unknown", reason: "command or process substitution can hide any effect" };
  }
  if (scan.pipeline) {
    return { safety: "unknown", reason: "a pipeline hides the right side's effect" };
  }
  // A redirection is not resolved here: its target can be any path (and an
  // fd duplication hides one), so the call is not proven local.
  if (scan.redirect) {
    return { safety: "unknown", reason: "a redirection is not resolved — its effect is not local by proof" };
  }

  const segments = splitSegments(trimmed);
  if (segments.length === 0) return { safety: "safe" };

  const actions: EffectAction[] = [];
  for (const raw of segments) {
    const result = classifySegment(raw);
    if (result.safety === "unknown") return result;
    if (result.safety === "effect") actions.push(...result.actions);
  }
  return actions.length === 0 ? { safety: "safe" } : { safety: "effect", actions };
}

/**
 * What the shell will do with a piece of text, read ONCE for the whole
 * classifier: quoting decides what is syntax and what is literal, and two
 * readers disagreeing (one quote-blind) is how a quoted message became
 * `unknown` while a quoted `$` became safe.
 *
 * Inside single quotes nothing is special; inside double quotes only `$` and a
 * backtick are; outside both, `\` escapes the next character.
 */
interface ShellScan {
  /** `$(…)`, a backtick, `<(…)`, `>(…)`. */
  substitution: boolean;
  /** `$VAR` / `${…}` — a value this classifier cannot see. */
  expansion: boolean;
  /** A real pipe (`||` separates commands and is not one). */
  pipeline: boolean;
  /** `>` in any form, including `>>` and `2>`. */
  redirect: boolean;
}

function scanShell(text: string): ShellScan {
  const scan: ShellScan = { substitution: false, expansion: false, pipeline: false, redirect: false };
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    // Inside single quotes NOTHING is special, not even a backslash.
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    // Outside single quotes a backslash escapes the next character (inside
    // `""` too), so it never closes a quote.
    if (char === "\\") {
      index += 1;
      continue;
    }
    // Inside `""` only `$` and a backtick expand: `|`, `>` and `(` are text
    // there, so a comment body like "a | b" stays one literal argument.
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "`") scan.substitution = true;
      else if (char === "$") {
        if (next === "(") scan.substitution = true;
        else scan.expansion = true;
      }
      continue;
    }
    if (char === "'") {
      quote = "'";
      continue;
    }
    if (char === '"') {
      quote = '"';
      continue;
    }
    if (char === "`") {
      scan.substitution = true;
      continue;
    }
    if (char === "$") {
      if (next === "(") scan.substitution = true;
      else scan.expansion = true;
      continue;
    }
    if ((char === "<" || char === ">") && next === "(") {
      scan.substitution = true;
      continue;
    }
    if (char === ">") {
      scan.redirect = true;
      continue;
    }
    if (char === "|" && next !== "|") scan.pipeline = true;
    // `||` is a separator, not a pipe: consume both halves so the second one
    // is not read as a pipe of its own.
    if (char === "|" && next === "|") index += 1;
  }
  return scan;
}

function splitSegments(command: string): string[] {
  // Newlines, `;` and a lone `&` (background) separate commands; `&&`/`||`
  // separate independent ones. A pipe never reaches here: `classifyCommand`
  // refuses it, because the right side's effect is not decidable.
  //
  // Quoting is read exactly as scanShell reads it: `git commit -m "fix: a &&
  // b"` is ONE command, and splitting it would invent a second segment the
  // shell never runs. Quotes are kept in the segment so tokenize can strip
  // them later.
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1];
    // Inside quotes NOTHING is a separator; the closing quote is the only
    // character with a meaning of its own (and `\` still escapes inside `""`).
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      else if (quote === '"' && char === "\\") {
        current += next ?? "";
        i += 1;
      }
      continue;
    }
    if (char === "\\") {
      current += char + (next ?? "");
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (char === "&") {
      // `a & b` starts `b` before `a` finishes: a compound call like any other.
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment !== "");
}

function classifySegment(segment: string): CommandSafety {
  const words = tokenize(segment);
  if (words.length === 0) return { safety: "safe" };

  // An expansion resolves to something this classifier never sees, whatever
  // program runs — so it is refused before the program is even looked at.
  if (scanShell(segment).expansion) {
    return { safety: "unknown", reason: "a shell expansion names a value this classifier cannot resolve" };
  }

  // Leading environment assignments belong to the command that follows them.
  // Nothing else is skipped: a wrapper (`sudo`, `env`, `time`, `nohup`) runs
  // another program and is itself unknown.
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
  if (index >= words.length) return { safety: "safe" };

  const command = words[index]!;
  const args = words.slice(index + 1);
  const safety = classifyBinary(command, args);
  if (safety.safety !== "safe") return safety;

  // A safe binary is still not safe when an operand names a path outside the
  // worktree: the allowlist says WHICH program runs, never WHERE it writes.
  // `git init /tmp/x`, `tar -C/tmp -xf a` and `sort -o /tmp/x f` all pass the
  // program check and all reach the host, where nothing reconciles them.
  const escaping = args.find(namesOutsideWorktree);
  if (escaping !== undefined) {
    return {
      safety: "unknown",
      reason: `${command} ${escaping} names something outside the worktree, where no reconciliation covers the effect`,
    };
  }
  return safety;
}

function classifyBinary(command: string, args: string[]): CommandSafety {
  const binary = command.split("/").pop() ?? command;

  if (NETWORK_OR_UNKNOWN.has(binary)) {
    return { safety: "unknown", reason: `${binary} can reach outside the worktree` };
  }
  // A script path executes arbitrary code.
  if (command.startsWith("./") || command.startsWith("../") || command.startsWith("/")) {
    return { safety: "unknown", reason: `executing ${command} can do anything` };
  }

  if (binary === "git") return classifyGit(args);
  if (binary === "gh") return classifyGh(args);
  // `tar` can hand a member to a program (`--to-command`) or a compressor it
  // starts itself: both run code this classifier never sees.
  if (binary === "tar" && args.some((arg) => /^--(to-command|use-compress-program|checkpoint-action)/.test(arg) || arg === "-I")) {
    return { safety: "unknown", reason: "tar --to-command/--use-compress-program runs an arbitrary command" };
  }

  if (isSafeBinary(binary)) return { safety: "safe" };
  return { safety: "unknown", reason: `${binary} is not a proven-local command` };
}

function classifyGit(args: string[]): CommandSafety {
  const subcommand = args[0] ?? "";
  if (subcommand === "push") return classifyGitPush(args.slice(1));
  if (subcommand === "send-email" || subcommand === "request-pull") {
    return { safety: "unknown", reason: `git ${subcommand} publishes outside the worktree` };
  }
  // `git config` writes a file too: outside the clone with --global/--system.
  if (subcommand === "config" && args.some((arg) => arg === "--global" || arg === "--system")) {
    return { safety: "unknown", reason: "git config --global/--system writes outside the worktree" };
  }
  // These run a PROGRAM this classifier never sees — the same class as `sudo`.
  if (subcommand === "rebase" && args.some((arg) => arg.startsWith("--exec"))) {
    return { safety: "unknown", reason: "git rebase --exec runs an arbitrary command" };
  }
  if (subcommand === "bisect" && args[1] === "run") {
    return { safety: "unknown", reason: "git bisect run executes an arbitrary command" };
  }
  if (subcommand === "submodule" && args[1] === "foreach") {
    return { safety: "unknown", reason: "git submodule foreach executes an arbitrary command" };
  }
  if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) return { safety: "safe" };
  return { safety: "unknown", reason: `git ${subcommand || "(none)"} is not a proven-local subcommand` };
}

function classifyGitPush(args: string[]): CommandSafety {
  let branch: string | undefined;
  let tags = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--tags" || arg === "--all" || arg === "--mirror" || arg === "--follow-tags") {
      tags = true;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  if (tags) {
    return { safety: "unknown", reason: "a tag/all-refs push has no branch-shaped identity to reconcile" };
  }
  // git push [<remote> [<refspec>]] — the refspec may be HEAD, a branch, or
  // LOCAL:REMOTE (and +LOCAL:REMOTE for a force). With ONE positional the
  // argument is the remote and the refspec is git's own default, so the branch
  // is left unresolved: the guardrail reads it from the worktree instead of
  // recording the remote's name as a branch.
  const refspec = positional.length >= 2 ? positional[1] : undefined;
  const [rawLocal, rawRemote] = (refspec ?? "HEAD").replace(/^\+/, "").split(":");
  const local = rawLocal ?? "";
  const remote = rawRemote;
  if (local === "" || local === "HEAD" || local === "@") {
    // The branch and commit are resolved by the guardrail from the worktree
    // (it runs where the repo is); the host then asks the remote. When the
    // remote side of the refspec names a branch, that is the identity.
    if (remote !== undefined && remote !== "") {
      if (remote.startsWith("refs/tags/")) {
        return { safety: "unknown", reason: "a tag push has no branch-shaped identity to reconcile" };
      }
      branch = remote.replace(/^refs\/heads\//, "");
    }
  } else if (/^refs\/(heads|tags)\//.test(local)) {
    branch = local.replace(/^refs\/heads\//, "");
    if (local.startsWith("refs/tags/")) {
      return { safety: "unknown", reason: "a tag push has no branch-shaped identity to reconcile" };
    }
  } else {
    branch = local;
  }
  const keyBranch = branch ?? "<current>";
  return {
    safety: "effect",
    actions: [
      {
        kind: "push",
        key: `push:${keyBranch}`,
        detail: `push branch ${keyBranch}`,
        ...(branch === undefined ? {} : { branch }),
      },
    ],
  };
}

function classifyGh(args: string[]): CommandSafety {
  const [group, sub] = [args[0], args[1]];
  const words = args.filter((arg) => !arg.startsWith("-"));

  if (group === "pr") {
    if (sub === "create") {
      const head = flagValue(args, "--head");
      const branch = head === undefined ? undefined : head.replace(/^[^:]*:/, "");
      return {
        safety: "effect",
        actions: [
          {
            kind: "pr",
            key: `pr:${branch ?? "<current>"}`,
            detail: `open PR from ${branch ?? "the current branch"}`,
            ...(branch === undefined ? {} : { branch }),
          },
        ],
      };
    }
    if (sub === "comment") {
      const comment = parseComment(args);
      if (comment === null) {
        return { safety: "unknown", reason: "a PR comment without its number and body cannot be reconciled" };
      }
      return { safety: "effect", actions: [commentAction("pr", comment)] };
    }
    if (sub === "merge" || sub === "close" || sub === "edit" || sub === "ready" || sub === "reopen") {
      return { safety: "unknown", reason: `gh pr ${sub} has no supported reconciliation` };
    }
  }

  if (group === "issue") {
    if (sub === "comment") {
      const comment = parseComment(args);
      if (comment === null) {
        return { safety: "unknown", reason: "an issue comment without its number and body cannot be reconciled" };
      }
      return { safety: "effect", actions: [commentAction("issue", comment)] };
    }
    if (sub === "edit") {
      const number = issueNumberOf(args);
      const label = flagValue(args, "--add-label");
      if (Number.isInteger(number) && label !== undefined && label !== "") {
        return {
          safety: "effect",
          actions: [
            {
              kind: "label",
              key: `label:${number}:${label}`,
              detail: `add label ${label} to issue #${number}`,
              number,
              label,
            },
          ],
        };
      }
      return { safety: "unknown", reason: "gh issue edit has no supported reconciliation for this change" };
    }
  }

  if (group === "api") {
    // `gh api` without a mutating method is a read. The method may be spelled
    // `-X POST`, `--method POST`, `--method=POST` or, as pflag allows, `-XPOST`
    // — reading only the separated forms classified `-XPOST .../merge` as a
    // read, which is the one thing this classifier must never do. The fields
    // that make a POST are spelled `-f`, `-fbody=x`, `--field=x` too: any of
    // them can carry the body, and only the bare-flag forms were read before.
    const method = methodFlag(args);
    if ((method === undefined || method.toUpperCase() === "GET") && !hasMutatingField(args)) {
      return { safety: "safe" };
    }
    return { safety: "unknown", reason: "gh api with a mutating method has no supported reconciliation" };
  }

  if (group !== undefined && SAFE_GH_INVOCATIONS.has(`${group} ${sub ?? ""}`)) return { safety: "safe" };
  return { safety: "unknown", reason: `gh ${words.slice(0, 2).join(" ")} is not a proven read` };
}

/** `-f`, `-fbody=x`, `-F`, `--field`, `--field=x`, `--raw-field`, `--input`:
 *  every spelling that supplies a body to `gh api`. */
function hasMutatingField(args: string[]): boolean {
  return args.some((arg) => /^-[fF]/.test(arg) || /^--(field|raw-field|input)(=|$)/.test(arg));
}

/**
 * `gh api`'s method in every spelling gh accepts. A method this does not
 * recognise is never read as GET — `methodFlag` returning the raw value keeps
 * the caller's `=== "GET"` comparison the only way to reach safety.
 */
function methodFlag(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-X" || arg === "--method") return args[i + 1];
    if (arg.startsWith("--method=")) return arg.slice("--method=".length);
    if (arg.startsWith("-X") && arg.length > 2) return arg.slice(2).replace(/^=/, "");
  }
  return undefined;
}

/** The issue/PR number of a `gh issue|pr <write>` call: the first bare number. */
function issueNumberOf(args: string[]): number {
  return Number(skipFlags(args).find((arg) => /^\d+$/.test(arg)) ?? "");
}

/** The number and body of a comment call, or null when either is unreadable
 *  (an unreadable body makes the effect unreconcilable, never safe). */
function parseComment(args: string[]): { number: number; body: string } | null {
  const number = issueNumberOf(args);
  const body = commentBody(args);
  if (!Number.isInteger(number) || body === null) return null;
  return { number, body };
}

/** The ONE comment effect shape: its key digests the body, so a re-read of the
 *  conversation can prove whether that exact comment landed. */
function commentAction(target: "pr" | "issue", comment: { number: number; body: string }): EffectAction {
  return {
    kind: "comment",
    key: `comment:${target}:${comment.number}:${digest(comment.body)}`,
    detail: `comment on ${target === "pr" ? "PR" : "issue"} #${comment.number}`,
    target,
    number: comment.number,
    body: comment.body,
  };
}

function isSafeBinary(binary: string): boolean {
  return SAFE_COMMANDS.has(binary) || SAFE_COMMANDS.has(binary.replace(/[0-9]+$/, ""));
}

/** Does this operand name something outside the worktree — a path the
 *  classifier cannot resolve, so it is not safe by omission?
 *
 *  The rules are deliberately crude: an absolute path IS outside, `~` is the
 *  home dir only as a PREFIX (`HEAD~1` is git's own revision syntax), a `..`
 *  component climbs out, and a flag carrying a path (`-C/tmp`, `-C..`) hides
 *  where the path begins. A plain relative path (`src/x.ts`, `refs/heads/x`,
 *  `origin`) is the worktree. Shell expansions are refused once per segment
 *  ({@link scanShell}), where quoting is still visible.
 */
function namesOutsideWorktree(token: string): boolean {
  // `--flag=value` carries its value after the `=`; a bare `x=y` (a commit
  // message, say) is not a flag and its `=` says nothing about a path.
  const value = token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
  if (value === "") return false;
  // A short flag may carry the path glued to it: `-C/tmp`, `-C..`, `-o/tmp`.
  const path = /^-[A-Za-z]/.test(value) && !value.startsWith("--") ? value.slice(2) : value;
  if (path.startsWith("/") || path.startsWith("~")) return true;
  return path.split("/").includes("..");
}

function tokenize(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]!;
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < segment.length) {
        // Inside `""` bash drops the backslash only before a character it can
        // escape ($, backtick, ", \ and newline); before anything else the
        // backslash is LITERAL, so `"a\|b"` posts `a\|b`. Dropping it here made
        // the recorded body differ from the one the shell posts, and a recovery
        // then read the comment as absent and allowed a duplicate.
        const escaped = segment[i + 1]!;
        if (escaped === "\n") {
          // A backslash-newline inside `""` is a line continuation.
        } else if ('$`"\\'.includes(escaped)) {
          current += escaped;
        } else {
          current += `\\${escaped}`;
        }
        i += 1;
      } else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\\" && i + 1 < segment.length) {
      // Outside quotes a backslash escapes ANY character, and a backslash before
      // a newline is a line continuation: the newline is removed, not kept.
      const escaped = segment[i + 1]!;
      if (escaped !== "\n") current += escaped;
      i += 1;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") words.push(current);
  return words;
}

function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === flag) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/** The comment body from --body/--body-file, or null when it is not readable
 *  here (a heredoc/file makes the effect unreconcilable). */
function commentBody(args: string[]): string | null {
  const body = flagValue(args, "--body");
  if (body !== undefined) return body;
  const flags = args.find((arg) => arg.startsWith("--body="));
  if (flags !== undefined) return flags.slice("--body=".length);
  return null;
}

function skipFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("-")) {
      // A flag with a separate value: skip the value too, unless it is the
      // next flag (a boolean).
      if (!arg.includes("=") && args[i + 1] !== undefined && !args[i + 1]!.startsWith("-")) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** A short, stable digest of the body — the comment's identity in a key. */
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Resolve the facts the classifier cannot know (the current branch and commit
 * of the worktree). The guardrail calls this where the repository is; a
 * resolution failure keeps the action as it was and the host treats a
 * branch-less push/PR as unreconcilable.
 */
export function withObservedRef(
  action: EffectAction,
  observed: { branch: string | null; sha: string | null },
): EffectAction {
  if (action.kind !== "push" && action.kind !== "pr") return action;
  const branch = action.branch ?? observed.branch ?? undefined;
  if (branch === undefined) return action;
  if (action.kind === "push") {
    const sha = observed.sha ?? undefined;
    return {
      ...action,
      branch,
      key: sha === undefined ? `push:${branch}` : `push:${branch}@${sha}`,
      ...(sha === undefined ? {} : { sha }),
    };
  }
  return { ...action, branch, key: `pr:${branch}` };
}
