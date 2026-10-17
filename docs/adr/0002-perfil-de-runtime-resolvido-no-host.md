# O perfil de runtime é resolvido no host e o container recebe só o retrato

O container reproduz o perfil Pi do operador, mas não o monta diretamente. Antes do
claim, o orquestrador percorre o perfil no host e resolve os links em todos os níveis,
aceitando só destinos dentro das raízes permitidas daquele perfil. O resultado é gravado
como um retrato com arquivos reais, e o container monta só esse retrato, somente leitura.
Itens obrigatórios ausentes, quebrados, cíclicos ou fora das raízes bloqueiam a admissão
(fail fast). Os demais itens nessa situação são pulados, e o log da invocação lista o
que entrou e o que ficou de fora. Já dentro do container, depois de instalar os pacotes
e antes do prompt, uma checagem confirma os pacotes e as ferramentas obrigatórios; se
falhar, a invocação é interrompida com o motivo.

A divisão da configuração segue a regra que já existe: o `config.yaml` guarda o quê
(pacotes, skills e agents obrigatórios, exclusões como `npm:pi-lens`), que é igual em
qualquer máquina; o `local.yaml` guarda o onde (diretório do perfil e raízes permitidas),
que são caminhos do host.

Motivo: o runner montava `~/.pi/agent` e `~/.agents` e copiava no container com
`cp -RL`, pulando com aviso o que não resolvia. Os perfis são cadeias de links em vários
níveis (`~/.pi-deere/agent` → `~/.pi/agent` → `~/.agents` → dotfiles e repositórios de
trabalho), e a fronteira entre pessoal e trabalho não segue diretórios: `~/.agents/skills`
mistura os dois. Sem o dotfiles montado, o `settings.json` nunca chegou ao container. Sem a
lista de pacotes, o `pi-subagents` não foi instalado, e o `/implement` rodou sem reviewers
separados, mas declarou os reviews aprovados. Um link cíclico criado depois derrubou um
trabalho já admitido no setup do container.

## Considered Options

- **Montar as raízes dos links e seguir os links no container:** rejeitado porque a
  fronteira volta a depender de quais diretórios estão montados, ciclos e links quebrados
  só aparecem depois do claim, e a regra fica num shell script sem testes.
- **Só uma lista de itens permitidos, sem reproduzir o perfil:** rejeitado por enquanto,
  porque o operador trabalha com o próprio perfil e quer o mesmo comportamento no
  container. Os obrigatórios cobrem o mínimo que a factory precisa.
- **Pacotes instalados numa camada da imagem por perfil:** adiado. Resolveria o cold
  start (cerca de 100 s por container), mas exige rebuild a cada mudança no perfil.

## Consequences

- A checagem dentro do container roda depois do claim. O custo da instalação de pacotes
  não justifica um container extra antes da admissão; o que o host consegue verificar é
  verificado antes.
- Uma skill pessoal que aponta para um repositório fora das raízes permitidas some do
  container. Se for obrigatória, a admissão é bloqueada e o motivo diz qual link e qual
  destino.
