# Próximos passos

1. **Bloqueador:** resolver `fetch failed` do provider openai-codex ou obter decisão
   explícita de outro provider/modelo. Repetir o mesmo teste headless, sem fallback
   de modo de execução, e comprovar delegação + retomada antes do piloto real.
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
