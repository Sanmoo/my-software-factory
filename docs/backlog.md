# Próximos passos

1. **Bloqueador com causa identificada:** o endpoint chatgpt.com entrega
   certificado Fortinet cuja cadeia não é validada neste ambiente; erro Node
   UNABLE_TO_VERIFY_LEAF_SIGNATURE. [Diagnóstico](results/002-tls-diagnosis.md).
   Confirmar o provider/modelo do piloto: a sessão interativa usa github-copilot,
   mas o teste inicial escolheu openai-codex. Não trocar silenciosamente.
   Para continuar Codex, obter CA/configuração oficial da rede com o responsável;
   não desabilitar TLS nem confiar no certificado apresentado por conta própria.
   Depois da decisão, repetir o mesmo protocolo e comprovar delegação + retomada.
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
