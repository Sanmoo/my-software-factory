# Design e evidências — My Software Factory

A [spec do MVP](spec.md) é a fonte consolidada dos requisitos e das decisões
técnicas aprovadas; o [glossário](../GLOSSARY.md) define linguagem. Este documento
preserva contexto e aponta evidências, sem duplicar o contrato da spec.

## Contexto e decisões

- Script TypeScript local, com Sandcastle/Pi, para produtividade imediata,
  separado da plataforma definitiva com microVM e motor durável.
- Issue tracker por porta e adapters: **Jira e GitHub Issues desde o MVP**.
  Sprint/assignee são regras Jira, não campos universais do núcleo.
- Elegibilidade exige ready-for-agent, ausência de claim e de bloqueios/dependências;
  no Jira, também sprint atual e atribuição ao operador.
- **Docker é o runtime desejado do MVP.** noSandbox foi usado para reduzir
  variáveis nos primeiros testes, não como escolha operacional definitiva.
- Supervisão local e retomada manual; ampla autonomia, sem merge pelo agente
  nem deploy em produção. Ambos os trackers/Docker não são removidos para caber
  numa demonstração mais simples sem decisão do operador.

Registro inicial da entrevista:
[PKM, snapshot f651e75](https://github.com/Sanmoo/pkm/blob/f651e75/.scratch/sandcastle-laptop/spec.md).
Esse snapshot antecede as decisões finais de Docker e elegibilidade GitHub;
não deve substituí-las. As decisões técnicas aprovadas ficam na spec (§4),
sem ADR de adoção irreversível.

## Evidências e limites

- [003 — Pi, filho async e retomada](results/003-copilot-luna.md).
- [004 — /implement, ajuda real, resposta e review](results/004-implement-help.md).
- [002 — diagnóstico TLS Codex](results/002-tls-diagnosis.md), caminho opcional;
  o provider autorizado para os testes é github-copilot/gpt-6-luna.

Os dois smokes usaram noSandbox, não Docker. A skill funcionou operacionalmente
na fixture, mas houve limites de TDD e handoff de revisão, registrados no relatório.
Ainda não há prova de trackers, polling/N ou PR real.

Sandcastle fixado em 0.12.0 (gitHead e99f832f26dc9d245c019a9ddd19fa5dee792427);
a pesquisa inicial examinou 7a4e7f7d93056600d979d79a090256feddf653ea. Referências
antigas não provam a versão instalada. O perfil dentro de Docker precisa ser
validado, sem assumir transporte automático do ambiente do host.
