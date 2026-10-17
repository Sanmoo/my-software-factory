import { chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { messageOf } from "../core/values.js";
import type { CliRun } from "./instance.js";
import { parseLocalSettings } from "./local-settings.js";
import { parseConfig } from "../config/validate.js";
import { parseYamlDocument, sameData, stringifyYaml } from "../config/yaml.js";

// `npm run config:migrate -- --home DIR` (ticket #72): the operator's one command to turn the
// old `config.json` and `local.json` into `config.yaml` and `local.yaml`. The migration is
// explicit, never automatic, and never rewrites what it should not:
//
//  - every file involved is read and validated before anything is written;
//  - nothing is overwritten: an existing YAML destination (`.yaml` or `.yml`) or backup refuses
//    the migration, and a symlink is not followed;
//  - the produced YAML is parsed back and compared with the JSON data, so the meaning is kept;
//  - the originals stay as `config.json.bak` / `local.json.bak`, so the old names no longer
//    block startup;
//  - values are never printed. Failures name the files and the reason, not the content.
//
// Two files are involved and the filesystem gives no transaction across them: the message after
// a failure says what remains where, without promising that both roles moved together.

export const DEFAULT_MIGRATION_HOME = ".msf";
const USAGE = `uso: npm run config:migrate -- [--home DIR]
--home DIR: diretório base com config.json e local.json (padrão: ${DEFAULT_MIGRATION_HOME}/ na raiz do repositório; um caminho relativo parte da raiz).`;

type ConfigJson = "config" | "local";
const ROLES: readonly ConfigJson[] = ["config", "local"];

interface Plan {
  role: ConfigJson;
  source: string;
  destination: string;
  backup: string;
  document: string;
}

// The filesystem operations of the commit, behind a seam: a test must be able to fail one of
// them and see what the operator would see. The default is the real filesystem.
export interface MigrationFs {
  writeRestricted(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultFs: MigrationFs = {
  // `wx` refuses a file that appeared since the checks; the permissions are restrictive from the
  // creation, and forced again because the umask may widen them.
  async writeRestricted(path, text) {
    await writeFile(path, text, { flag: "wx", mode: 0o600 });
    await chmod(path, 0o600);
  },
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
};

const fail = (message: string): CliRun => ({ exitCode: 1, stdout: "", stderr: `${message}\n` });
const usageError = (message: string): CliRun => ({ exitCode: 2, stdout: "", stderr: `${message}\n${USAGE}\n` });

type Inspection = "absent" | "symlink" | "present";
const inspect = (path: string): Promise<Inspection> =>
  lstat(path).then((stats) => (stats.isSymbolicLink() ? "symlink" : "present"), (): Inspection => "absent");

type ParsedArgs = { home: string | undefined } | { error: CliRun } | "help";

function parseArgs(argv: readonly string[]): ParsedArgs {
  let home: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--help" || token === "-h") return "help";
    if (token !== "--home") return { error: usageError(`argumento desconhecido: ${token}`) };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return { error: usageError("--home exige um valor") };
    home = value;
    index += 1;
  }
  return { home };
}

// What the configuration file must mean. The same validators the factory uses, so a file that
// would be refused at startup is refused here too — before anything is written.
function validate(role: ConfigJson, raw: unknown): string | undefined {
  if (role === "config") {
    const parsed = parseConfig(raw);
    return parsed.ok ? undefined : parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
  }
  const local = parseLocalSettings(raw);
  return typeof local === "string" ? local : undefined;
}

async function plan(role: ConfigJson, homeDir: string): Promise<Plan | "absent" | CliRun> {
  const source = join(homeDir, `${role}.json`);
  const sourceState = await inspect(source);
  if (sourceState === "absent") return "absent";
  if (sourceState === "symlink") return fail(`${source} é um link simbólico: a migração não segue links; nada foi modificado`);

  // Nothing may be overwritten: a YAML destination of either extension, or a backup, refuses the
  // whole migration. The operator resolves the conflict and runs the command again. A link in any
  // of these places is refused for the same reason: the migration writes where it says it writes.
  const destinations = [join(homeDir, `${role}.yaml`), join(homeDir, `${role}.yml`)];
  for (const destination of destinations) {
    const state = await inspect(destination);
    if (state === "symlink") return fail(`${destination} é um link simbólico: a migração não segue links; nada foi modificado`);
    if (state === "present") return fail(`destino YAML já existe: ${destination}; nada foi modificado`);
  }
  const backup = join(homeDir, `${role}.json.bak`);
  const backupState = await inspect(backup);
  if (backupState === "symlink") return fail(`${backup} é um link simbólico: a migração não segue links; nada foi modificado`);
  if (backupState === "present") return fail(`backup já existe: ${backup}; nada foi modificado`);

  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch {
    return fail(`${source} não pode ser lido; nada foi modificado`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(`${source} não é JSON válido; nada foi modificado`);
  }
  const invalid = validate(role, raw);
  if (invalid !== undefined) return fail(`${source} não passa nas validações atuais:\n${invalid}\nnada foi modificado`);

  // The produced document is read back with the same parser the factory uses and compared with
  // the JSON data: a serializer detail can never change the configuration's meaning.
  const document = stringifyYaml(raw);
  const reread = parseYamlDocument(document);
  if (!reread.ok) return fail(`o YAML gerado para ${source} não pôde ser lido de volta (${reread.message}); nada foi modificado`);
  if (!sameData(reread.value, raw)) {
    return fail(`o YAML gerado para ${source} não preserva exatamente os dados do JSON; nada foi modificado`);
  }
  return { role, source, destination: destinations[0]!, backup, document };
}

// Best effort, and honest about it: the files this run created are removed and the originals this
// run renamed come back. What could not be restored is reported with its path.
async function rollback(
  fs: MigrationFs,
  created: readonly string[],
  renamed: readonly Plan[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const plan of [...renamed].reverse()) {
    try {
      await fs.rename(plan.backup, plan.source);
    } catch {
      problems.push(`${plan.source} não foi restaurado; os dados originais estão em ${plan.backup}`);
    }
  }
  for (const path of created) {
    try {
      await fs.unlink(path);
    } catch {
      problems.push(`${path} foi criado e não pôde ser removido`);
    }
  }
  return problems;
}

export async function runConfigMigration(
  argv: readonly string[],
  root: string,
  overrides: Partial<MigrationFs> = {},
): Promise<CliRun> {
  const fs: MigrationFs = { ...defaultFs, ...overrides };
  const parsed = parseArgs(argv);
  if (parsed === "help") return { exitCode: 0, stdout: `${USAGE}\n`, stderr: "" };
  if ("error" in parsed) return parsed.error;
  const homeDir = parsed.home === undefined ? resolve(root, DEFAULT_MIGRATION_HOME) : resolve(root, parsed.home);

  const plans: Plan[] = [];
  for (const role of ROLES) {
    const planned = await plan(role, homeDir);
    if (planned === "absent") continue;
    if ("exitCode" in planned) return planned;
    plans.push(planned);
  }
  if (plans.length === 0) {
    return fail(`nenhum config.json ou local.json encontrado em ${homeDir}; nada foi modificado`);
  }

  const created: string[] = [];
  const renamed: Plan[] = [];
  try {
    for (const plan of plans) {
      await fs.writeRestricted(plan.destination, plan.document);
      created.push(plan.destination);
    }
    for (const plan of plans) {
      await fs.rename(plan.source, plan.backup);
      renamed.push(plan);
    }
  } catch (error) {
    const problems = await rollback(fs, created, renamed);
    return fail([
      `migração interrompida em ${homeDir}: ${messageOf(error)}`,
      "os arquivos .json originais não foram apagados",
      "a migração não é atômica entre config e local: confira o diretório antes de iniciar a factory",
      ...(problems.length === 0 ? ["o que esta execução criou foi revertido"] : [
        "reversão incompleta:", ...problems.map((problem) => `  ${problem}`),
      ]),
    ].join("\n"));
  }

  return {
    exitCode: 0,
    stdout: [
      ...plans.map((plan) => `${plan.role}: ${plan.source} → ${plan.destination} (original preservado como ${plan.backup})`),
      "confira os arquivos antes de iniciar a factory; o backup pode ser restaurado renomeando-o de volta para .json",
    ].join("\n") + "\n",
    stderr: "",
  };
}
