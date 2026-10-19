# Experimento #111 — continuidade do worker

Harness isolado e temporário que compara três alternativas de retomada
(baseline A, sessão nativa do Pi B, pi durable C) sob o mesmo workload, o mesmo
modelo determinístico (`faux`, sem LLM) e os mesmos guardrails. Não faz parte do
build nem do caminho de produção da fábrica: `tsconfig.json` da raiz usa
`rootDir: src` e `npm test` roda `dist/**/*.test.js`, então nada aqui é
compilado ou executado pela fábrica.

O relatório, os resultados e a conclusão ficam na issue #111.

```bash
npm install
npm test
node dist/run.js --repeats 3 --root ./runs
node dist/render.js --results ./runs/results.json --out ./runs/report.md
```

Cada execução grava `runs/<runId>/journal.jsonl` (fatos observados),
`external.jsonl` (mundo externo simulado), os arquivos de sessão/storage e o
config exato. Nenhuma escrita real em GitHub é feita.
