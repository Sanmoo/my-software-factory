import { test } from "node:test";
import { proveDelegationStop } from "./delegation-stop-proof.js";
import { continuitySkipReason } from "./real-continuity-fixtures.js";

test("a requested stop during a real subagent preserves continuity and guards its effects",
  { skip: continuitySkipReason, timeout: 60_000 }, () => proveDelegationStop("requested"));
