import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringifyYaml } from "../../src/config/yaml.js";

// Tests write the same YAML files the operator writes (ticket #72), through the same serializer
// the migration uses: a fixture and a migrated file cannot drift apart.

export const writeConfigYaml = (home: string, config: unknown, extension = ".yaml"): Promise<void> =>
  writeFile(join(home, `config${extension}`), stringifyYaml(config));

export const writeLocalYaml = (home: string, local: unknown, extension = ".yaml"): Promise<void> =>
  writeFile(join(home, `local${extension}`), stringifyYaml(local));
