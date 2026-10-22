/**
 * The external effects a worker session can produce (issue 119) — the shared
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
 * instead of being replayed (issue 119: the safe delivery of an unresolvable
 * mutation is a pause, not a repetition).
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

/** Commands whose whole effect stays local to the worktree or the process. */
const SAFE_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "echo", "printf",
  "pwd", "true", "false", "test", "[", "stat", "file", "du", "df", "which", "type",
  "sleep", "date", "basename", "dirname", "realpath", "readlink", "mkdir", "cp",
  "mv", "rm", "touch", "chmod", "chown", "ln", "diff", "tree", "column", "tee",
  "xargs", "seq", "yes", "env", "printenv", "id", "whoami", "uname", "nproc",
  "rg", "grep", "egrep", "fgrep", "find", "fd", "sed", "awk", "jq", "yq",
  "node", "npm", "yarn", "pnpm", "bun", "deno", "tsc", "eslint", "prettier",
  "vitest", "jest", "pytest", "python", "python3", "pip", "pip3", "go", "cargo",
  "rustc", "make", "cmake", "mise", "git", "patch", "tar",
  "unzip", "zip", "gzip", "gunzip", "base64", "sha256sum", "md5sum", "openssl",
]);

/**
 * Docker is NOT on the allowlist on purpose: the worker inherits the HOST's
 * daemon (ADR 0003), so `docker run/build compose` can mutate or publish
 * outside the worktree with no reconciliation to consult. An interrupted
 * docker call pauses the recovery instead of being replayed.
 */

/** The safe subcommands of the binaries whose other subcommands reach outside. */
const SAFE_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set([
    "add", "commit", "status", "diff", "log", "show", "branch", "checkout",
    "switch", "restore", "reset", "stash", "rebase", "merge", "cherry-pick",
    "revert", "rev-parse", "rev-list", "cat-file", "config", "fetch", "pull",
    "remote", "tag", "worktree", "ls-files", "ls-tree", "blame", "describe",
    "show-ref", "for-each-ref", "gc", "prune", "clean", "mv", "rm", "apply",
    "init", "clone", "submodule", "notes", "shortlog", "whatchanged", "reflog",
    "symbolic-ref", "update-ref", "check-ignore", "check-attr", "hash-object",
    "count-objects", "fsck", "format-patch", "am", "bisect", "grep",
  ]),
  npm: new Set([
    "install", "ci", "test", "run", "run-script", "exec", "ls", "list", "view",
    "outdated", "audit", "fund", "help", "cache", "init", "update", "restart",
    "start", "stop", "pack", "link", "why", "config", "pkg", "dedupe", "prune",
  ]),
  yarn: new Set(["install", "test", "run", "add", "remove", "why", "info", "build", "start"]),
  pnpm: new Set(["install", "test", "run", "add", "remove", "why", "list", "build", "start"]),
  bun: new Set(["install", "test", "run", "add", "remove", "build", "start", "x"]),
  deno: new Set(["test", "run", "check", "fmt", "lint", "task"]),
  cargo: new Set(["build", "test", "check", "fmt", "clippy", "run", "doc", "bench", "metadata", "tree", "update", "add", "remove", "clean"]),
  go: new Set(["build", "test", "vet", "fmt", "run", "mod", "list", "env", "generate", "doc", "clean", "work"]),
  pip: new Set(["install", "list", "show", "freeze", "download"]),
  pip3: new Set(["install", "list", "show", "freeze", "download"]),
  gh: new Set([
    "pr view", "pr list", "pr diff", "pr checks", "pr status",
    "issue view", "issue list", "issue status",
    "api", "auth", "repo view", "repo list", "search", "run view", "run list",
    "workflow view", "workflow list", "release view", "release list",
  ]),
};

