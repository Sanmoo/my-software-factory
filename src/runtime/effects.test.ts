import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { classifyCommand, withObservedRef, type EffectAction } from "./effects.js";

/**
 * The classifier that both the host reconciliation and the in-container
 * guardrail share (issue 119). The contract tested here is the one that keeps
 * a recovery safe: only the four supported effects are recognised, everything
 * else is either provably local ("safe") or unknown — never safe by omission.
 */

function effectActions(command: string): EffectAction[] {
  const result = classifyCommand(command);
  assert.equal(result.safety, "effect", `expected an effect for: ${command}`);
  return result.safety === "effect" ? result.actions : [];
}

describe("the external-effect classifier (issue 119)", () => {
  test("provably local commands are safe", () => {
    for (const command of [
      "ls -la",
      "rg -n continuity src",
      "git status",
      "git diff --stat",
      "git add -A && git commit -m 'work'",
      "git fetch origin",
      "mkdir -p dist && cp a b",
      "jq -r .name package.json",
      "gh pr view 12",
      "git status || true",
      "gh api repos/o/r/pulls/12",
      "gh api -X GET repos/o/r/pulls/12",
      "tar -xzf pkg.tgz",
      "cp a b && rm -rf dist",
      // A path-carrying operand that stays in the worktree keeps the call safe.
      "sort -o out f",
      "tar -xzf a.tar -C dist",
      "git show refs/heads/agent-issue-7",
      // Git's own revision syntax is not a home reference: `~` is the home dir
      // only as a PREFIX. Refusing `HEAD~1` paused legitimate recoveries.
      "git diff HEAD~1",
      "git show HEAD~2:src/x.ts",
      "git reset --hard HEAD~1",
      "git log HEAD~3..HEAD",
      "git tag v1~2",
      // Inside single quotes the shell expands nothing, so this is literal text.
      "git commit -m 'fix $PATH note'",
    ]) {
      assert.equal(classifyCommand(command).safety, "safe", command);
    }
  });

  test("git push is a push effect, with the branch when the refspec names one", () => {
    const [head] = effectActions("git push -u origin HEAD");
    assert.equal(head?.kind, "push");
    assert.equal(head?.branch, undefined);

    // One positional is the REMOTE, whatever it happens to be called: the
    // branch stays unresolved for the guardrail to read from the worktree.
    // Recording `origin` as a branch made every such push unreconcilable.
    const [bareRemote] = effectActions("git push origin");
    assert.equal(bareRemote?.branch, undefined);
    assert.equal(bareRemote?.key, "push:<current>");

    const [named] = effectActions("git push origin agent-issue-7");
    assert.equal(named?.branch, "agent-issue-7");
    assert.equal(named?.key, "push:agent-issue-7");

    const [forced] = effectActions("git push --force-with-lease=agent-issue-7:abc origin HEAD:refs/heads/agent-issue-7");
    assert.equal(forced?.branch, "agent-issue-7");

    const [compound] = effectActions("git rebase origin/main && git push -u origin agent-issue-7");
    assert.equal(compound?.kind, "push");
  });

  test("a tag push and git send-email have no supported reconciliation", () => {
    assert.equal(classifyCommand("git push --tags").safety, "unknown");
    assert.equal(classifyCommand("git send-email --to a@b patch").safety, "unknown");
    assert.equal(classifyCommand("git request-pull main . HEAD").safety, "unknown");
  });

  test("gh pr create and gh pr comment become the effects the tracker can verify", () => {
    const [created] = effectActions("gh pr create --base main --head agent-issue-7 --title t --body b");
    assert.equal(created?.kind, "pr");
    assert.equal(created?.branch, "agent-issue-7");

    const [comment] = effectActions('gh pr comment 12 --body "addressed the feedback"');
    assert.equal(comment?.kind, "comment");
    assert.equal(comment?.target, "pr");
    assert.equal(comment?.number, 12);
    assert.equal(comment?.body, "addressed the feedback");
    assert.match(comment?.key ?? "", /^comment:pr:12:[0-9a-f]{16}$/);
  });

  test("gh issue comment and gh issue edit --add-label become comment/label effects", () => {
    const [comment] = effectActions('gh issue comment 7 --body "answering the human"');
    assert.equal(comment?.target, "issue");

    const [label] = effectActions("gh issue edit 7 --add-label agent-blocked");
    assert.equal(label?.kind, "label");
    assert.equal(label?.label, "agent-blocked");
    assert.equal(label?.key, "label:7:agent-blocked");
  });

  test("mutations with no supported reconciliation are unknown, never safe", () => {
    for (const command of [
      "gh pr merge 12 --squash",
      "gh pr close 12",
      "gh release create v1",
      "gh api -X POST repos/o/r/issues/1/comments -f body=hi",
      // `gh api`'s method in every spelling gh accepts: a combined short form
      // (`-XPOST`) is a mutation too, and reading only the separated form made
      // a merge look like a read.
      "gh api -XPOST repos/o/r/pulls/12/merge",
      "gh api -XDELETE repos/o/r/issues/1/labels/x",
      "gh api --method=DELETE repos/o/r/issues/1/labels/x",
      "gh api -XPUT repos/o/r/pulls/12/update-branch",
      // `gh api`'s BODY flags in every spelling: `-fbody=x`, `--field=x` and
      // `--input=p.json` all make a POST, and only the bare flags were read.
      "gh api --field=body=hi repos/o/r/issues/1/comments",
      "gh api -fbody=hi repos/o/r/issues/1/comments",
      "gh api --raw-field=body=hi repos/o/r/issues/1/comments",
      "gh api --input=p.json repos/o/r/issues/1/comments",
      // The allowlist names WHICH program runs, never WHERE it writes: every
      // spelling below passed the program check and reached the host.
      "sort -o /tmp/x f",
      "uniq in /tmp/out",
      "tar -C/tmp -xf a.tar",
      "patch -d/tmp -i p.diff",
      "tee $HOME/x",
      "git init /tmp/new",
      "git clone x /tmp/dest",
      "git apply --directory=/tmp",
      "git config --global user.name x",
      // A short flag can carry a `..` with no slash at all (`-C..`).
      "tar -C.. -xf a.tar",
      // A local writer is safe only inside the worktree: an absolute path
      // reaches the host, where nothing reconciles the effect.
      "cp a /tmp/b",
      "rm -rf ../escaped",
      "tar -xzf pkg.tgz -C /opt",
      "mkdir -p ~/.config/msf",
      "tee --output=/etc/x",
      "ln -s a /usr/local/bin/b",
      "gh issue edit 7 --remove-label agent-claimed",
      "gh pr comment 12 --body-file /tmp/body",
      'curl -X POST https://example.com -d x',
      "npm publish",
      // The daemon is the HOST's: a docker call can publish or mutate outside
      // the worktree, and no reconciliation covers it.
      "docker push image",
      "docker build -t x .",
      "docker run --rm -v /:/host x",
      "docker compose up -d",
      // Interpreters and command runners execute arbitrary code: a call of
      // this class is never proven local.
      "npm test",
      "npm run build",
      "node --test dist",
      "python3 deploy.py",
      "make release",
      "find . -name x -exec rm {} ;",
      "awk 'BEGIN{system(\"git push\")}'",
      "env python deploy.py",
      "xargs rm",
      // A redirection targets a path this classifier does not resolve.
      "echo done > /tmp/x",
      "printf x >> out.txt",
      "npm test 2>&1",
      // A wrapper runs another program; it is never a harmless prefix.
      "sudo git status",
      "sudo gh pr merge 12",
      "time git push origin x",
      'bash -c "git push"',
      "./script.sh",
    ]) {
      assert.equal(classifyCommand(command).safety, "unknown", command);
    }
  });

  test("a binary named like an object prototype member is unknown, never a throw", () => {
    // A lookup that fell through to Object.prototype once threw here, and the
    // throw escaped the guardrail's tool_call hook — a mutation no journal
    // recorded. The classifier must answer, not explode.
    for (const command of ["constructor --add x", "toString x", "hasOwnProperty --force", "__proto__ x"]) {
      assert.equal(classifyCommand(command).safety, "unknown", command);
    }
  });

  test("command, process substitution and pipelines hide any effect", () => {
    assert.equal(classifyCommand("echo $(git push)").safety, "unknown");
    assert.equal(classifyCommand("git push 2>&1 | tee log").safety, "unknown");
    // `<(…)`/`>(…)` run a command too, and its text is not this call's.
    assert.equal(classifyCommand("diff <(git push origin x) f").safety, "unknown");
    assert.equal(classifyCommand("diff >(x) f").safety, "unknown");
    // An expansion OUTSIDE single quotes names a value the classifier cannot
    // see, even when the program itself is on the safe list.
    assert.equal(classifyCommand('git commit -m "cost $5 "').safety, "unknown");
  });

  test("one unknown segment makes the whole compound command unknown", () => {
    assert.equal(classifyCommand("git commit -m x && curl https://example.com").safety, "unknown");
  });

  test("the observed ref completes the identity of push and PR effects", () => {
    const [push] = effectActions("git push -u origin HEAD");
    const observed = withObservedRef(push!, { branch: "agent-issue-7", sha: "abc123" });
    assert.equal(observed.key, "push:agent-issue-7@abc123");
    assert.equal(observed.branch, "agent-issue-7");
    assert.equal(observed.sha, "abc123");

    const [pr] = effectActions("gh pr create --title t --body b");
    const resolved = withObservedRef(pr!, { branch: "agent-issue-7", sha: "abc123" });
    assert.equal(resolved.key, "pr:agent-issue-7");
  });
});
