import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sandcastleBoundary } from "../src/runtime/docker-sandcastle.js";

// O preflight real do boundary do sandbox: Docker alcançável, imagem presente e o token da CONTA
// NOMEADA do projeto. Como o boundary do tracker (src/tracker/github.ts), `gh auth token --user
// ACCOUNT` roda com `GH_TOKEN`/`GITHUB_TOKEN` removidos do ambiente: a conta nomeada é a fonte
// única, sem fallback para a credencial ambiente nem para outra conta (ticket #76). Os testes
// falsificam os dois CLIs no PATH — nenhum Docker nem GitHub de verdade é tocado.

const fakeDocker = `#!/bin/sh
echo "argv: $*" >> "$MSF_FAKE_DOCKER_LOG"
case "$1" in
  info) printf '29.7.2\\n' ;;
  image) printf '[]\\n' ;;
  *) exit 2 ;;
esac
`;

// Registra o argv e a presença das duas variáveis de credencial no ambiente da chamada (nunca o
// valor de um token real) e responde por conta: com token, sem token (falha) ou token vazio.
const fakeGh = `#!/bin/sh
log="$MSF_FAKE_GH_LOG"
echo "argv: $*" >> "$log"
if [ -n "\${GH_TOKEN:-}" ]; then echo "GH_TOKEN: set to $GH_TOKEN" >> "$log"; else echo "GH_TOKEN: unset" >> "$log"; fi
if [ -n "\${GITHUB_TOKEN:-}" ]; then echo "GITHUB_TOKEN: set" >> "$log"; else echo "GITHUB_TOKEN: unset" >> "$log"; fi
case "$1" in
  auth)
    if [ "$4" = "$MSF_FAKE_GH_WITHOUT_TOKEN" ]; then
      echo "no oauth token for account $4" >&2
      exit 1
    fi
    if [ "$4" = "$MSF_FAKE_GH_EMPTY_TOKEN" ]; then
      printf '\\n'
      exit 0
    fi
    echo "fake-token-for-$4"
    ;;
  *) exit 2 ;;
esac
`;

interface FakePaths {
  ghLog: string;
  dockerLog: string;
}

async function withFakeClis(run: (paths: FakePaths) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "msf-fake-clis-"));
  const paths: FakePaths = { ghLog: join(dir, "gh.log"), dockerLog: join(dir, "docker.log") };
  const gh = join(dir, "gh");
  const docker = join(dir, "docker");
  await writeFile(gh, fakeGh);
  await writeFile(docker, fakeDocker);
  await chmod(gh, 0o755);
  await chmod(docker, 0o755);
  const names = [
    "PATH", "GH_TOKEN", "GITHUB_TOKEN",
    "MSF_FAKE_GH_WITHOUT_TOKEN", "MSF_FAKE_GH_EMPTY_TOKEN", "MSF_FAKE_GH_LOG", "MSF_FAKE_DOCKER_LOG",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const name of names) saved[name] = process.env[name];
  // The ambient credential exists and MUST NOT reach the token read: the named account is the
  // single source. The fakes answer first on the PATH.
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  process.env.GH_TOKEN = "ambient-token-must-not-reach-the-token-read";
  delete process.env.GITHUB_TOKEN;
  process.env.MSF_FAKE_GH_WITHOUT_TOKEN = "conta-sem-token";
  process.env.MSF_FAKE_GH_EMPTY_TOKEN = "conta-sem-valor";
  process.env.MSF_FAKE_GH_LOG = paths.ghLog;
  process.env.MSF_FAKE_DOCKER_LOG = paths.dockerLog;
  try {
    await run(paths);
  } finally {
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const preflightOf = () => sandcastleBoundary().preflight({ image: "msf-docker-runner:local", account: "Sanmoo" });

test("o preflight cunha o token da conta nomeada com GH_TOKEN/GITHUB_TOKEN fora do ambiente da chamada", async () => {
  await withFakeClis(async ({ ghLog }) => {
    const mint = await preflightOf();
    assert.deepEqual(mint, { token: "fake-token-for-Sanmoo" });
    assert.notEqual(mint.token, process.env.GH_TOKEN, "o token ambiente nunca é o da conta do projeto");
    const lines = (await readFile(ghLog, "utf8")).trim().split("\n");
    assert.equal(lines[0], "argv: auth token --user Sanmoo");
    assert.equal(lines[1], "GH_TOKEN: unset");
    assert.equal(lines[2], "GITHUB_TOKEN: unset");
  });
});

test("conta sem token recusa nomeando a conta e a ausência de fallback para outra conta", async () => {
  await withFakeClis(async ({ ghLog }) => {
    await assert.rejects(
      () => sandcastleBoundary().preflight({ image: "msf-docker-runner:local", account: "conta-sem-token" }),
      (error: Error) => /conta-sem-token/.test(error.message) && /no fallback to another account/.test(error.message),
    );
    // O motivo nomeia a conta e o CLI foi perguntado por ela (nunca pela credencial ambiente).
    const logged = await readFile(ghLog, "utf8");
    assert.match(logged, /argv: auth token --user conta-sem-token\nGH_TOKEN: unset/);
  });
});

test("token vazio também recusa nomeando a conta", async () => {
  await withFakeClis(async () => {
    await assert.rejects(
      () => sandcastleBoundary().preflight({ image: "msf-docker-runner:local", account: "conta-sem-valor" }),
      /empty token for account conta-sem-valor/,
    );
  });
});
