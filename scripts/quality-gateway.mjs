#!/usr/bin/env node
import { BUDGET_MS, OFFICIAL_PLAN, installSignalTermination, runGateway } from "./quality-gateway-runner.mjs";

/**
 * The canonical quality gateway. This entry accepts no flag and no override of
 * the official plan or its fixed ceiling: both are defined here. (An isolated
 * checkout may set MSF_WORKER_IMAGE so concurrent builds do not share one
 * Docker tag; the image inventory, not the tag, proves contents.) See README
 * for the operator contract.
 */
installSignalTermination();
process.exitCode = await runGateway(OFFICIAL_PLAN, { cwd: process.cwd(), budgetMs: BUDGET_MS });
