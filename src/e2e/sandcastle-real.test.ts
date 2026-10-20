import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, describe } from "node:test";

import { readOutcomeRecord } from "../state/outcome.js";
import { SandcastleRuntime } from "../runtime/sandcastle.js";
import { reviewReportPath } from "../runtime/prompt.js";
import { WORKER_IMAGE } from "../worker-image.js";
import type { WorkRequest } from "../runtime/port.js";

/**
 * The REAL proof (ticket 85): an explicitly enabled, credit-consuming run of
 * the full worker flow in a real container — real Pi, real profile (with the
 * operator's skills), real pi-subagents, real authenticated model — against a
 * DISPOSABLE local git repository. It walks the worker's own path: loading
 * /implement from the profile, implementing a small local spec, validating,
 * committing locally, running /code-review with TWO DISTINCT subagents, and
 * writing the Standards/Spec reports plus the outcome record.
 *
 * It is NOT part of the deterministic suite and never runs by default:
 *
 *   npm run proof:real
 *
 * which sets MSF_REAL_PROOF=1. An explicitly enabled run FAILS on missing
 * prerequisites (docker, worker image, model) — a skipped run proves nothing
 * (ticket 85: "a ausência de pré-requisitos não conta como aceitação").
 *
 * GitHub interactions are REPLACED, not performed: the disposable repo has no
 * remote, the spec forbids `gh` and pushes, no issue/PR is created — GitHub
 * behavior stays covered by the tracker adapter tests. The worker's token is
 * a placeholder: `gh` would fail, which is exactly the isolation wanted.
 *
 * Evidence is left on disk (the paths are printed): the work dir keeps the
 * round's starting SHA, the subagent executions (log-1.jsonl), the two axis
 * reports and desfecho.json.
 */

const ENABLED = process.env.MSF_REAL_PROOF === "1";
const MODEL = process.env.MSF_REAL_PROOF_MODEL ?? "";
const PROFILE_DIR = process.env.MSF_REAL_PROOF_PROFILE ?? join(homedir(), ".pi", "agent");
const ALLOWED_ROOTS = (process.env.MSF_REAL_PROOF_ALLOWED_ROOTS ?? "")
  .split(":")
  .map((root) => root.trim())
  .filter((root) => root !== "");
const IDLE_TIMEOUT_SECONDS = Number(process.env.MSF_REAL_PROOF_IDLE_TIMEOUT ?? 1800);
// The operator's real profile may carry stale links (e.g. a removed extension);
// the proof may skip them the way msf.yaml's profile-skip-dangling-links does —
// fail-closed remains the production default.
const SKIP_DANGLING_LINKS = process.env.MSF_REAL_PROOF_SKIP_DANGLING_LINKS === "1";

const SKIP_REASON =
  "the real proof is opt-in and credit-consuming: run `npm run proof:real` (sets MSF_REAL_PROOF=1)";

function failIfMissingPrerequisite(missing: string): void {
  throw new Error(`real proof explicitly enabled but a prerequisite is missing: ${missing}`);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function dockerInfo(): string {
  return execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).trim();
}

/** Are we inside a container? Docker and Podman leave their marker: the proof's
 *  temp root is then NOT the host's, and its nested worker cannot see it. */
function insideContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

/** The disposable local repo: a tiny node project with one proven pattern
 * (`sum`) the spec extends. No remote — pushes are impossible by construction. */
function makeDisposableRepo(root: string): { repoDir: string; baseBranch: string; branch: string; roundStartSha: string } {
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(
    join(repoDir, "package.json"),
    JSON.stringify({ name: "descartavel", private: true, scripts: { test: "node --test" } }, null, 2),
    "utf8",
  );
  writeFileSync(join(repoDir, "sum.js"), "function sum(a, b) {\n  return a + b;\n}\n\nmodule.exports = { sum };\n", "utf8");
  writeFileSync(
    join(repoDir, "sum.test.js"),
    'const { test } = require("node:test");\nconst assert = require("node:assert/strict");\nconst { sum } = require("./sum.js");\n\ntest("2 + 3 = 5", () => {\n  assert.equal(sum(2, 3), 5);\n});\n',
    "utf8",
  );
  git(repoDir, "init", "--initial-branch", "main");
  git(repoDir, "config", "user.email", "prova@msf.local");
  git(repoDir, "config", "user.name", "msf real proof");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "seed: the disposable repo");
  return { repoDir, baseBranch: "main", branch: "agent-real-proof", roundStartSha: git(repoDir, "rev-parse", "HEAD") };
}

const SPEC_BODY = `# Prova real (container isolado) — ticket 85

Esta é uma execução de PROVA em um repositório descartável e LOCAL. Não há GitHub: o
repositório não tem remote.

## Regras de isolamento (obrigatórias)

- NÃO execute \`gh\` e NÃO faça \`git push\` — não há remote; nenhuma operação GitHub deve ocorrer.
- NÃO abra PR. Ao terminar, escreva o desfecho.json com "class": "clean-without-pr".

## A especificação (local, explícita)

No repositório (seu cwd):

1. Adicione \`calc.js\` exportando \`multiply(a, b)\`, no mesmo estilo do \`sum.js\` existente.
2. Adicione \`calc.test.js\` com testes node:test para \`multiply\`: 2*3=6 e (-1)*5=-5.
3. Rode \`npm test\` — deve passar.

Siga o procedimento de implementação do seu prompt (as skills do seu perfil), terminando
com a revisão de dois eixos e os relatórios gravados no work dir.`;

