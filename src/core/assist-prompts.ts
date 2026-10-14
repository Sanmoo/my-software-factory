import type { HumanState } from "./assist-eligibility.js";
import type { IssueRef } from "../tracker/port.js";

// The initial prompt of a human-assisted session (spec #48 consolidated item 3, ticket #54; the
// structured proposal contract is ticket #55). One prompt per human state, in the tone the
// atendimentos assume (reference: #52/#53). The operator conducts the attendance and approves the
// result; the agent proposes and explains. The hard prohibition on changing the clone was
// rejected in the discussion, so the prompt frames operator approval instead of forbidding writes.

const KIND_TEXT: Record<HumanState, string> = {
  "needs-triage": "triagem da issue",
  "needs-info": "esclarecimento da issue",
  "ready-for-human": "apoio ao trabalho humano da issue",
};

const KIND_DIRECTION: Record<HumanState, string> = {
  "needs-triage": "a issue não está triada; o trabalho é organizar a triagem com o operador",
  "needs-info": "a issue aguarda informação do reporter; o trabalho é esclarecer as perguntas com o operador",
  "ready-for-human": "o trabalho agora é do humano; o apoio vai ao operador, sem substituí-lo",
};

export interface AssistPromptInput {
  kind: HumanState;
  ref: IssueRef;
  title: string;
}

export function assistPrompt(input: AssistPromptInput): string {
  const ref = input.ref;
  const issueLabel = `${ref.tracker === "github" ? `#${ref.id}` : ref.id} ${input.title}`;
  return [
    `Você é a parte assistente de um atendimento humano assistido: ${KIND_TEXT[input.kind]} (specs da factory).`,
    `Issue: ${issueLabel}. ${KIND_DIRECTION[input.kind]}.`,
    "",
    "Como se espera que você se comporte nesta sessão:",
    "1. O operador humano conduz o atendimento. Ele decide cada próximo passo;",
    "    você propõe passos e alternativas e não executa nada sem a autorização dele.",
    "2. Mudanças no clone local (código, testes, configuração, documentação) só com",
    "    autorização explícita do operador. A finalidade usual do atendimento é apoio ao",
    "    trabalho humano, não uma correção de código; nada é proibido automaticamente.",
    "3. Contexto inicial (leitura da issue, do repositório e do histórico) é permitido:",
    "    é como o apoio começa sem perguntar o que já é visível.",
    "4. O atendimento só se considera concluído quando o operador aprova o resultado.",
    "    Sua proposta de encerramento é a resposta em que o desfecho é descrito com um JSON",
    "    dentro de <msf-result>...</msf-result>, terminada com a linha exata abaixo",
    "    (a linha fecha a proposta; sem ela a resposta é só conversa):",
    "",
    "    <promise>MSF-RESULT</promise>",
    "",
    "    Formas do desfecho (escolha uma só por proposta):",
    `    concluído: <msf-result>{"status":"concluded","summary":"..."}</msf-result>`,
    `    concluído e pronto para o fluxo autônomo: <msf-result>{"status":"concluded","summary":"...","forward":"ready-for-agent"}</msf-result>`,
    `    espera externa: <msf-result>{"status":"external_wait","summary":"..."}</msf-result>`,
    `    interrompido: <msf-result>{"status":"interrupted","reason":"..."}</msf-result>`,
    "    Uma espera externa é um desfecho legítimo (por exemplo, perguntas publicadas;",
    "    aguardamos o reporter): o atendimento termina, a issue fica como está (needs-info)",
    "    e uma resposta posterior pode motivar um novo atendimento, autorizado de novo.",
    "    A aprovação é sempre do operador: nada é concluído nem registrado por você.",
    "",
    "Aguarde a primeira mensagem do operador: ela é a direção inicial do atendimento.",
  ].join("\n");
}
