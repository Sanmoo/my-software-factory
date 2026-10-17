# O perfil de runtime converge fora do container, uma vez, num diretório persistente sob o `--home` (pacotes por perfil, dados do mise compartilhados)

O ADR 0002 resolve o perfil Pi do operador **no host** e monta no container só um retrato de
arquivos reais. Só que o container antigo ainda *instalava* o perfil a cada start: `pi install` de cada
pacote declarado no `settings.json` e o download de `ripgrep`/`fd` pelo próprio Pi quando faltavam na
imagem. Todo start pagava o cold start (cerca de 100 s no primeiro, sem contar o que o Pi baixava por
conta própria), e as ferramentas que o operador declara no mise **não existiam** no container — o
`pi-rtk-optimizer` avisa que o binário `rtk` não está no caminho.

A decisão é que o perfil **converge**, não instala: a primeira invocação de um perfil instala, as
seguintes não instalam nada e funcionam sem rede.

1. O retrato passa a carregar também o `npm/package.json` e o `npm/package-lock.json` do perfil e a
   declaração de mise do operador (`mise/config.toml`, vinda de `local.json`). Continua valendo o
   ADR 0002: só arquivos reais, links resolvidos nas raízes permitidas, e `node_modules` nunca é
   copiado (carrega os bindings da plataforma do host).
