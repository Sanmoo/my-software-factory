# Experimento #169 — Claim exclusivo entre fábricas pelo Jira Cloud

Harness isolado e determinístico que examina se um protocolo mínimo, usando
somente Jira Cloud, autoriza no máximo uma fábrica a executar um Worker por
Ticket — inclusive quando duas observam o Ticket livre e tentam adquiri-lo ao
mesmo tempo.

Não faz parte do build nem do caminho de produção da fábrica: o `tsconfig.json`
da raiz usa `rootDir: src` e `npm test` roda `dist/**/*.test.js`, então nada
aqui é compilado ou executado pela fábrica. **Nenhuma chamada a um Jira real é
feita e nenhum Ticket operacional é mutado.** As garantias vêm das fontes
primárias citadas no relatório; o simulador modela apenas o que elas permitem —
nunca um compare-and-set, lease, fila ou vencedor inventado.

O resultado, as premissas e a conclusão estão em [RELATORIO.md](RELATORIO.md).
A conclusão é **não demonstrado sob a documentação**: o único candidato
plausível (a atualização condicional de uma issue property em lote) só é seguro
sob uma premissa de atomicidade que a Atlassian **não** documenta. Fechar esta
investigação não aprova o protocolo nem torna a implementação (#170) pronta.

```bash
npm install
npm test          # 68 testes: identidade, modelo, matriz exaustiva e cenários
npm run run       # imprime a matriz e os cenários; grava runs/evidence.json
```

`npm run run` grava a mesma evidência em `runs/evidence.json` (ignorado pelo
git), incluindo as citações das fontes primárias. Tudo é determinístico: sem
rede, sem relógio, sem Docker.
