#!/usr/bin/env node
import { BUDGET_MS, OFFICIAL_PLAN, installSignalTermination, runGateway } from "./quality-gateway-runner.mjs";

/**
 * The canonical quality gateway (issue 113). This entry accepts no flag and no
 * environment override: the official plan and its fixed ceiling are defined
 * here. See README for the operator contract.
 */
installSignalTermination();
process.exitCode = await runGateway(OFFICIAL_PLAN, { cwd: process.cwd(), budgetMs: BUDGET_MS });
