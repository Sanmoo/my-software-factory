#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { runGateway } from "./quality-gateway-runner.mjs";

/**
 * TEST-ONLY fixture entry (issue 113, Testing Decisions): the bounded
 * command-contract tests run this entry with fixture checks and a short
 * budget, so they never wait four minutes or re-enter the official suite. The
 * canonical command (`quality-gateway.mjs`) reads neither variable and cannot
 * be reconfigured this way; every line here is labelled as a fixture run.
 */
const LABEL = "quality gateway fixture (test-only)";

function refuse(line) {
  process.stderr.write(`${LABEL}: ${line}\n`);
}

const planPath = process.env.MSF_GATEWAY_TEST_PLAN;
const budget = process.env.MSF_GATEWAY_TEST_BUDGET_MS;

if (planPath === undefined || budget === undefined) {
  refuse("set both MSF_GATEWAY_TEST_PLAN and MSF_GATEWAY_TEST_BUDGET_MS");
  process.exitCode = 1;
} else {
  const budgetMs = Number(budget);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    refuse(`MSF_GATEWAY_TEST_BUDGET_MS must be a positive number, got "${budget}"`);
    process.exitCode = 1;
  } else {
    let plan;
    try {
      plan = JSON.parse(readFileSync(planPath, "utf8"));
    } catch (error) {
      refuse(`cannot read the fixture plan at ${planPath}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    if (plan !== undefined) {
      process.exitCode = await runGateway(plan, { cwd: process.cwd(), budgetMs, label: LABEL });
    }
  }
}
