#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stageModules } from "./stage-modules.mjs";

/**
 * Stage the compiled continuity guardrail into the worker image's build
 * context. The staged tree is self-contained (stage-modules follows every
 * relative import); the image copies it to /opt/msf.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(root, "docker", "guardrail");

stageModules({
  name: "stage-guardrail",
  root,
  stage,
  modules: [
    "runtime/effects.js",
    "runtime/call-recovery.js",
    "runtime/session-log.js",
    "pool/work-key.js",
    "runtime/json-line.js",
    "runtime/continuity-artifacts.js",
    "runtime/guardrail/extension.js",
    "runtime/guardrail/delegation.js",
    "runtime/guardrail/journal-lock.js",
    "runtime/stop-request.js",
    "tracker/identity.js",
  ],
});
