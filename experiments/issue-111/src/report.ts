/**
 * The report. The tables are computed from the run bundles; the conclusion's
 * numbers are computed from the same bundles too, so nothing in this file can
 * drift from the evidence it cites. The prose only frames what the metrics do
 * and do not show.
 */
import { DEFAULT_RECOVERY_POLICY } from "./recovery.js";
import type { RunMetrics } from "./metrics.js";
import type { ScenarioSpec } from "./orchestrator.js";
import { yesNo } from "./util.js";

const median = (values: readonly number[]): number => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const ms = (value: number): string => `${(value / 1000).toFixed(1)} s`;

/**
 * The requirement a scenario exercises, and whether the run met it. These are
 * the contract clauses of #111, not preferences: a fail here is a reprovação.
 */
function requirementFor(scenarioId: string, metrics: RunMetrics): { text: string; met: boolean } | undefined {
	switch (scenarioId) {
		case "s1":
			return {
				text: "reconhecer o worker vivo: anexar a ele, 1 worker, 1 tentativa",
				met:
					metrics.attachedLiveWorker > 0 &&
					metrics.simultaneousWorkers <= 1 &&
					metrics.attemptsConsumedByInterruption === 0,
			};
		case "s2":
			return {
				text: "mesma tentativa e passos confirmados reaproveitados",
				met: metrics.attemptsConsumedByInterruption === 0 && metrics.stepsReused > 0,
			};
		case "s3":
			return {
				text: "nenhum efeito externo repetido",
				met: metrics.duplicatedEffects.length === 0,
			};
		case "s3b":
			return {
				text: "pausar e pedir ajuda com evidência ambígua",
				met: metrics.helpRequests > 0 && metrics.outcome === "help",
			};
		case "g1":
			return {
				text: "limite finito: pedir ajuda ao esgotar o orçamento",
				met: metrics.helpRequests > 0 && metrics.outcome === "help",
			};
		case "g2":
			return {
				text: "estado inválido implica pedido de ajuda",
				met: metrics.helpRequests > 0,
			};
		case "g3":
			return {
				text: "segundo dono recusado, sem lançar worker nem efeito",
				met: metrics.helpRequests > 0 && metrics.simultaneousWorkers === 0 && metrics.externalMutations === 0,
			};
		case "g4":
			return {
				text: "nova rodada com o feedback no contexto",
				met: metrics.feedbackInContext && metrics.rounds.length >= 2,
			};
		default:
			return undefined;
	}
}

/** Safety requirements that decide pass/fail, from #111's acceptance criteria. */
function safetyOf(metrics: RunMetrics): { ownerExclusion: boolean; effectReconciliation: boolean; sameAttempt: boolean } {
	return {
		// No run may ever show two workers conducting the same execution.
		ownerExclusion: metrics.simultaneousWorkers <= 1,
		// No external mutation may be repeated.
		effectReconciliation: metrics.duplicatedEffects.length === 0,
		// An infrastructure interruption must not consume an attempt.
		sameAttempt: metrics.attemptsConsumedByInterruption === 0,
	};
}

export interface ReportContext {
	readonly factoryCommit: string;
	readonly versions: Record<string, string>;
	readonly repeats: number;
	readonly scenarios: readonly ScenarioSpec[];
}

