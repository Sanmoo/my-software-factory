# Próximos passos

A [spec do MVP](spec.md) está aprovada, inclusive as decisões técnicas P01–P05.
Docker, ambos os trackers, todos os alvos do §7 e as duas instâncias são escopo
confirmado; não substituir esse recorte pelos smokes noSandbox. Tickets vão para
as GitHub Issues de `Sanmoo/my-software-factory`.

Já comprovado (noSandbox):

- **Compatibilidade mínima** com github-copilot/gpt-6-luna:
  [resultado](results/003-copilot-luna.md). Codex/CA Fortinet é pendência
  opcional ([diagnóstico](results/002-tls-diagnosis.md)); não desabilitar TLS.
- **Round-trip implement/ajuda** com skill real e Luna:
  [resultado e ressalvas](results/004-implement-help.md). Handoff de review
  precisa de diff exato e modelo válido; TDD vertical não foi garantida.

Ordem de ataque:

1. **Em paralelo:**
   - **Spike Docker (CA08):** Pi, pi-subagents, skills, extensões, auth Copilot
     por instância e token GitHub por projeto dentro do container; filho async,
     ajuda e retomada com sessão/área persistentes. Se exceder o envelope
     combinado, devolver o trade-off ao operador antes de seguir.
   - **Núcleo com adapters de teste (§6.1):** configuração de instâncias e alvos,
     roteamento, elegibilidade, identidade/deduplicação, vagas, prioridade,
     contrato de resultado, feedback.
2. **Adapters reais:** Jira Cloud e GitHub Issues, com claim, bloqueios,
   transições, marcador e `agent:`; adapter de PR github.com. Conformidade
   contra alvo autorizado (§6.2).
3. **CLI e acompanhamento de PR:** status/logs/reply/resume/pause/unpause/release,
   monitor de CI/review/merge externo, done no tracker.
4. **Piloto (CA16):** todos os alvos configurados, N=1 e depois N=2, ao menos uma
   tarefa real autorizada, medindo ganho e custo de configuração.

A implementação depende da configuração dos projetos/repositórios autorizados,
não de inferências sobre eles.
