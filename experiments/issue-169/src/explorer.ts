import { Factory, type FactoryConfig, type PendingAcquisition } from "./factory.js";
import {
  CLAIM_PROPERTY_KEY,
  githubDestination,
  jiraTicket,
  type JiraTicket,
} from "./identity.js";
import {
  CAS_PREMISE_MODEL,
  JiraCloud,
  modelLabel,
  type JiraModel,
} from "./jira.js";
import { WorkerRuntime } from "./workers.js";

/**
 * Exhaustive exploration of the acquisition interleavings for the conditional
 * bulk-property candidate. Two independent factories (own workspace, own
 * acting account) contend for one Ticket; the tracker is their only channel.
 *
 * The explorer enumerates every linear extension of the protocol's steps that
 * the documented semantics allow: observe (a read), submit (303), the server
 * job's eligibility read and commit, task completion, verification and launch.
 * Under the CAS premise the eligibility read and the write are one step; under
 * the documented model they can interleave, which is exactly the question.
 *
 * Nothing here adds atomicity the API does not have: the only ordering the
 * model provides is the order the exploration chooses.
 */

const SITE = "alpha.atlassian.net";
const TICKET: JiraTicket = jiraTicket({ site: SITE, stableId: "10001", key: "OPS-1" });
const ACCOUNT = "shared-acting-account";

export interface Variant {
  name: string;
  model: JiraModel;
  premise: "documented" | "premise";
  note: string;
}

export const VARIANTS: readonly Variant[] = [
  {
    name: "documented-apply-not-isolated",
    model: { eligibilityAt: "apply", isolation: "none", readModel: "fresh", taskResult: "undocumented", searchStale: false },
    premise: "documented",
    note: "the filter is read at apply time, but two concurrent jobs are not isolated: both may observe the pre-state",
  },
  {
    name: "documented-enqueue-serialized",
    model: { eligibilityAt: "enqueue", isolation: "serialized", readModel: "fresh", taskResult: "undocumented", searchStale: false },
    premise: "documented",
    note: "the eligible set is fixed when the 303 is returned; serialized writes cannot undo the stale decision",
  },
  {
    name: "documented-apply-prefix-reads",
    model: { eligibilityAt: "apply", isolation: "none", readModel: "prefix", taskResult: "undocumented", searchStale: false },
    premise: "documented",
    note: "no isolation plus monotonic stale reads",
  },
  {
    name: "documented-stale-search",
    model: { eligibilityAt: "apply", isolation: "none", readModel: "fresh", taskResult: "undocumented", searchStale: true },
    premise: "documented",
    note: "the JQL search that observed the Ticket free is eventually consistent; the direct verification read is fresh",
  },
  {
    name: "cas-premise-stale-search",
    model: { eligibilityAt: "apply", isolation: "serialized", readModel: "fresh", taskResult: "undocumented", searchStale: true },
    premise: "premise",
    note: "P-CAS with a stale observation from search",
  },
  {
    name: "cas-premise",
    model: CAS_PREMISE_MODEL,
    premise: "premise",
    note: "P-CAS: the eligibility test and the write are one indivisible step per issue (NOT documented)",
  },
  {
    name: "cas-premise-prefix-reads",
    model: { eligibilityAt: "apply", isolation: "serialized", readModel: "prefix", taskResult: "undocumented", searchStale: false },
    premise: "premise",
    note: "P-CAS with stale verification reads: safety must survive, progress may not",
  },
  {
    name: "cas-premise-task-counts",
    model: { eligibilityAt: "apply", isolation: "serialized", readModel: "fresh", taskResult: "counts", searchStale: false },
    premise: "premise",
    note: "P-CAS plus an undocumented task result that reports the updated count",
  },
];

export interface Trace {
  events: string[];
  winners: string[];
  attempts: Record<string, number>;
  claimFactory: string | null;
  requests: string[];
}

export interface VariantReport {
  name: string;
  model: JiraModel;
  modelLabel: string;
  premise: "documented" | "premise";
  note: string;
  runs: number;
  oneWinner: number;
  twoWinners: number;
  noWinner: number;
  examples: { twoWinners?: Trace; oneWinner?: Trace; noWinner?: Trace };
}

type FactoryLabel = "A" | "B";

function factoryConfig(label: FactoryLabel): FactoryConfig {
  return {
    id: label === "A" ? "factory-a" : "factory-b",
    accountId: ACCOUNT,
    destination: githubDestination({
      site: "github.com",
      repo: label === "A" ? "Sanmoo/dest-a" : "Sanmoo/dest-b",
    }),
    claimedLabel: "agent-claimed",
  };
}

class Sim {
  readonly tracker: JiraCloud;
  readonly runtime = new WorkerRuntime();
  readonly factories: Record<FactoryLabel, Factory>;
  readonly events: string[] = [];

  constructor(readonly model: JiraModel) {
    this.tracker = new JiraCloud(model);
    this.tracker.seedIssue({
      site: SITE,
      stableId: TICKET.stableId,
      key: TICKET.key,
      status: "To Do",
    });
    this.factories = {
      A: new Factory(factoryConfig("A"), TICKET, this.tracker, this.runtime),
      B: new Factory(factoryConfig("B"), TICKET, this.tracker, this.runtime),
    };
  }

  /** The ticket key the Workers are registered under (identity, not `OPS-1`). */
  private ticketKey(): string {
    return `jira:${TICKET.site}:${TICKET.stableId}`;
  }