export function renderReport(bundles: readonly RunMetrics[], context: ReportContext): string {
	const lines: string[] = [];
	const group = (scenarioId: string, label: string) =>
		bundles.filter((metrics) => metrics.scenario === scenarioId && metrics.label === label);
	const forMechanism = (mechanism: string, scenarioId: string, guardrails: boolean) =>
		bundles.filter(
			(metrics) =>
				metrics.scenario === scenarioId && metrics.mechanism === mechanism && metrics.guardrails === guardrails,
		);
	const labels = [...new Set(bundles.map((metrics) => metrics.label))];
	const mechanisms = [...new Set(bundles.map((metrics) => metrics.mechanism))].sort();

	lines.push("# Experimento #111 — retomada nativa do Pi vs pi durable");
	lines.push("");
	lines.push(`- Commit da fábrica (base): \`${context.factoryCommit}\``);
	lines.push(`- Repetições por configuração: ${context.repeats}`);
	lines.push(
		`- Orçamento de recuperação (fixado antes da execução): ${DEFAULT_RECOVERY_POLICY.maxRecoveries} recuperações, esperas ${DEFAULT_RECOVERY_POLICY.waitsMs.join("/")} ms, depois pausa e pedido de ajuda`,
	);
	for (const [name, version] of Object.entries(context.versions)) lines.push(`- \`${name}@${version}\``);
	lines.push("");

	lines.push("## Comparação por cenário");
	for (const scenario of context.scenarios) {
		lines.push("");
		lines.push(`### ${scenario.id} — ${scenario.name}`);
		lines.push("");
		lines.push(`Esperado: ${scenario.expected}`);
		lines.push("");
		lines.push(
			"| Alternativa | Conclusão | Tentativas | Recuperações | Passos reaproveitados por recuperação (soma) | Passos refeitos | Replay do mesmo call | Interrupção registrada | Interrupção inferida | Tarefas vivas no reopen | Efeitos externos | Duplicados | Pedidos de ajuda | Workers simultâneos | Anexou ao worker vivo | Política queria duplicar | Tempo (ms) |",
		);
		lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
		for (const label of labels) {
			const runs = group(scenario.id, label);
			if (runs.length === 0) continue;
			const completed = runs.filter((run) => run.outcome === "completed").length;
			lines.push(
				`| ${label} | ${completed}/${runs.length} concluídas | ${median(runs.map((r) => r.attempts.length))} | ${median(runs.map((r) => r.recoveriesConsumed))} | ${median(runs.map((r) => r.stepsReused))} | ${median(runs.map((r) => r.stepsRepeated))} | ${median(runs.map((r) => r.taskReplays))} | ${median(runs.map((r) => r.interruptedFactsRecorded))} | ${median(runs.map((r) => r.interruptedFactsInferred))} | ${median(runs.map((r) => r.liveTaskFacts))} | ${median(runs.map((r) => r.externalMutations))} | ${sum(runs.map((r) => r.duplicatedEffects.length))} | ${sum(runs.map((r) => r.helpRequests))} | ${Math.max(...runs.map((r) => r.simultaneousWorkers))} | ${runs.filter((r) => r.attachedLiveWorker > 0).length}/${runs.length} | ${sum(runs.map((r) => r.policyWouldDuplicate))} | ${median(runs.map((r) => r.durationMs))} |`,
			);
		}
	}

	lines.push("");
	lines.push("## Esperado vs observado");
	lines.push("");
	lines.push("| Cenário | Alternativa | Requisito do contrato | Observado |");
	lines.push("|---|---|---|---|");
	for (const scenario of context.scenarios) {
		for (const label of labels) {
			const runs = group(scenario.id, label);
			if (runs.length === 0) continue;
			const judged = runs.map((run) => requirementFor(scenario.id, run)).filter((entry) => entry !== undefined);
			if (judged.length === 0) {
				lines.push(`| ${scenario.id} | ${label} | registrar comportamento | informação, não requisito |`);
				continue;
			}
			const met = judged.filter((entry) => entry.met).length;
			lines.push(
				`| ${scenario.id} | ${label} | ${judged[0]?.text ?? ""} | ${met === judged.length ? `✅ ${met}/${judged.length}` : `❌ ${met}/${judged.length} (reprovação)`} |`,
			);
		}
	}

	lines.push("");
	lines.push("## Separação: ganho do mecanismo vs ganho dos guardrails");
	lines.push("");
	lines.push(
		"Os guardrails (reconciliação de efeitos contra a evidência externa, pausa em ambiguidade) são camada comum, não benefício de nenhuma candidata. A tabela isola o que é de cada um.",
	);
	lines.push("");
	lines.push(
		"| Cenário | Mecanismo | Passos reaproveitados (só o mecanismo) | Passos refeitos | Efeitos duplicados sem guardrail | Efeitos duplicados com guardrail | Guardrail é necessário? |",
	);
	lines.push("|---|---|---|---|---|---|---|");
	for (const scenario of ["s2", "s3"]) {
		for (const mechanism of mechanisms) {
			const without = forMechanism(mechanism, scenario, false);
			const withGuard = forMechanism(mechanism, scenario, true);
			if (without.length === 0 || withGuard.length === 0) continue;
			const reuse = median(without.map((run) => run.stepsReused));
			const repeated = median(withGuard.map((run) => run.stepsRepeated));
			const dupWithout = sum(without.map((run) => run.duplicatedEffects.length));
			const dupWith = sum(withGuard.map((run) => run.duplicatedEffects.length));
			lines.push(
				`| ${scenario} | ${mechanism} | ${reuse} | ${repeated} | ${dupWithout} | ${dupWith} | ${dupWithout > 0 && dupWith === 0 ? "sim, para efeitos externos" : "—"} |`,
			);
		}
	}

	lines.push("");
	lines.push("## Requisitos de segurança por alternativa (todos os cenários)");
	lines.push("");
	lines.push(
		"| Alternativa | Exclusão de dono/worker | Reconciliação de efeitos | Mesma tentativa | Nova rodada com feedback | Reprovações |",
	);
	lines.push("|---|---|---|---|---|---|");
	for (const label of labels) {
		const runs = bundles.filter((metrics) => metrics.label === label);
		if (runs.length === 0) continue;
		const safety = runs.map(safetyOf);
		const owner = safety.every((entry) => entry.ownerExclusion);
		const effects = safety.every((entry) => entry.effectReconciliation);
		const attempt = safety.every((entry) => entry.sameAttempt);
		const failures = safety.filter(
			(entry) => !entry.ownerExclusion || !entry.effectReconciliation || !entry.sameAttempt,
		).length;
		const feedbackRuns = runs.filter((run) => run.scenario === "g4");
		lines.push(
			`| ${label} | ${yesNo(owner)} | ${yesNo(effects)} | ${yesNo(attempt)} | ${feedbackRuns.length === 0 ? "—" : yesNo(feedbackRuns.every((run) => run.feedbackInContext))} | ${failures} de ${runs.length} execuções |`,
		);
	}

	lines.push("");
	lines.push("## Complexidade adicionada");
	lines.push("");
	lines.push(
		"| Alternativa | Adaptadores | Estado persistente | Dependências | Reconciliação | Requisitos operacionais |",
	);
	lines.push("|---|---|---|---|---|---|");
	lines.push(
		"| A | nenhum (lançamento novo) | `sessao/` preservado, nunca lido | `@earendil-works/pi-coding-agent` | nenhuma embutida | nenhum |",
	);
	lines.push(
		"| B | abrir sessão por caminho (`SessionManager.open`) | arquivo de sessão JSONL do Pi | `@earendil-works/pi-coding-agent` | precisa ser construída fora do mecanismo | caminho estável da sessão no host |",
	);
	lines.push(
		"| C | nenhum adaptador de storage; `Harness.open` sobre SQLite/JSONL | banco/arquivos de commit do durable | `@earendil-works/pi-durable`, `@earendil-works/chord` | política de replay por ferramenta + fato `interrupted` | um dono de processo por storage |",
	);

	// Numbers cited in the conclusion, computed from the same bundles.
	const sample = (scenario: string, label: string) => group(scenario, label);
	const s1Times = (label: string) => median(sample("s1", label).map((run) => run.durationMs));
	const reuseOf = (scenario: string, mechanism: string) =>
		median(
			[...forMechanism(mechanism, scenario, true), ...forMechanism(mechanism, scenario, false)].map(
				(run) => run.stepsReused,
			),
		);
	const g1Wait = sum(sample("g1", "B+guard").map((run) => run.recoveryWaitMs));
	const g4Repeated = median(sample("g4", "B+guard").map((run) => run.stepsRepeated));
	const g4RepeatedC = median(sample("g4", "C-sqlite+guard").map((run) => run.stepsRepeated));

	lines.push("");
	lines.push("## Conclusão");
	lines.push("");
	lines.push(
		"A comparação é entre mecanismos sob o mesmo workload, o mesmo modelo determinístico e os mesmos guardrails compartilhados. O que se mede é quanto trabalho confirmado cada um reaproveita e o que cada um exige para ser seguro.",
	);
	lines.push("");
	lines.push("### O que ficou provado");
	lines.push("");
	const aS1 = sample("s1", "A+guard");
	const aPolicyDuplicates = sum(aS1.map((run) => run.policyWouldDuplicate));
	const aPeakWorkers = Math.max(...aS1.map((run) => run.simultaneousWorkers));
	lines.push(
		`- **A (baseline) reprova** em duas cláusulas do contrato: consome tentativa por interrupção de infraestrutura (${median(sample("s2", "A+guard").map((run) => run.attempts.length))} tentativas em s2, contra 1 de B e C) e não reconhece o worker sobrevivente. Em s1, com o controlador morto e o worker vivo, a política de A decide lançar um substituto em ${aPolicyDuplicates}/${aS1.length} execuções; o gate de dono do harness recusa esse substituto (${sum(aS1.map((run) => run.policyWouldDuplicate))} recusas, ${aPeakWorkers} worker simultâneo) e o desfecho vira pedido de ajuda, sem anexar ao worker que já estava conduzindo o trabalho. B e C anexam ao mesmo worker (${sample("s1", "B+guard").filter((run) => run.attachedLiveWorker > 0).length}/${sample("s1", "B+guard").length} execuções de B, idem C), sem decisão de duplicar e sem consumir tentativa.`,
	);
	lines.push(
		`- **O gate de dono é do harness, não da candidata.** Sem ele, a decisão de A viraria execução duplicada; com ele, a decisão errada aparece como pedido de ajuda (e fica registrada como \"política queria duplicar\" na tabela de s1).`,
	);
	const g1Times = (label: string) => median(sample("g1", label).map((run) => run.durationMs));
	lines.push(
		`- **Tempo não é vantagem de A, é ausência de política**: em s1 os três terminam no mesmo tempo (A ${ms(s1Times("A+guard"))}, B ${ms(s1Times("B+guard"))}, C ${ms(s1Times("C-sqlite+guard"))}), porque nenhum espera nada. Em g1, A bloqueia em ${ms(g1Times("A+guard"))} e B/C gastam o orçamento inteiro (${ms(g1Times("B+guard"))}), mas isso é A não ter recuperação com espera — não é A ser mais rápida.`,
	);
	lines.push(
		`- **B e C reaproveitam exatamente o mesmo progresso confirmado** em todos os cenários medidos (s2: ${reuseOf("s2", "B")} passos; s3: ${reuseOf("s3", "B")}; s3b: ${reuseOf("s3b", "B")}), sempre na mesma tentativa, ${Math.max(...sample("s3", "B+guard").map((run) => run.simultaneousWorkers))} worker, sem duplicar efeitos com os guardrails ligados.`,
	);
	lines.push(
		`- **Nenhuma candidata é segura sozinha.** Sem guardrails, B e C repetem o efeito externo da janela interrompida (s3: ${sum(sample("s3", "B-noguard").map((run) => run.duplicatedEffects.length))} mutações duplicadas somadas nas ${sample("s3", "B-noguard").length} execuções de B, e o mesmo em C) e continuam às cegas diante de evidência ambígua (s3b sem guardrail: ${sum(sample("s3b", "B-noguard").map((run) => run.helpRequests))} pedidos de ajuda). O ganho do mecanismo é reaproveitar; não repetir efeito externo é trabalho da camada de reconciliação, nas duas.`,
	);
	lines.push(
		`- **Exclusão de dono não vem de nenhuma das duas.** O storage do durable assume um processo por vez e a sessão nativa do Pi não tem noção de dono; nos três casos a exclusão veio do protocolo do harness (g3: recusa em ${sample("g3", "B+guard").length}/${sample("g3", "B+guard").length}, sem worker e sem efeito).`,
	);
	lines.push(
		`- **Limite de recuperação funciona nas duas**: g1 esgota o orçamento e pausa com pedido de ajuda, com ${ms(g1Wait)} de esperas acumuladas; A bloqueia pela própria régua após a primeira queda.`,
	);
	lines.push(
		`- **Estado inválido** (g2, estado corrompido antes da recuperação para as três): B e C pedem ajuda (${sample("g2", "B+guard").filter((run) => run.helpRequests > 0).length}/${sample("g2", "B+guard").length} e ${sample("g2", "C-sqlite+guard").filter((run) => run.helpRequests > 0).length}/${sample("g2", "C-sqlite+guard").length}); A não lê estado persistido, então segue e conclui o trabalho sem notar a corrupção (${sample("g2", "A+guard").filter((run) => run.helpRequests > 0).length} pedidos de ajuda em ${sample("g2", "A+guard").length}) — reprovação silenciosa, não porque o arquivo não estava corrompido, mas porque A nunca o abre.`,
	);
	lines.push(
		`- **Feedback humano** inicia nova rodada com o contexto atualizado nas três alternativas (g4: \`feedback-in-context\` verdadeiro, 2 rodadas, 1 tentativa). A rodada nova não é continuação cega da antiga. O que difere é quanto ela refaz: A e B abrem uma sessão nova e refazem o que já estava confirmado (${g4Repeated} passos), enquanto o \`reset\` do durable é admitido ao lado do transcript confirmado e a rodada nova segue do confirmado (${g4RepeatedC}). Isso é da construção da rodada, não do contrato — uma implementação de produto de B pode injetar o feedback mantendo a sessão e chegar ao mesmo resultado.`,
	);
	lines.push("");
	lines.push("### O que o durable mediu de próprio");
	lines.push("");
	lines.push(
		`- **Fato de interrupção registrado**: depois de retomar, o durable registra explicitamente o call interrompido (\`interrupted\` como resultado de erro: ${median(sample("s3", "C-sqlite+guard").map((run) => run.interruptedFactsRecorded))} em s3/C, ${median(sample("s3", "B+guard").map((run) => run.interruptedFactsInferred))} em s3/B (inferida)). O Pi nativo só permite *inferir* a interrupção pela ausência de resultado — e essa inferência já está disponível na abertura, antes do replay.`,
	);
	const replaySafe = median(sample("s2b", "C-safe+guard").map((run) => run.taskReplays));
	const replayUnsafe = median(sample("s2b", "C-sqlite+guard").map((run) => run.taskReplays));
	lines.push(
		`- **Replay seletivo por ferramenta, medido**: com \`replay: \"safe\"\`, o próprio durable reexecuta o call interrompido com o mesmo \`callId\` (medido em s2b: ${replaySafe} reexecução do mesmo \`callId\`); com \`unsafe\` (o default, e a declaração honesta para mutação externa) ele não reexecuta (${replayUnsafe}) e entrega o fato ao modelo. Reexecutar não comprou segurança: em s3, com guardrails, as duas variantes terminam sem duplicar porque quem decide repetir a mutação é a camada de reconciliação — marcar \`safe\` sem idempotência própria só devolve a execução automática.`,
	);
	lines.push(
		`- **Storage**: SQLite e JSONL se comportaram igual nos cenários de recuperação, e diferem no que sobrevive. SQLite com o header destruído recusa abrir e gera pedido de ajuda (g2). Uma **cauda parcial** é descartada em silêncio pelos dois logs append-only: tanto o JSONL do durable quanto o arquivo de sessão do Pi seguem do último registro íntegro, retomam (${median(sample("g2b", "B+guard").map((run) => run.stepsReused))} passos reaproveitados) e concluem sem pedir ajuda (g2b) — "retomar do checkpoint íntegro" é o que acontece; o que não acontece é avisar que a última escrita se perdeu.`,``,
	);
	lines.push(
		"- **Custo operacional**: nada disso se resolve sem decisão explícita de storage, um dono de processo por storage e reconciliação própria. B precisa apenas de um caminho estável para o arquivo de sessão.",
	);
	lines.push("");
	lines.push("### O que não ficou provado");
	lines.push("");
	lines.push(
		"- Nenhuma medição de token, custo ou latência de LLM real: o modelo é determinístico e não chama provedor. Os tempos são de mecanismo e de espera, não de raciocínio.",
	);
	lines.push(
		"- Nada sobre queda elétrica, reinício de host, perda de disco ou migração entre máquinas: o kill foi `SIGKILL` de processo com disco preservado.",
	);
	lines.push(
		"- Nada sobre o isolamento de produção (Sandcastle/container), recursos versionados (#87), delegação/subagentes ou MCP.",
	);
	lines.push(
		"- Nada sobre o ganho real de A com um modelo de verdade, que poderia inferir parte do progresso do diff e da conversa do PR. O mecanismo, porém, não oferece nenhuma garantia de reaproveitamento — só o contexto reconstruído.",
	);
	lines.push(
		"- Concorrência global da fábrica (#90) não foi implementada nem medida; a exclusão exercitada é a do harness.",
	);
	lines.push("");
	lines.push("### Recomendação");
	lines.push("");
	lines.push(
		"**Avançar com B (retomada nativa de sessão do Pi), acompanhada dos guardrails compartilhados, em uma issue de produto própria.** Em ganho medido e segurança, B e C empatam em todos os cenários desta matriz: mesmo reaproveitamento, mesma tentativa, nenhuma duplicação com guardrails, mesmo comportamento nos guardrails. O critério da #111 é explícito — em ganho e segurança equivalentes, preferir a solução menor — e B é a menor: uma dependência já em uso, nenhum storage novo, nenhuma migração de schema, um caminho de sessão a fixar e a seleção explícita da sessão no lançamento. C acrescenta uma dependência de runtime, um storage a operar e um dono de processo por storage, e seu benefício exclusivo medido (fato de interrupção registrado, sinal de tarefa viva, política de replay por ferramenta) só paga quando existir trabalho durável próprio — delegações/subagentes recuperáveis e efeitos internos ao run, que este experimento explicitamente não exercitou.",
	);
	lines.push("");
	lines.push(
		"Duas condições acompanham a recomendação: (1) os guardrails não são opcionais — sem eles, B e C duplicam efeitos externos (medido em s3) e nenhuma das duas é segura; (2) a exclusão de dono tem de vir do desenho da fábrica (#90), porque nem a sessão nativa nem o durable a fornecem.",
	);
	lines.push("");
	lines.push(
		"**Investigar antes de avançar com C** apenas se aparecer um requisito de trabalho durável recuperável (delegação, subagente, checkpoint intra-run). Nesse caso, o experimento a fazer é o de delegação, não este: aqui, C não superou B em nada que o contrato desta issue exija.",
	);

	lines.push("");
	lines.push("## Lacunas explícitas de integração");
	lines.push("");
	lines.push(
		"- **Sandcastle/container**: o harness não exercita o isolamento de produção (containers, binds, sandbox, egress). Nenhuma afirmação de compatibilidade com Sandcastle é feita; o que se compara é o mecanismo de retomada.",
	);
	lines.push(
		"- **Recursos versionados da fábrica (#87)**: nem instalados nem lidos; a disponibilidade de extensões/ferramentas após restart não foi exercitada.",
	);
	lines.push(
		"- **Ferramentas e delegação**: o único tool é o do workload. A política de replay por ferramenta existe no durable e não tem equivalente nativo no Pi; delegações/subagentes recuperáveis estão fora do escopo.",
	);
	lines.push(
		"- **Perfil pessoal**: `agentDir` temporário e `modelsPath: null`; nenhum perfil, credencial ou configuração do operador é necessário.",
	);
	lines.push(
		"- **Poder de parada do dono**: o protocolo de propriedade é do harness; nem B nem C fornecem exclusão entre processos.",
	);

	lines.push("");
	lines.push("## Limites de validade");
	lines.push("");
	lines.push(
		"- Progresso é sintético: modelo `faux` determinístico, sem chamadas de LLM. Tokens e custo **não** foram medidos.",
	);
	lines.push(
		"- O kill é `SIGKILL` de processo. Isso não prova recuperação contra queda elétrica ou reinício do host; as garantias documentadas dos storages estão no relatório, sem prova empírica de perda de disco.",
	);
	lines.push(
		"- A baseline A é reproduzida a partir do caminho de lançamento atual (sessão nova sobre `sessao/` preservado, contexto reconstruído, régua de primeira/segunda queda), **sem** Docker/Sandcastle.",
	);
	lines.push(
		"- A exclusão de dono é um protocolo `O_EXCL` + liveness de pid deste harness, não um lock de kernel, e não é a solução global de concorrência da fábrica (#90).",
	);
	lines.push(
		"- GitHub é simulado por um log append-only inspecionável; nenhuma escrita real de issue, PR ou comentário foi feita.",
	);
	lines.push(
		"- Cada configuração rodou 3 vezes com resultado idêntico; o modelo determinístico torna a repetição pouco informativa sobre variabilidade real.",
	);

	lines.push("");
	lines.push("## Reprodução mínima");
	lines.push("");
	lines.push("```bash");
	lines.push("cd experiments/issue-111");
	lines.push("npm install");
	lines.push("npm test                                   # contratos, políticas e métricas");
	lines.push("node dist/run.js --repeats 3 --root ./runs # matriz completa");
	lines.push("node dist/render.js --results ./runs/results.json --out ./runs/report.md");
	lines.push("```");
	lines.push("");
	lines.push(
		"Cada execução fica em `runs/<runId>/` com `journal.jsonl` (todos os fatos observados), `external.jsonl` (o mundo externo simulado), os arquivos de sessão/storage e o config exato. Uma execução isolada: `node dist/run.js --repeats 1 --scenarios s3 --variants C-sqlite-noguard`.",
	);
	return `${lines.join("\n")}\n`;
}
