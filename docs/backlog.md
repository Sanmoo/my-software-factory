# Próximos passos

Antes de criar tickets: revisar/aprovar a [spec do MVP](spec.md), inclusive suas
propostas P01–P05. Docker e ambos os trackers são decisões confirmadas; não
substituir esse recorte pelos smokes noSandbox. Nenhum ticket criado nesta etapa.

1. **Compatibilidade mínima comprovada** com provider/modelo autorizado
   github-copilot/gpt-6-luna: [resultado](results/003-copilot-luna.md).
   Manter provider/modelo explícito e modelo barato nos próximos testes.
   Codex/CA Fortinet é pendência opcional, não bloqueador do caminho Copilot;
   [diagnóstico](results/002-tls-diagnosis.md). Não desabilitar TLS.
2. **Round-trip implement/ajuda comprovado** com skill real e Luna:
   [resultado e ressalvas](results/004-implement-help.md). Handoff de review precisa
   incluir diff exato e seleção de modelo válida; TDD em fatias verticais não foi
   garantida nesta execução. Afinar essas instruções antes de interpretar o smoke
   como garantia de conformidade metodológica.
3. Definir a porta e implementar **ambos** os adapters, Jira/GitHub Issues,
   conforme a elegibilidade confirmada na spec: ready-for-agent, unclaimed e sem
   bloqueios/dependências; no Jira, sprint atual e assignee operador. Verificar
   representações concretas de claim/dependências, workflow e integração PR.
4. Admissão com N, uma implementação ativa por repo, prioridades e deduplicação.
5. CLI mínima, feedback terminal/Jira/PR e monitor de CI/review/merge externo.
   Integrar o contrato needs_help e preservação de sessão/área já experimentados.
   Reviewers devem receber diff/refs explícitos, com modelos permitidos.
6. **Validar Docker** com Pi, extensões, skills, autenticação e persistência de
   sessão/área; smokes atuais noSandbox não são essa prova. Depois, tarefa real
   autorizada com os dois trackers, N=1 e N=2, medindo ganho/custo de configuração.

Sessão ausente, mudança de elegibilidade e claim após interrupção têm propostas
explícitas na spec, ainda para aprovação. Não são requisitos de microVM,
auditoria formal ou recuperação automática. A implementação depende também da
configuração dos projetos/repositórios autorizados, não de inferências sobre eles.
