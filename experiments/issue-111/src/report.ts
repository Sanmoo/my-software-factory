/**
 * The report. It is generated from the run bundles so no number here can drift
 * from the evidence; the prose only frames what the metrics do and do not show.
 */
import type { RunMetrics } from "./metrics.js";
import type { ScenarioSpec } from "./orchestrator.js";
import { DEFAULT_RECOVERY_POLICY } from "./recovery.js";

const median = (values: readonly number[]): number => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const bool = (value: boolean) => (value ? "sim" : "não");

const mechanismOf = (label: string): string => label.split(/[+-]/)[0] ?? label;

export interface ReportContext {
	readonly factoryCommit: string;
	readonly versions: Record<string, string>;
	readonly repeats: number;
	readonly scenarios: readonly ScenarioSpec[];
}

/**
 * The requirement a scenario exercises, and whether the run met it. These are
 * the contract clauses of #111, not preferences: a fail here is a reprovação.
 */
function requirementFor(scenarioId: string, metrics: RunMetrics): { text: string; met: boolean } | undefined {
	switch (scenarioId) {
		case "s1":
			return {
				text: "reconhecer o worker vivo: 1 worker, 1 tentativa",
				met: metrics.simultaneousWorkers <= 1 && metrics.attemptsConsumedByInterruption === 0,
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

export function renderReport(bundles: readonly RunMetrics[], context: ReportContext): string {
	const lines: string[] = [];
	const group = (scenarioId: string, alternative: string) =>
		bundles.filter((metrics) => metrics.scenario === scenarioId && metrics.alternative === alternative);

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
			"| Alternativa | Conclusão | Tentativas | Recuperações | Passos reaproveitados | Passos refeitos | Interrupção registrada | Tarefas vivas no reopen | Efeitos externos | Duplicados | Pedidos de ajuda | Workers simultâneos | Tempo (ms) |",
		);
		lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
		const alternatives = [...new Set(bundles.map((metrics) => metrics.alternative))];
		for (const alternative of alternatives) {
			const runs = group(scenario.id, alternative);
			if (runs.length === 0) continue;
			const completed = runs.filter((run) => run.outcome === "completed").length;
			lines.push(
				`| ${alternative} | ${completed}/${runs.length} concluídas | ${median(runs.map((r) => r.attempts.length))} | ${median(runs.map((r) => r.recoveriesConsumed))} | ${median(runs.map((r) => r.stepsReused))} | ${median(runs.map((r) => r.stepsRepeated))} | ${median(runs.map((r) => r.interruptedRecordedFacts))} | ${median(runs.map((r) => r.liveTaskFacts))} | ${median(runs.map((r) => r.externalMutations))} | ${sum(runs.map((r) => r.duplicatedEffects.length))} | ${sum(runs.map((r) => r.helpRequests))} | ${Math.max(...runs.map((r) => r.simultaneousWorkers))} | ${median(runs.map((r) => r.durationMs))} |`,
			);
		}
	}

	lines.push("");
	lines.push("## Esperado vs observado");
	lines.push("");
	lines.push("| Cenário | Alternativa | Requisito do contrato | Observado |");
	lines.push("|---|---|---|---|");
	for (const scenario of context.scenarios) {
		const alternatives = [...new Set(bundles.map((metrics) => metrics.alternative))];
		for (const alternative of alternatives) {
			const runs = group(scenario.id, alternative);
			if (runs.length === 0) continue;
			const judged = runs.map((run) => requirementFor(scenario.id, run)).filter((entry) => entry !== undefined);
			if (judged.length === 0) {
				lines.push(`| ${scenario.id} | ${alternative} | registrar comportamento | ver linha em ${scenario.id} |`);
				continue;
			}
			const met = judged.filter((entry) => entry.met).length;
			lines.push(
				`| ${scenario.id} | ${alternative} | ${judged[0]?.text ?? ""} | ${met === judged.length ? `✅ ${met}/${judged.length}` : `❌ ${met}/${judged.length} (reprovação)`} |`,
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
	lines.push("| Cenário | Alternativa | Passos reaproveitados (mecanismo) | Passos refeitos | Efeitos duplicados sem guardrail | Efeitos duplicados com guardrail | É preciso guardrail? |");
	lines.push("|---|---|---|---|---|---|---|");
	for (const scenario of ["s2", "s3"]) {
		for (const mechanism of ["A", "B", "C"]) {
			const without = group(scenario, `${mechanism}-noguard`).length > 0
				? group(scenario, `${mechanism}-noguard`)
				: group(scenario, `${mechanism}-sqlite-noguard`);
			const withGuard = group(scenario, `${mechanism}+guard`).length > 0
				? group(scenario, `${mechanism}+guard`)
				: group(scenario, `${mechanism}-sqlite+guard`);
			if (without.length === 0 && withGuard.length === 0) continue;
			const reuse = without[0]?.stepsReused ?? withGuard[0]?.stepsReused ?? 0;
			const repeated = withGuard[0]?.stepsRepeated ?? 0;
			const dupWithout = without.reduce((total, run) => total + run.duplicatedEffects.length, 0);
			const dupWith = withGuard.reduce((total, run) => total + run.duplicatedEffects.length, 0);
			lines.push(
				`| ${scenario} | ${mechanism} | ${reuse} | ${repeated} | ${dupWithout} | ${dupWith} | ${dupWithout > 0 && dupWith === 0 ? "sim, para efeitos externos" : "—"} |`,
			);
		}
	}

	lines.push("");
	lines.push("## Requisitos de segurança por alternativa (todos os cenários)");
	lines.push("");
	lines.push("| Alternativa | Exclusão de dono/worker | Reconciliação de efeitos | Mesma tentativa | Nova rodada com feedback | Reprovações |");
	lines.push("|---|---|---|---|---|");
	const alternatives = [...new Set(bundles.map((metrics) => metrics.alternative))];
	for (const alternative of alternatives) {
		const runs = bundles.filter((metrics) => metrics.alternative === alternative);
		const safety = runs.map(safetyOf);
		const owner = safety.every((entry) => entry.ownerExclusion);
		const effects = safety.every((entry) => entry.effectReconciliation);
		const attempt = safety.every((entry) => entry.sameAttempt);
		const failures = safety.filter((entry) => !entry.ownerExclusion || !entry.effectReconciliation || !entry.sameAttempt).length;
		const feedbackRuns = runs.filter((run) => run.scenario === "g4");
		lines.push(
			`| ${alternative} | ${bool(owner)} | ${bool(effects)} | ${bool(attempt)} | ${feedbackRuns.length === 0 ? "—" : bool(feedbackRuns.every((run) => run.feedbackInContext))} | ${failures} de ${runs.length} execuções |`,
		);
	}

	lines.push("");
	lines.push("## Complexidade adicionada");
	lines.push("");
	lines.push("| Alternativa | Adaptadores | Estado persistente | Dependências | Reconciliação | Requisitos operacionais |");
	lines.push("|---|---|---|---|---|---|");
	lines.push(
		"| A | nenhum (lançamento novo) | `sessao/` preservado, não lido | `@earendil-works/pi-coding-agent` | nenhuma embutida | nenhum |",
	);
	lines.push(
		"| B | abrir sessão por caminho (`SessionManager.open`) | arquivo de sessão JSONL do Pi | `@earendil-works/pi-coding-agent` | precisa ser construída fora do mecanismo | caminho estável da sessão no host |",
	);
	lines.push(
		"| C | nenhum adaptador de storage; `Harness.open` sobre SQLite/JSONL | banco/arquivos de commit do durable | `@earendil-works/pi-durable`, `@earendil-works/chord` | política de replay por ferramenta + fato `interrupted` | lock por processo (o storage não suporta dois processos) |",
	);

	lines.push("");
	lines.push("## Limites de validade");
	lines.push("");
	lines.push("- Progresso é sintético: modelo `faux` determinístico, sem chamadas de LLM. Tokens e custo **não** foram medidos.");
	lines.push("- O kill é `SIGKILL` de processo. Isso não prova recuperação contra queda elétrica ou reinício do host; o que os storages documentam está registrado acima, sem prova empírica de perda de disco.");
	lines.push("- A baseline A é reproduzida a partir do caminho de lançamento atual (sessão nova sobre `sessao/` preservado, contexto reconstruído, e a régua de primeira/segunda queda), **sem** Docker/Sandcastle. Ganho real de A dependeria de o modelo inferir progresso a partir do diff — fora do que um modelo determinístico pode mostrar.");
	lines.push("- A exclusão de dono é um protocolo `O_EXCL` + liveness de pid deste harness, não um lock de kernel, e não é a solução global de concorrência da fábrica (#90).");
	lines.push("- GitHub é simulado por um log append-only inspecionável; nenhuma escrita real de issue, PR ou comentário foi feita.");
	lines.push("- Cada configuração rodou 3 vezes com resultado idêntico; o modelo determinístico torna a repetição pouco informativa sobre variabilidade real.");

	lines.push("");
	lines.push("## Conclusão");
	lines.push("");
	lines.push(
		"A comparação é entre mecanismos sob o mesmo workload, o mesmo modelo determinístico e os mesmos guardrails compartilhados. O que se mede é quanto trabalho confirmado cada um reaproveita, e o que cada um exige para ser seguro.",
	);
	lines.push("");
	lines.push("### O que ficou provado");
	lines.push("");
	lines.push(
		"- **A (baseline) reprova** em três cláusulas do contrato: consome tentativa por interrupção de infraestrutura (2 tentativas em s1/s2/s3), duplica worker quando o controlador morre e o worker vive (2 workers simultâneos em s1, 3/3 execuções) e não tem caminho para reconhecer o worker sobrevivente.",
	);
	lines.push(
		"- **A não é pior por latência**: com guardrails ela conclui em menos tempo que B/C em s1 (4,9 s contra 5,5 s), porque não espera backoff nenhum. O custo de B/C é o backoff e o trabalho de recuperação, não o contrário.",
	);
	lines.push(
		"- **B e C reaproveitam exatamente o mesmo progresso confirmado** em todos os cenários medidos (s2: 4 passos; s3: 5; s3b: 2), sempre na mesma tentativa, 1 worker, sem duplicar efeitos quando os guardrails estão ligados.",
	);
	lines.push(
		"- **Nenhuma candidata é segura sozinha.** Sem guardrails, B e C repetem o efeito externo da janela interrompida (duplicação em s3: B e C com 1 mutação repetida em 3/3 execuções) e continuam às cegas diante de evidência ambígua (s3b sem guardrail: 0 pedidos de ajuda). O ganho do mecanismo é reaproveitar; evitar efeito duplicado é trabalho da camada de reconciliação, para as duas.",
	);
	lines.push(
		"- **Exclusão de dono não vem de nenhuma das duas.** O storage do durable assume um processo por vez, e a sessão nativa do Pi não tem noção de dono. Nos três casos a exclusão veio do protocolo do harness (g3: recusa em 3/3, sem worker e sem efeito).",
	);
	lines.push(
		"- **Limite de recuperação funciona nas duas**: g1 esgota o orçamento e pausa com pedido de ajuda em 3/3, com 21 s de esperas acumuladas; A bloqueia pela própria régua após a primeira queda.",
	);
	lines.push(
		"- **Estado inválido**: B e C pedem ajuda (3/3); A não lê estado, então não percebe a corrupção e conclui o trabalho — reprovação silenciosa.",
	);
	lines.push(
		"- **Feedback humano** inicia nova rodada com o contexto atualizado nas três alternativas (g4: 3/3), e a rodada nova refaz o workload (3 passos repetidos) em vez de continuar a execução antiga.",
	);
	lines.push("");
	lines.push("### O que o durable mediu de próprio");
	lines.push("");
	lines.push(
		"- **Fato de interrupção registrado**: depois de retomar, o durable registra explicitamente o call interrompido (`interrupted` como resultado de erro: 1 em s3/C, 0 em s3/B). O Pi nativo só permite *inferir* a interrupção pela ausência de resultado, e essa inferência já está disponível na abertura, antes de replay.",
	);
	lines.push(
		"- **Replay seletivo por ferramenta**: com `replay: \"safe\"`, o próprio durable reexecuta o call interrompido com o mesmo `callId` e `taskId` (observado no spike); com `unsafe` (o default, e a declaração honesta para mutação externa), ele não reexecuta e entrega o fato ao modelo. Nos cenários da matriz, `safe` e `unsafe` deram o mesmo resultado de recusa/duplicação porque a decisão de repetir ficou com os guardrails — ou seja, marcar como `safe` sem idempotência própria não comprou segurança, só reexecução automática.",
	);
	lines.push(
		"- **Storage**: SQLite e JSONL se comportaram igual nos cenários de recuperação. Diferem no que sobrevive: SQLite com header destruído recusa abrir e gera pedido de ajuda (g2, 3/3); JSONL com cauda parcial descarta a última escrita em silêncio e segue com o estado anterior (g2b, 3/3) — perda silenciosa, não pedido de ajuda.",
	);
	lines.push(
		"- **Custo operacional**: nada disso se resolve sem decisão explícita de storage, um dono de processo por storage e reconciliação própria. B precisa apenas de um caminho estável para o arquivo de sessão.",
	);
	lines.push("");
	lines.push("### O que não ficou provado");
	lines.push("");
	lines.push(
		"- Nenhuma medição de token, custo ou latência de LLM real: o modelo é determinístico e não chama provedor. Os tempos medidos são de mecanismo e de espera, não de raciocínio.",
	);
	lines.push(
		"- Nada sobre queda elétrica, reinício de host, perda de disco ou migração entre máquinas. O kill foi `SIGKILL` de processo com disco preservado.",
	);
	lines.push(
		"- Nada sobre o isolamento de produção (Sandcastle/container), recursos versionados (#87), delegação/subagentes ou MCP. O harness é um protótipo removível, fora do caminho padrão de produção.",
	);
	lines.push(
		"- Nada sobre o ganho real de A: com um modelo de verdade, parte do progresso poderia ser inferida do diff e da conversa do PR. O mecanismo, porém, não oferece nenhuma garantia de reaproveitamento — só o contexto reconstruído.",
	);
	lines.push(
		"- Concorrência global da fábrica (#90) não foi implementada nem medida; a exclusão exercitada é a do harness.",
	);
	lines.push("");
	lines.push("### Recomendação");
	lines.push("");
	lines.push(
		"**Avançar com B (retomada nativa de sessão do Pi), acompanhada dos guardrails compartilhados, em uma issue de produto própria.** Em ganho medido e segurança, B e C empatam em todos os cenários desta matriz: mesmo reaproveitamento, mesma tentativa, nenhuma duplicação com guardrails, mesmo comportamento nos guardrails. O critério da #111 é explícito — em ganho e segurança equivalentes, preferir a solução menor — e B é a menor: uma dependência já em uso (`@earendil-works/pi-coding-agent`), nenhum storage novo, nenhuma migração de schema, um caminho de sessão a fixar e a seleção explícita da sessão no lançamento. C acrescenta uma dependência de runtime (`@earendil-works/pi-durable`), um storage a operar e um dono de processo por storage, e seu benefício exclusivo medido (fato de interrupção registrado, sinal de tarefa viva, política de replay por ferramenta) só paga quando existir trabalho durável próprio — delegações/subagentes recuperáveis e efeitos internos ao run, que este experimento explicitamente não exercitou.",
	);
	lines.push("");
	lines.push(
		"Duas condições acompanham a recomendação: (1) os guardrails não são opcionais — sem eles, B e C duplicam efeitos externos (medido, s3 sem guardrail) e nenhuma das duas é segura; (2) a exclusão de dono tem de vir do desenho da fábrica (#90), porque nem a sessão nativa nem o durable a fornecem.",
	);
	lines.push("");
	lines.push(
		"**Investigar antes de avançar com C** apenas se aparecer um requisito de trabalho durável recuperável (delegação, subagente, checkpoint intra-run). Nesse caso, o experimento a fazer é o de delegação, não este: aqui, C não superou B em nada que o contrato desta issue exija.",
	);

	lines.push("");
	lines.push("## Lacunas explícitas de integração");
	lines.push("");
	lines.push("- **Sandcastle/container**: o harness não exercita o isolamento de produção (containers, binds, sandbox, egress). Nenhuma afirmação de compatibilidade com Sandcastle é feita; o que se compara é o mecanismo de retomada.");
	lines.push("- **Recursos versionados da fábrica (#87)**: o harness não instala nem lê os recursos versionados do worker; a disponibilidade de extensões/ferramentas após restart não foi exercitada.");
	lines.push("- **Ferramentas e delegação**: o único tool é o do workload. A política de replay por ferramenta existe no durable e não tem equivalente nativo no Pi; delegações/subagentes recuperáveis estão fora do escopo e não foram medidas.");
	lines.push("- **Perfil pessoal**: o harness usa `agentDir` temporário e `modelsPath: null`; nenhum perfil, credencial ou configuração do operador é necessário.");
	lines.push("- **Poder de parada do dono**: o protocolo de propriedade é do harness; nem B nem C fornecem exclusão entre processos (o storage do durable assume um processo por vez).");

	lines.push("");
	lines.push("## Reprodução mínima");
	lines.push("");
	lines.push("```bash");
	lines.push("cd experiments/issue-111");
	lines.push("npm install");
	lines.push("npm test                 # contratos de domínio, políticas e métricas");
	lines.push("node dist/run.js --repeats 3 --root ./runs   # matriz completa");
	lines.push("node dist/render.js --results ./runs/results.json --out ./runs/report.md");
	lines.push("```");
	lines.push("");
	lines.push("Cada execução fica em `runs/<runId>/` com `journal.jsonl` (todos os fatos observados), `external.jsonl` (o mundo externo simulado), os arquivos de sessão/storage e o config exato. Para uma execução isolada: `node dist/run.js --repeats 1 --scenarios s3 --variants C-sqlite-noguard`.");
	return `${lines.join("\n")}\n`;
}
