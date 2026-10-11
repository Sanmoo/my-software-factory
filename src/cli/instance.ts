import { loadConfigFile } from "../config/load.js";
import type { InstanceConfig, MsfConfig } from "../config/types.js";

// Shared by the CLI commands: every command is directed at one instance.
export interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type InstanceLoad =
  | { ok: true; config: MsfConfig; instance: InstanceConfig }
  | { ok: false; run: CliRun };

export async function loadInstance(configPath: string, instanceName: string): Promise<InstanceLoad> {
  const loaded = await loadConfigFile(configPath);
  if (!loaded.ok) {
    const details = loaded.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
    return { ok: false, run: { exitCode: 1, stdout: "", stderr: `configuração inválida:\n${details}\n` } };
  }
  const instance = loaded.config.instances.find((candidate) => candidate.name === instanceName);
  if (!instance) {
    const available = loaded.config.instances.map((candidate) => candidate.name).join(", ");
    return {
      ok: false,
      run: {
        exitCode: 2,
        stdout: "",
        stderr: `instância '${instanceName}' não encontrada; disponíveis: ${available}\n`,
      },
    };
  }
  return { ok: true, config: loaded.config, instance };
}