describe("e2e: the REAL proof of the implement–review flow (ticket 85)", { skip: ENABLED ? false : SKIP_REASON }, () => {
  test("a real container loads /implement, implements a local spec, commits locally and runs /code-review with two subagents", { timeout: 4 * 60 * 60 * 1000 }, async () => {
    if (MODEL === "") failIfMissingPrerequisite("MSF_REAL_PROOF_MODEL is unset — pass the model the worker session uses, e.g. MSF_REAL_PROOF_MODEL=provider/model-id");
    if (insideContainer()) {
      failIfMissingPrerequisite(
        "the real proof runs on the operator's machine, not inside a worker container: its disposable repo and work dir live under the test's temp dir, which a worker does not share with the host, so the nested worker's binds would resolve on the host to empty directories (ADR 0003)",
      );
    }
    if (!existsSync(PROFILE_DIR)) failIfMissingPrerequisite(`the profile dir does not exist: ${PROFILE_DIR}`);
    try {
      dockerInfo();
    } catch {
      failIfMissingPrerequisite("docker is unavailable (docker info failed)");
    }
    try {
      execFileSync("docker", ["image", "inspect", WORKER_IMAGE], { stdio: "ignore" });
    } catch {
      failIfMissingPrerequisite(`worker image ${WORKER_IMAGE} is missing — build it with \`npm run build:image\``);
    }

    // The disposable repo and work dir stay on disk after the run: the
    // evidence (SHA, subagent executions, reports) outlives the test.
    const root = mkdtempSync(join(tmpdir(), "msf-prova-real-"));
    const { repoDir, baseBranch, branch, roundStartSha } = makeDisposableRepo(root);
    const workDir = join(root, "trabalho");
    mkdirSync(workDir, { recursive: true });

    const request: WorkRequest = {
      ref: { repo: "Sanmoo/descartavel", number: 85 },
      workDir,
      branch,
      repoDir,
      baseBranch,
      attempt: 1,
      material: { issue: { title: "Prova real do fluxo implement–review", body: SPEC_BODY }, diff: "" },
    };

    const runtime = new SandcastleRuntime({
      model: MODEL,
      // A placeholder: the isolated repo has no remote and the spec forbids
      // gh — no real GitHub credential rides this proof (story 23).
      token: "msf-real-proof-no-github",
      profileDir: PROFILE_DIR,
      allowedRoots: ALLOWED_ROOTS,
      skipDanglingProfileLinks: SKIP_DANGLING_LINKS,
      workspace: join(root, "fabrica"),
      idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    });

    const result = await runtime.launch(request);

    // 1. The session ran and declared its end (no abrupt death to hide behind).
    assert.equal(result.outcome, "clean-without-pr", `the session must end clean-without-pr — got ${result.outcome}`);

    // 2. Local commits exist beyond the round's pinned SHA — and nothing was pushed (no remote exists).
    git(repoDir, "cat-file", "-e", `${roundStartSha}^{commit}`);
    const commits = git(repoDir, "log", "--oneline", `${roundStartSha}..${branch}`);
    assert.ok(commits.length > 0, "the round produced local commits on the work branch");

    // 3. TWO DISTINCT subagent executions are in the session log (story 11):
    //    the /code-review axes ran as separate subagent tool calls. The raw
    //    stream embeds the tool events as escaped JSON — parse one level in.
    const logLines = existsSync(join(workDir, "log-1.jsonl"))
      ? readFileSync(join(workDir, "log-1.jsonl"), "utf8").split("\n").filter((line) => line !== "")
      : [];
    const subagentCalls = logLines.filter((line) => {
      if (!line.includes("agent-raw") || !line.includes("tool_execution_start")) return false;
      try {
        const outer = JSON.parse(line) as { line?: string };
        const inner = JSON.parse(outer.line ?? "") as { type?: string; toolName?: string };
        return inner.type === "tool_execution_start" && inner.toolName === "subagent";
      } catch {
        return false;
      }
    });
    assert.ok(
      subagentCalls.length >= 2,
      `expected at least two subagent tool calls (Standards + Spec), found ${subagentCalls.length}`,
    );

    // 4. Both axis reports exist on disk, distinct and non-empty (story 19).
    const standardsReport = join(workDir, reviewReportPath(1, "standards"));
    const specReport = join(workDir, reviewReportPath(1, "spec"));
    assert.ok(existsSync(standardsReport), `the Standards report is missing: ${standardsReport}`);
    assert.ok(existsSync(specReport), `the Spec report is missing: ${specReport}`);
    assert.ok(readFileSync(standardsReport, "utf8").trim().length > 0, "the Standards report is empty");
    assert.ok(readFileSync(specReport, "utf8").trim().length > 0, "the Spec report is empty");

    // 5. The outcome record references the reports in "paths" (story 20).
    const record = await readOutcomeRecord(workDir);
    assert.ok(record, "the outcome record exists");
    const paths = (record as { paths?: Record<string, string> }).paths ?? {};
    const pathValues = Object.values(paths).join("\n");
    assert.match(pathValues, /standards/, "the record's paths reference the Standards report");
    assert.match(pathValues, /spec/, "the record's paths reference the Spec report");

    // 6. The evidence summary rides the work dir (the ticket's kept proof).
    const evidence = {
      roundStartSha,
      branch,
      commitsAfterRoundStart: git(repoDir, "log", "--format=%H", `${roundStartSha}..${branch}`).split("\n"),
      subagentToolCalls: subagentCalls.length,
      reports: { standards: reviewReportPath(1, "standards"), spec: reviewReportPath(1, "spec") },
      outcome: result.outcome,
    };
    writeFileSync(join(workDir, "evidencia.json"), JSON.stringify(evidence, null, 2), "utf8");
    console.log(`\n[real proof] evidence dir kept on disk: ${workDir}`);
    console.log(`[real proof] repo: ${repoDir}`);
    console.log(`[real proof] ${JSON.stringify(evidence, null, 2)}`);
  });
});
