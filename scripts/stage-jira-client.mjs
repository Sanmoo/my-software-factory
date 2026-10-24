#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stageModules } from "./stage-modules.mjs";

/**
 * Stage the compiled worker-side Jira client into the worker image's build
 * context. It is the client the prompt names; it holds no credential and only
 * writes/reads the factory-mediated files, so the image needs exactly these
 * modules.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(root, "docker", "jira-client");

stageModules({
  name: "stage-jira-client",
  root,
  stage,
  modules: [
    "tracker/jira-client-cli.js",
    "tracker/jira-worker-client.js",
    "tracker/jira-mediation-protocol.js",
    "tracker/identity.js",
  ],
});
