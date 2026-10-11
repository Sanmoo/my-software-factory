import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGhCliBoundary } from "../src/tracker/github.js";

// A fake `gh` executable that records its argv, whether GH_TOKEN was set in its env
// (never the value of a real token), and the stdin it received. It answers
// `auth token --user ACCOUNT` with a fake token and `api` with canned HTTP output.
const fakeGh = `#!/bin/sh
log="$MSF_FAKE_GH_LOG"
echo "argv: $*" >> "$log"
if [ -n "\${GH_TOKEN:-}" ]; then echo "GH_TOKEN: set to $GH_TOKEN" >> "$log"; else echo "GH_TOKEN: unset" >> "$log"; fi
if [ -n "\${GITHUB_TOKEN:-}" ]; then echo "GITHUB_TOKEN: set" >> "$log"; else echo "GITHUB_TOKEN: unset" >> "$log"; fi
case "$1" in
  auth)
    echo "fake-token-for-$4"
    ;;
  api)
    if [ "$*" = "$MSF_FAKE_GH_NOT_FOUND" ]; then
      printf 'HTTP/2.0 404 Not Found\\nContent-Type: application/json\\n\\n{"message":"Not Found"}'
      echo "gh: Not Found (HTTP 404)" >&2
      exit 1
    fi
    cat > "$MSF_FAKE_GH_STDIN"
    printf 'HTTP/2.0 200 OK\\nContent-Type: application/json\\n\\n[{"number":1}]'
    ;;
  *)
    exit 2
    ;;
esac
`;

async function withFakeGh(run: (paths: { command: string; log: string; stdin: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "msf-fake-gh-"));
  const command = join(dir, "gh");
  const paths = { command, log: join(dir, "log.txt"), stdin: join(dir, "stdin.txt") };
  await writeFile(command, fakeGh);
  await chmod(command, 0o755);
  const previous = { GH_TOKEN: process.env.GH_TOKEN, log: process.env.MSF_FAKE_GH_LOG, stdin: process.env.MSF_FAKE_GH_STDIN };
  process.env.GH_TOKEN = "ambient-token-must-not-reach-token-call";
  process.env.MSF_FAKE_GH_LOG = paths.log;
  process.env.MSF_FAKE_GH_STDIN = paths.stdin;
  try {
    await run(paths);
  } finally {
    if (previous.GH_TOKEN === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous.GH_TOKEN;
    if (previous.log === undefined) delete process.env.MSF_FAKE_GH_LOG; else process.env.MSF_FAKE_GH_LOG = previous.log;
    if (previous.stdin === undefined) delete process.env.MSF_FAKE_GH_STDIN; else process.env.MSF_FAKE_GH_STDIN = previous.stdin;
    await rm(dir, { recursive: true, force: true });
  }
}

test("the token of the named account is read with gh auth token and never from the ambient GH_TOKEN", async () => {
  await withFakeGh(async ({ command, log }) => {
    const boundary = createGhCliBoundary({ command });

    const token = await boundary.accountToken("Sanmoo");

    assert.equal(token, "fake-token-for-Sanmoo");
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    assert.equal(lines[0], "argv: auth token --user Sanmoo");
    assert.equal(lines[1], "GH_TOKEN: unset");
    assert.equal(lines[2], "GITHUB_TOKEN: unset");
  });
});

test("the project token is injected only into REST calls, and no account switch is ever run", async () => {
  await withFakeGh(async ({ command, log }) => {
    const boundary = createGhCliBoundary({ command });
    const token = await boundary.accountToken("Sanmoo");

    const response = await boundary.api({ method: "GET", path: "repos/Sanmoo/my-software-factory/issues/1" }, token);

    assert.deepEqual(response, { status: 200, body: [{ number: 1 }] });
    const text = await readFile(log, "utf8");
    assert.match(text, /argv: api --include --method GET repos\/Sanmoo\/my-software-factory\/issues\/1\nGH_TOKEN: set to fake-token-for-Sanmoo/);
    assert.doesNotMatch(text, /switch/);
  });
});

test("request bodies are sent as JSON on stdin", async () => {
  await withFakeGh(async ({ command, stdin }) => {
    const boundary = createGhCliBoundary({ command });

    await boundary.api({ method: "POST", path: "repos/o/r/issues/1/labels", body: { labels: ["agent-claimed"] } }, "t");

    assert.equal(await readFile(stdin, "utf8"), '{"labels":["agent-claimed"]}');
  });
});

test("an HTTP error is returned with its status instead of failing the call", async () => {
  await withFakeGh(async ({ command }) => {
    const boundary = createGhCliBoundary({ command });
    process.env.MSF_FAKE_GH_NOT_FOUND = "api --include --method GET repos/o/r/issues/99999";
    try {
      const response = await boundary.api({ method: "GET", path: "repos/o/r/issues/99999" }, "t");

      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: "Not Found" });
    } finally {
      delete process.env.MSF_FAKE_GH_NOT_FOUND;
    }
  });
});
