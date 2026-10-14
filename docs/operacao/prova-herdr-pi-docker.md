# Prova técnica: Herdr + Pi interativo em Docker (#52)

Resultado da consolidação do item 7 do [spec #48](https://github.com/Sanmoo/my-software-factory/issues/48).
Prova descartável e reproduzível; o comportamento de produção continua em `src/runtime/` e
`src/cli/` com testes. Linguagem: [GLOSSARY](../../GLOSSARY.md).

Versões provadas (2026-10-14): Docker server 29.7.2; herdr 0.9.3; pi 1.2.0 no container
(modelo `opencode-go/gpt-6-luna`, com autenticação do retrato do perfil); imagem
`msf-docker-runner:local`.

## Reprodução

```
npm run smoke:herdr-pi        # rodar DENTRO de uma pane do Herdr (HERDR_ENV=1)
```

Um comando, ~4 minutos. A prova cria aba, fixture, clone e retrato de perfil descartáveis em
`.smoke/herdr-pi-proof/<slug>/` e os limpa ao fim. Os artefatos de cada rodada (relatório,
evidências, sessão Pi do container, registros de saída) ficam nesse diretório.

## Provado

- Aba do Herdr criada **sem roubar o foco**; pane de execução e pane de controle no workspace atual.
- O pi interativo roda **dentro do Docker**, nunca no host: o processo em primeiro plano da pane é
  o cliente `docker`, e o pi aparece no `docker top -o pid,args` do container (o daemon recusa
  `-o args` isolado; este é o motivo de formato conhecido).
- Turno real do modelo provado pela **sessão JSONL escrita pelo container no mount do host**
  (inclusive resultado estruturado `<promise>MSF-RESULT</promise>`), nunca pelo eco da pane.
- Entrada do operador aceita pelo pi em execução (`/help` e turno real com marcador novo).
- Fim real do exec observado pelo **registro de saída JSON escrito pelo container** (wrapper
  `trap '' INT`): exit 0 após ctrl+d; texto da pane, pane fechada e exit code **não** são prova de
  encerramento.
- Aba e pane sobrevivem ao fim do pi, com histórico preservado.
- Identidade separada: id do container ≠ id da pane ≠ id da aba; `HERDR_PANE_ID` não vaza para
  dentro do container.
- Retomada na MESMA sessão JSONL e no mesmo clone (exec com `-c`), com turno novo comprovado
  por marcador novo.
- Redescoberta de um exec vivo depois de perder a supervisão, a partir do registro em disco.
- Nenhum exec órfão ao fim da prova (assert de zero containers `msf-proof-*`).

## Limitações e não provado (nesta versão)

- **Fechar a aba NÃO para o exec** (herdr 0.9.3): o container continuou rodando após
  `herdr tab close`; a prova reavencia com `docker rm -f` por nome do registro. Consequência para
  o orquestrador: reaver execução por identidade (nome/id do registro de supervisão), não pelo
  fechamento da aba.
- `herdr pane resize` muda a geometria do layout mas o tamanho do pty visto pelos processos
  permaneceu inalterado (`stty size` idêntico antes e depois); resize do terminal do processo não
  comprovado.
- **Notificação de mesa: herdr 0.9.3 não tem comando de notificação** — toda tentativa de
  `herdr show …` responde `unknown command: show`. Não há capacidade a provar nesta versão.