2. O container monta dois diretórios persistentes sob o `--home` da factory, criados pelo host como o
   usuário que invoca antes de o container subir, **com dois tempos de vida deliberados** (spec #74):
   - a **árvore de pacotes do Pi é POR PERFIL** (`<home>/toolchains/<perfil>/npm` em
     `/home/agent/.pi/agent/npm`): perfis declaram pacotes diferentes, e cada um tem a sua árvore;
   - o **diretório de dados do mise é COMPARTILHADO por todos os perfis** (`<home>/toolchains/mise` em
     `/home/agent/.local/share/mise`): installs, downloads, cache e estado num só diretório por
     `--home`, então uma ferramenta já instalada por um perfil não é baixada de novo pelo outro — e o
     **mesmo `flock`** serializa a convergência de todos os perfis entre si.

   **Bind, não volume nomeado do Docker:** um volume novo nasce do root, e o container roda como o
   usuário do host.
3. Os pacotes do Pi convergem com `npm ci --legacy-peer-deps` a partir do lock do host, com um **selo**
   cujo conteúdo é o hash do `package.json` e do `package-lock.json` mais o ABI do Node da imagem
   (`process.versions.modules`). Selo igual não instala nada e **não imprime nada**. O selo sai antes
   do install e volta só depois do sucesso, então um install interrompido é refeito no start seguinte.
   A instalação usa o npm e o Node da própria imagem (`IMAGE_PATH`, antes dos shims), para que um
   `node` declarado no mise não sombree o npm que instalou o Pi nem mude o ABI do selo. O selo é por
   perfil (a árvore também é): uma mudança no lock de um perfil reinstala só aquele perfil.
4. As ferramentas do mise convergem pelo mesmo caminho: sonda silenciosa e rápida
   (`mise install --dry-run-code`), e só se faltar algo `mise install --yes`; installs, downloads,
   cache e estado no diretório persistente **compartilhado**, e os shims na frente do `PATH`. O que
   cada perfil instala continua vindo da **sua** declaração (montada somente leitura no retrato); o
   diretório de dados é que é comum. Ambos os installs rodam sob `flock`, então duas invocações
   simultâneas não instalam por cima uma da outra: a segunda espera, relê o selo e não instala.
5. A convergência é **estrita**: falha de um item obrigatório interrompe a invocação com o motivo,
   antes de o agente receber o prompt. Não existe o modo fail-open do `safe-pi` (avisar e seguir com
   o que há): o perfil declara o que o trabalho precisa, e sem isso o trabalho não roda. `./msf check`
   só **relata** o estado da toolchain, nunca repara.
6. `ripgrep` e `fd` entram na imagem (`fd-find` é o nome Debian; o link para `fd` é o que o Pi
   sonda), então o Pi para de baixá-los a cada start.
7. A base passa de `node:22-bookworm-slim` para `node:22-trixie-slim`. A declaração do operador é
   `latest` em quase tudo, e as ferramentas que ela instala trazem builds ligados à glibc: o próprio
   container do `safe-pi` registra `rtk` exigindo `GLIBC_2.39` (bookworm tem 2.36). Verificado neste
   host: o `rtk` 1.0.1 atual baixa como binário musl e roda também no bookworm; mas o contrato vale
   para o `latest` de amanhã, para outras ferramentas da declaração e para `linux/arm64`, e o trixie
   (glibc 2.41) satisfaz os três casos sem trocar a linha do Node (o ABI do Node 22 é o mesmo, 127).
   Os ajustes de OTP valem só no sandbox e ficam no `ENV` da imagem: alvo pré-compilado (`ubuntu-22.04`)
   e recusa de compilar do código-fonte, para um pin de Erlang não baixar 100 MB a cada start numa
   imagem Debian. No host, essas duas variáveis quebrariam o próximo install de OTP.
8. As ferramentas obrigatórias de `config.json` (`required.tools`, nomes simples como `rtk`) são
   confirmadas no `PATH` do container depois da convergência; sem uma delas, a invocação é
   interrompida com o nome.

Motivo: a técnica não é nova — está provada no wrapper `safe-pi` do checkout de dotfiles do operador
(ADRs 0002 e 0009 de lá: volume de toolchain convergido dentro do container, árvore de pacotes do Pi
instalada a partir do lock do host com selo por hash do lock mais ABI do Node, `flock` na
convergência). O MSF adota o mesmo contrato, com duas diferenças deliberadas: diretório **bind** (por
perfil para os pacotes, compartilhado para os dados do mise) em vez de volume compartilhado, e
convergência **estrita** em vez de fail-open.

## Considered Options

- **Continuar com `pi install` a cada start.** Rejeitado: é o próprio cold start da #74 e instala as
  versões não fixadas do `settings.json`, então o container pode rodar diferente do host.
- **Deixar o Pi instalar sozinho o que falta** numa árvore vazia (o Pi instala um pacote ausente no
  start). Rejeitado como mecanismo, pelo mesmo motivo do `safe-pi`: as versões do `settings.json` não
  são as do lock. Fica como rede de segurança quando a convergência falha num pacote não obrigatório.
- **Camada de imagem por perfil com os pacotes embutidos.** Rejeitado: exige rebuild a cada mudança no
  perfil e não acompanha os pins `latest` da declaração.
- **Volume nomeado do Docker para a árvore de pacotes.** Rejeitado: um volume novo nasce do root e a
  árvore fica aninhada dentro do bind do diretório do agente; a propriedade deixa de ser verificável.
- **Montar o binário do host (mise, `~/.local/bin`) dentro do container.** Rejeitado: uma imagem
  Debian rodaria binário do host, e o caminho do operador vira dependência oculta do container.
- **Um volume (ou diretório) de toolchain único para os perfis.** Rejeitado para os **pacotes do Pi**:
  perfis de trabalho e pessoais declaram conjuntos de pacotes diferentes, e um diretório por perfil
  evita que a convergência de um troque a árvore do outro. Para os **dados do mise** o compartilhamento
  é a decisão da spec #74 — a declaração (o que instalar) continua por perfil, e o que muda é só onde o
  mise guarda installs, downloads, cache e estado.
- **Convergência fail-open, como o `safe-pi`.** Rejeitado: o trabalho depende do que o perfil declara;
  seguir sem um item obrigatório produziria uma execução que parece válida e não é.

## Consequences

- O primeiro start de um perfil é o caro (pacotes + ferramentas); os seguintes são silenciosos e não
  precisam de rede. Uma mudança no lock reinstala só naquele perfil; uma imagem com outro Node major
  reinstala pelo ABI do selo. Como os dados do mise são compartilhados, uma ferramenta já instalada por
  outro perfil daquele `--home` também não é baixada de novo.
- O diretório persistente é estado do host sob o `--home`, e nunca apagado por uma invocação que
  falha: a árvore de pacotes é compartilhada pelas instâncias que nomeiam o mesmo perfil, e o
  diretório de dados do mise por **todos os perfis daquele `--home`** (mesma trava para todos).
- A declaração de mise do operador é montada somente leitura dentro do retrato; nada do host é
  montado como binário. `pi install`, `update` e `remove` dentro do container continuam funcionando
  contra a árvore persistente, mas o lock do host segue sendo a fonte de verdade: o próximo start
  reconverge pelo selo.
- A imagem passa a exigir `mise`, `ripgrep` e `fd`; `./msf check` falha nomeando o que falta e manda
  reconstruir. A checagem não repara nada.
- O `rtk` existe no `PATH` do container e o aviso do `pi-rtk-optimizer` desaparece.