/** Subcommands we must never call safe even under an allowlisted binary. */
const NEVER_SAFE: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["publish", "unpublish", "deprecate", "owner", "token", "login", "logout", "adduser"]),
  yarn: new Set(["publish", "login", "logout", "npm"]),
  pnpm: new Set(["publish", "login", "logout"]),
  cargo: new Set(["publish", "login", "owner", "yank"]),
  go: new Set(["install"]),
  gh: new Set(["release create", "release edit", "release delete", "repo create", "repo delete", "repo edit", "gist"]),
};

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
  if (/[`]|\$\(/.test(trimmed)) {
    return { safety: "unknown", reason: "command substitution can hide any effect" };
  }
  if (trimmed.includes("|")) {
    return { safety: "unknown", reason: "a pipeline hides the right side's effect" };
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

function splitSegments(command: string): string[] {
  // Newlines and `;` separate commands; `&&`/`||` are only separators when the
  // segments around them are independent commands. A redirection (`>`, `>>`)
  // is local-safe only for the allowlist — the segment classifier sees it.
  const segments: string[] = [];
  let current = "";
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (char === ";" || char === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    if ((char === "&" && command[i + 1] === "&") || (char === "|" && command[i + 1] === "|")) {
      segments.push(current);
      current = "";
      i += 1;
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

  // Environment assignments and harmless prefixes before the real command.
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
  while (index < words.length && ["sudo", "time", "command", "builtin", "nohup", "env"].includes(words[index]!)) {
    index += 1;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
  }
  if (index >= words.length) return { safety: "safe" };

  const command = words[index]!;
  const args = words.slice(index + 1);
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

  const subcommand = args[0]?.toLowerCase() ?? "";
  const safeSubcommands = SAFE_SUBCOMMANDS[binary];
  if (safeSubcommands !== undefined) {
    if (NEVER_SAFE[binary]?.has(subcommand) === true) {
      return { safety: "unknown", reason: `${binary} ${subcommand} publishes or authenticates` };
    }
    if (subcommand === "" || safeSubcommands.has(subcommand)) return { safety: "safe" };
    return { safety: "unknown", reason: `${binary} ${subcommand} is not a proven-local subcommand` };
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
  if (SAFE_SUBCOMMANDS.git?.has(subcommand) === true) return { safety: "safe" };
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
  // LOCAL:REMOTE (and +LOCAL:REMOTE for a force).
  const refspec = positional.length >= 2 ? (positional[1] ?? "HEAD") : (positional[0] ?? "HEAD");
  const [rawLocal, rawRemote] = refspec.replace(/^\+/, "").split(":");
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
  const rest = skipFlags(args);

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
      const number = Number(rest.find((arg) => /^\d+$/.test(arg)) ?? "");
      const body = commentBody(args);
      if (!Number.isInteger(number) || body === null) {
        return { safety: "unknown", reason: "a PR comment without its number and body cannot be reconciled" };
      }
      return {
        safety: "effect",
        actions: [
          {
            kind: "comment",
            key: `comment:pr:${number}:${digest(body)}`,
            detail: `comment on PR #${number}`,
            target: "pr",
            number,
            body,
          },
        ],
      };
    }
    if (sub === "merge" || sub === "close" || sub === "edit" || sub === "ready" || sub === "reopen") {
      return { safety: "unknown", reason: `gh pr ${sub} has no supported reconciliation` };
    }
  }

  if (group === "issue") {
    if (sub === "comment") {
      const number = Number(rest.find((arg) => /^\d+$/.test(arg)) ?? "");
      const body = commentBody(args);
      if (!Number.isInteger(number) || body === null) {
        return { safety: "unknown", reason: "an issue comment without its number and body cannot be reconciled" };
      }
      return {
        safety: "effect",
        actions: [
          {
            kind: "comment",
            key: `comment:issue:${number}:${digest(body)}`,
            detail: `comment on issue #${number}`,
            target: "issue",
            number,
            body,
          },
        ],
      };
    }
    if (sub === "edit") {
      const number = Number(rest.find((arg) => /^\d+$/.test(arg)) ?? "");
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
    // gh api without a mutating method is a read.
    const method = flagValue(args, "--method") ?? flagValue(args, "-X");
    const mutatingFields = args.some((arg) => ["-f", "-F", "--field", "--raw-field", "--input"].includes(arg));
    if (method === undefined || method.toUpperCase() === "GET") {
      if (!mutatingFields) return { safety: "safe" };
    }
    return { safety: "unknown", reason: "gh api with a mutating method has no supported reconciliation" };
  }

  const readOnly = SAFE_SUBCOMMANDS.gh;
  if (group !== undefined && readOnly?.has(`${group} ${sub ?? ""}`)) return { safety: "safe" };
  if (group === "auth" || group === "search") return { safety: "safe" };
  if (group === "run" || group === "workflow" || group === "release" || group === "repo") {
    if (sub === "view" || sub === "list") return { safety: "safe" };
  }
  return { safety: "unknown", reason: `gh ${words.slice(0, 2).join(" ")} is not a proven read` };
}

function isSafeBinary(binary: string): boolean {
  return SAFE_COMMANDS.has(binary) || SAFE_COMMANDS.has(binary.replace(/[0-9]+$/, ""));
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
        current += segment[i + 1];
        i += 1;
      } else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\\" && i + 1 < segment.length) {
      current += segment[i + 1];
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
