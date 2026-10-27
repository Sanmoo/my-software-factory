#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { JIRA_CLIENT_CONTAINER_FILE } from "../layout.js";
import { JiraWorkerClient } from "./jira-worker-client.js";
import type { JiraMediationResponse, JiraPublicationKind } from "../work-record/jira-mediation.js";

/**
 * The command the worker runs to ask the factory for Jira access. It prints the
 * factory's structured answer as JSON and holds no Jira credential. The exit
 * status reports whether an answer was OBTAINED, never whether the requested
 * operation succeeded: a `rejected`, `failed` or `unknown` answer is still an
 * answer the worker must read.
 */

interface Args {
  command: "read" | "publish";
  contractPath: string;
  requestId?: string;
  kind?: JiraPublicationKind;
  text?: string;
  textFile?: string;
  timeoutMs?: number;
}

const USAGE =
  `usage: ${JIRA_CLIENT_CONTAINER_FILE} read --contract PATH [--request-id ID] [--timeout-ms N]\n` +
  `       ${JIRA_CLIENT_CONTAINER_FILE} publish --contract PATH --kind help|update (--text TEXT | --text-file PATH) ` +
  "[--request-id ID] [--timeout-ms N]";

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0];
  if (command !== "read" && command !== "publish") throw new Error(USAGE);
  const args: Partial<Args> = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}\n${USAGE}`);
    index += 1;
    switch (flag) {
      case "--contract":
        args.contractPath = value;
        break;
      case "--request-id":
        args.requestId = value;
        break;
      case "--kind":
        if (value !== "help" && value !== "update") throw new Error(`unknown publication kind "${value}"\n${USAGE}`);
        args.kind = value;
        break;
      case "--text":
        args.text = value;
        break;
      case "--text-file":
        args.textFile = value;
        break;
      case "--timeout-ms": {
        const timeoutMs = Number(value);
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid timeout "${value}"`);
        args.timeoutMs = timeoutMs;
        break;
      }
      default:
        throw new Error(`unknown flag "${flag}"\n${USAGE}`);
    }
  }
  if (args.contractPath === undefined) throw new Error(`--contract PATH is required\n${USAGE}`);
  if (args.command === "publish") {
    if (args.kind === undefined) throw new Error(`publish needs --kind\n${USAGE}`);
    if ((args.text === undefined) === (args.textFile === undefined)) {
      throw new Error(`publish needs exactly one of --text and --text-file\n${USAGE}`);
    }
  }
  return args as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const client = new JiraWorkerClient({
    contractPath: args.contractPath,
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  });
  let response: JiraMediationResponse;
  if (args.command === "read") {
    response = await client.read(args.requestId === undefined ? {} : { requestId: args.requestId });
  } else {
    const text = args.text ?? readFileSync(args.textFile!, "utf8");
    response = await client.publish({
      kind: args.kind!,
      text,
      ...(args.requestId === undefined ? {} : { requestId: args.requestId }),
    });
  }
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`jira-client-cli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
