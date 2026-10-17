import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runConfigMigration } from "../src/cli/migrate.js";

// Entry point of `npm run config:migrate -- --home DIR` (ticket #72). The work itself lives in
// src/cli/migrate.ts, next to the validators and the parser it uses; this file only resolves the
// repository root and passes the exit code on.
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = await runConfigMigration(process.argv.slice(2), REPOSITORY_ROOT);
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exit(run.exitCode);
}
