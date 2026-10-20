#!/usr/bin/env node
import { BUDGET_MS, OFFICIAL_PLAN, runGateway } from "./quality-gateway-runner.mjs";

/**
 * The canonical quality gateway (issue 113). This entry accepts no flag and no
 * environment override: the official plan and its 240-second ceiling are fixed
 * here. See README for the operator contract.
 */
process.exitCode = await runGateway(OFFICIAL_PLAN, { cwd: process.cwd(), budgetMs: BUDGET_MS });
