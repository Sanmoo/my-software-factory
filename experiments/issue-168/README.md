# Experimento #168 — Claim exclusivo entre fábricas pelo GitHub Issues

Harness isolado e determinístico que examina se um protocolo mínimo, usando
somente GitHub Issues, autoriza no máximo uma fábrica a executar um Worker por
Ticket — inclusive quando duas observam o Ticket livre e tentam adquiri-lo ao
mesmo tempo.

Não faz parte do build nem do caminho de produção da fábrica: o `tsconfig.json`
da raiz usa `rootDir: src` e `npm test` roda `dist/**/*.test.js`, então nada
aqui é compilado ou executado pela fábrica. **Nenhuma chamada ao GitHub real é
feita**: as garantias vêm das fontes primárias citadas no relatório, e o
simulador modela apenas o que elas permitem — nunca um compare-and-set, lease
ou vencedor inventado.

O resultado, as premissas e a conclusão estão em [RELATORIO.md](RELATORIO.md).
A conclusão é **não demonstrado sob as garantias documentadas**: o candidato
mínimo (`claim-sequence`) só é seguro sob duas premissas que o GitHub não
documenta. Fechar esta investigação não autoriza a implementação.

```bash
npm install
npm test          # 41 testes: matriz exaustiva + cenários
npm run run       # imprime a matriz protocolo × leitura e os cenários
```

`npm run run` grava a mesma evidência em `runs/evidence.json` (ignorado pelo
git). Tudo é determinístico: sem rede, sem relógio, sem Docker.
