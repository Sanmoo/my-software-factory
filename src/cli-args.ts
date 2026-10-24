export interface CliArgs {
  command: "run" | "status" | "recover" | "retro";
  workKey?: string;
  retry?: string;
  reason?: string;
  acceptDuplicateRisk?: boolean;
  once: boolean;
  /** `msf status --all`: no caps. */
  all: boolean;
  configPath?: string;
  runtime?: string;
  /** `msf retro <work>`: the registry key (as `msf status` shows it) to analyze alone. */
  work?: string;
  /** `msf retro --language <tag>`: overrides `retro.language` for this round. */
  language?: string;
}

const usage =
  "usage: msf run [--once] [--config <path>] [--runtime <name>]\n" +
  "       msf status [--all] [--config <path>]\n" +
<<<<<<< HEAD
  "       msf recover <work-key> [--config <path>] [--retry <review> --accept-duplicate-risk --reason <text>]\n" +
  "       msf retro [<owner>/<name>#<number>] [--language <tag>] [--config <path>]";
=======
  "       msf retro [<work>] [--language <tag>] [--config <path>]";
>>>>>>> a361dd5 (fix(141): the rebase adaptation's review — any source in the window, an unverifiable window waits)

export function parseCliArgs(argv: string[]): CliArgs {
  const [command, ...args] = argv;
  if (command !== "run" && command !== "status" && command !== "recover" && command !== "retro") {
    throw new Error(usage);
  }
  if (command === "recover") return parseRecoveryArgs(args);
  let once = false;
  let all = false;
  let configPath: string | undefined;
  let runtime: string | undefined;
  let work: string | undefined;
  let language: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--once" && command === "run") {
      once = true;
      continue;
    }
    if (arg === "--all" && command === "status") {
      all = true;
      continue;
    }
    if (arg === "--config" || arg === "--runtime" || arg === "--language") {
      if (arg === "--runtime" && command !== "run") throw new Error(`unknown flag "${arg}"\n${usage}`);
      if (arg === "--language" && command !== "retro") throw new Error(`unknown flag "${arg}"\n${usage}`);
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`unknown flag "${arg}"\n${usage}`);
      if (arg === "--config") configPath = value;
      else if (arg === "--runtime") runtime = value;
      else language = value;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown flag "${arg}"\n${usage}`);
    if (command === "retro" && work === undefined) {
      work = arg;
      continue;
    }
    throw new Error(`unexpected argument "${arg}"\n${usage}`);
  }
  return {
    command,
    once,
    all,
    ...(configPath ? { configPath } : {}),
    ...(runtime ? { runtime } : {}),
    ...(work ? { work } : {}),
    ...(language ? { language } : {}),
  };
}

function parseRecoveryArgs(args: string[]): CliArgs {
  const [workKey, ...flags] = args;
  if (!workKey || workKey.startsWith("--")) throw new Error(usage);
  const parsed: CliArgs = { command: "recover", once: false, all: false, workKey };
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!;
    if (seen.has(flag)) throw new Error(`duplicate flag ${flag}`);
    seen.add(flag);
    if (flag === "--accept-duplicate-risk") { parsed.acceptDuplicateRisk = true; continue; }
    if (flag !== "--config" && flag !== "--retry" && flag !== "--reason") throw new Error(`unknown recovery flag ${flag}\n${usage}`);
    const value = flags[++index];
    if (!value || value.startsWith("--") || !value.trim()) throw new Error(`missing value for ${flag}`);
    if (flag === "--config") parsed.configPath = value;
    else if (flag === "--retry") parsed.retry = value;
    else parsed.reason = value;
  }
  if ((parsed.retry !== undefined || parsed.reason !== undefined || parsed.acceptDuplicateRisk === true) &&
      (parsed.retry === undefined || parsed.reason === undefined || parsed.acceptDuplicateRisk !== true)) {
    throw new Error("retry requires --retry <review>, --accept-duplicate-risk and --reason <text> together");
  }
  return parsed;
}
