import { lstat } from "node:fs/promises";
import { join } from "node:path";

// Where the configuration files of one base directory are (ticket #72). Two roles live side by
// side and keep their separation: `config` is the shareable configuration and `local` is this
// machine's part of it. Each one is a single YAML file — `config.yaml` or `config.yml`,
// `local.yaml` or `local.yml` — and the extension choice is independent between them.
//
// The JSON files of the previous format are not read at all: their presence is a migration
// error, also when the YAML file already exists, because ignoring them silently would leave the
// operator editing a file the factory no longer reads.

export type ConfigRole = "config" | "local";

const YAML_EXTENSIONS = [".yaml", ".yml"] as const;

export type Discovery =
  | { ok: true; path: string }
  | { ok: false; message: string };

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

const migrationHint = (homeDir: string): string => `npm run config:migrate -- --home ${homeDir}`;

async function discover(homeDir: string, role: ConfigRole): Promise<Discovery> {
  const legacy = join(homeDir, `${role}.json`);
  if (await exists(legacy)) {
    return {
      ok: false,
      message: `${legacy} existe: o formato JSON não é mais aceito para ${role}; `
        + `converta com \`${migrationHint(homeDir)}\` (o original é preservado como ${role}.json.bak)`,
    };
  }
  const candidates = YAML_EXTENSIONS.map((extension) => join(homeDir, `${role}${extension}`));
  const found: string[] = [];
  for (const candidate of candidates) if (await exists(candidate)) found.push(candidate);
  if (found.length > 1) {
    return {
      ok: false,
      message: `mais de um arquivo de ${role} em ${homeDir}: ${found.join(" e ")}; mantenha apenas um`,
    };
  }
  if (found.length === 1) return { ok: true, path: found[0]! };
  return {
    ok: false,
    message: `${role}.yaml (ou ${role}.yml) não encontrado em ${homeDir}: procurei ${candidates.join(" e ")} `
      + "(use --home para indicar outro diretório base)",
  };
}

// The shareable configuration every command needs.
export const discoverConfigFile = (homeDir: string): Promise<Discovery> => discover(homeDir, "config");

// The machine's part: only the commands that need it look for it (`run`, `assist`).
export const discoverLocalFile = (homeDir: string): Promise<Discovery> => discover(homeDir, "local");
