# Próximos passos

1. **Compatibilidade mínima comprovada** com provider/modelo autorizado
   github-copilot/gpt-6-luna: [resultado](results/003-copilot-luna.md).
   Manter provider/modelo explícito e modelo barato nos próximos testes.
   Codex/CA Fortinet é pendência opcional, não bloqueador do caminho Copilot;
   [diagnóstico](results/002-tls-diagnosis.md). Não desabilitar TLS.
2. Testar pedido de ajuda, resultado estruturado e insumos TDD/review de `/implement`;
   preservar área/sessão em bloqueio. Não iniciar o orquestrador completo antes disso.
3. Refinar porta de issue tracker e critérios GitHub Issues (não exige sprint Jira).
   Implementar adapters Jira/GitHub, transições e configuração por projeto/repo.
4. Admissão com N, uma implementação ativa por repo, prioridades e deduplicação.
5. CLI mínima, feedback terminal/Jira/PR e monitor de CI/review/merge externo.
6. Validar uma tarefa real, medir atenção economizada e custo de configuração.

Antes de operação real: resolver sessão ausente, elegibilidade retirada,
produção indireta e interrupção de processos. Não são requisitos de microVM,
auditoria ou recuperação automática; são decisões operacionais ainda abertas.