  winners(): string[] {
    return this.runtime
      .aliveFor(this.ticketKey())
      .map((worker) => worker.factory)
      .sort();
  }

  trace(): Trace {
    const claim = this.tracker.storedProperty(SITE, Number(TICKET.stableId), CLAIM_PROPERTY_KEY);
    const claimFactory =
      claim.kind === "present" && typeof claim.value === "object" && claim.value !== null && !Array.isArray(claim.value)
        ? String((claim.value as Record<string, unknown>)["factory"] ?? "<none>")
        : null;
    return {
      events: [...this.events],
      winners: this.winners(),
      attempts: {
        "factory-a": this.factories.A.attempts(),
        "factory-b": this.factories.B.attempts(),
      },
      claimFactory,
      requests: this.tracker
        .requestLog()
        .map((entry) => `${entry.factory} ${entry.op} -> ${entry.outcome}`),
    };
  }
}

interface SimEvent {
  id: string;
  deps: string[];
  run: (sim: Sim) => void;
}

function eventsFor(model: JiraModel, label: FactoryLabel): SimEvent[] {
  const prefix = label;
  const observe: SimEvent = {
    id: `${prefix}:observe`,
    deps: [],
    run: (sim) => void sim.factories[label].observe(),
  };
  const submit: SimEvent = {
    id: `${prefix}:submit`,
    deps: [observe.id],
    run: (sim) => void sim.factories[label].submitClaim(),
  };

  if (model.isolation === "serialized") {
    const apply: SimEvent = {
      id: `${prefix}:apply`,
      deps: [submit.id],
      run: (sim) => {
        const pending = sim.factories[label].pendingAcquisition();
        if (pending?.taskId != null) sim.tracker.applyJob(pending.taskId);
      },
    };
    const complete: SimEvent = {
      id: `${prefix}:complete`,
      deps: [apply.id],
      run: (sim) => void sim.factories[label].completeClaim(),
    };
    const verify: SimEvent = {
      id: `${prefix}:verify`,
      deps: [complete.id],
      run: (sim) => void sim.factories[label].verifyClaim(),
    };
    const launch: SimEvent = {
      id: `${prefix}:launch`,
      deps: [verify.id],
      run: (sim) => void sim.factories[label].launch(),
    };
    return [observe, submit, apply, complete, verify, launch];
  }

  const begin: SimEvent = {
    id: `${prefix}:begin`,
    deps: [submit.id],
    run: (sim) => {
      const pending: PendingAcquisition | undefined = sim.factories[label].pendingAcquisition();
      if (pending?.taskId != null) sim.tracker.beginJob(pending.taskId);
    },
  };
  const commit: SimEvent = {
    id: `${prefix}:commit`,
    deps: [begin.id],
    run: (sim) => {
      const pending = sim.factories[label].pendingAcquisition();
      if (pending?.taskId != null) sim.tracker.commitJob(pending.taskId);
    },
  };
  const complete: SimEvent = {
    id: `${prefix}:complete`,
    deps: [commit.id],
    run: (sim) => void sim.factories[label].completeClaim(),
  };
  const verify: SimEvent = {
    id: `${prefix}:verify`,
    deps: [complete.id],
    run: (sim) => void sim.factories[label].verifyClaim(),
  };
  const launch: SimEvent = {
    id: `${prefix}:launch`,
    deps: [verify.id],
    run: (sim) => void sim.factories[label].launch(),
  };
  return [observe, submit, begin, commit, complete, verify, launch];
}

function* linearExtensions(events: readonly SimEvent[]): Generator<SimEvent[]> {
  const done = new Set<string>();
  const order: SimEvent[] = [];

  function* walk(): Generator<SimEvent[]> {
    if (order.length === events.length) {
      yield [...order];
      return;
    }
    for (const event of events) {
      if (done.has(event.id)) continue;
      if (event.deps.some((dep) => !done.has(dep))) continue;
      done.add(event.id);
      order.push(event);
      yield* walk();
      order.pop();
      done.delete(event.id);
    }
  }

  yield* walk();
}

function runVariant(variant: Variant): VariantReport {
  const events = [...eventsFor(variant.model, "A"), ...eventsFor(variant.model, "B")];
  const report: VariantReport = {
    name: variant.name,
    model: variant.model,
    modelLabel: modelLabel(variant.model),
    premise: variant.premise,
    note: variant.note,
    runs: 0,
    oneWinner: 0,
    twoWinners: 0,
    noWinner: 0,
    examples: {},
  };

  for (const order of linearExtensions(events)) {
    const sim = new Sim(variant.model);
    for (const event of order) {
      sim.events.push(event.id);
      event.run(sim);
    }
    const winners = sim.winners();
    report.runs += 1;
    if (winners.length === 1) {
      report.oneWinner += 1;
      report.examples.oneWinner ??= sim.trace();
    } else if (winners.length === 2) {
      report.twoWinners += 1;
      report.examples.twoWinners ??= sim.trace();
    } else {
      report.noWinner += 1;
      report.examples.noWinner ??= sim.trace();
    }
  }

  return report;
}

export function exploreAll(): VariantReport[] {
  return VARIANTS.map((variant) => runVariant(variant));
}

export { TICKET as EXPLORER_TICKET, SITE as EXPLORER_SITE, ACCOUNT as EXPLORER_ACCOUNT };
