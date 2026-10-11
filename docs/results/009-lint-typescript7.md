# Avaliação 009 — lint com TypeScript 7 para a issue #13

Data: 2026-10-11. Repositório avaliado na base `cb08a57`, Node 22.23.2,
macOS arm64. [Issue #13](https://github.com/Sanmoo/my-software-factory/issues/13).
Esta é uma avaliação, **não a implementação ou aprovação da troca de ferramenta**.

## Conclusão

**Nenhum dos dois candidatos atende integralmente à #13 sem uma nova decisão.**
Ambos convivem com `typescript@7.0.2`, instalam com `npm ci --ignore-scripts` e
analisam os 97 arquivos `.ts` atuais de `src/` e `test/` sem erros de parsing.
Isso comprova viabilidade para o código atual, não suporte universal a toda
sintaxe de TypeScript 7 ou versões futuras. **A página oficial de suporte do
Biome ainda declara TypeScript 5.9** [18]; portanto não o apresentar como
oficialmente certificado para TS7.

**Recomendação: preferir Oxlint para este gateway de correção, condicionado aos
ajustes de contrato abaixo.** A configuração nativa de `correctness` em erro,
mais `typescript/no-explicit-any` e `eslint/no-empty`, produziu 8 diagnósticos no
código atual. O preset recomendado do Biome produziu 88, sobretudo regras de
estilo e asserções não nulas. As contagens não medem qualidade nem equivalência
entre os conjuntos; medem o custo inicial dos perfis efetivamente testados.

Biome continua viável se a preferência for seu preset, aceitando a revisão das
88 ocorrências e a configuração explícita de severidades. A pesquisa de fontes
favoreceu Biome quando o critério principal é conservar um preset chamado
recommended e a exigência nativa de motivo. A recomendação consolidada favorece
Oxlint quando o critério principal é um gateway enxuto de correção; não há
vencedor sem esses trade-offs. Nenhum autoriza troca silenciosa.

Há ainda uma alternativa não ensaiada: a Microsoft documenta executar TS7 lado
a lado com `@typescript/typescript6` para ferramentas que precisam da API antiga
[19]. Não é downgrade do typecheck, mas introduz dois compiladores e exige
validar a resolução do parser; está fora dos probes desta avaliação.

## Versões e compatibilidade

| Pacote consultado/instalado | Versão | Restrição relevante |
| --- | --- | --- |
| TypeScript do projeto | `7.0.2` | Preservado em `package.json` e lockfile |
| typescript-eslint estável consultado | `8.71.1` | TypeScript `>=4.8.4 <6.1.0`: exclui 7.0.2 [1] |
| Biome | `2.5.15` | Node `>=14.21.3`; sem dependência/peer de `typescript` [2] |
| Oxlint | `1.87.0` | Node `^20.19.0 || >=22.12.0`; sem peer obrigatório de `typescript` [3] |

Biome tem parser próprio e distribuição nativa; Oxlint implementa regras
nativamente em Rust [4][5]. O fato de uma regra Oxlint se chamar `typescript/*`
não significa que o pacote `typescript-eslint` esteja instalado. A instalação
de teste de Oxlint não incluiu `oxlint-tsgolint`: esse peer é opcional e só é
necessário para habilitar análise de tipos [3][6].

Não foi encontrada, nas fontes consultadas, uma promessa de compatibilidade
universal com a gramática inteira de TS 7 para estes perfis. O gate correto para
adotá-los aqui é a análise dos arquivos reais e fixtures, com versões travadas;
não a simples ausência de um peer de TypeScript. Os testes cobrem a sintaxe
presente na base indicada, não um catálogo completo de novidades de TS 7.

## Matriz frente à #13

| Requisito | Biome 2.5.15 | Oxlint 1.87.0 |
| --- | --- | --- |
| Preservar TypeScript 7 | Atende no código atual, observado | Atende no código atual, observado |
| Somente lint, sem formatador ou autofix | `biome lint`; formatter/assist desativados [7] | `oxlint`, sem flags de fix [5] |
| Analisar somente `.ts` em `src/` e `test/` | Atende com includes e argumentos explícitos | Atende com ignorePatterns e argumentos explícitos |
| Ignorar dependências/worktrees/fixtures/docs | Force-ignore; testado inclusive em subdiretórios [8] | ignorePatterns; testado inclusive em subdiretórios [9] |
| Detectar variável/import não usado | Atende; warnings no preset puro | Atende; erro no perfil testado |
| Detectar `any` explícito | Atende; warning no preset puro | Atende ao habilitar regra específica |
| Detectar código inalcançável/condição literal constante | Atende | Atende no conjunto de correção |
| Detectar catch vazio | Regra adicional, fora de recommended [10] | `eslint/no-empty`, habilitada explicitamente |
| Detectar todo catch que engole erro | Não: bloco com comentário é permitido [10] | Não: lint sintático não garante tratamento correto |
| Promessas não tratadas/condições dependentes de tipos | Fora do perfil sem tipos [11][12] | Fora do perfil sem tipos [13][14] |
| Todas as regras ativas em erro | Exige configurar regras individualmente; preset puro não atende | `categories.correctness: error` + regras explícitas atende |
| Suppressão específica com motivo | Aceita; motivo vazio é erro de parsing | Aceita; motivo não é obrigatório |
| Rejeitar suppressão genérica/de grupo/arquivo | Não nativamente no perfil avaliado [15] | Não nativamente no perfil avaliado [16] |
| Instalação só pelo lockfile, ignore-scripts | Atende no host testado | Atende no host testado |
| Respeitar todo o Node `>=22` documentado hoje | Atende | Parcial: exige elevar mínimo para 22.12 [3] |
| Um config curto com conjunto de base legível | Atende ao preset, mas não à severidade estrita sem lista | Atende ao conjunto correctness, que não é o recommended do ESLint [5] |

Os requisitos de `lint`, `verify`, parada no primeiro erro, README e ausência de
CI são independentes do candidato. Não foram implementados nem validados como
novo gateway nesta avaliação.

### O escopo original já precisa de esclarecimento

A abertura da #13 menciona promessas sem `await` e condições sempre verdadeiras,
mas as decisões excluem regras com type-check. `tsc --strict` **não substitui**
`no-floating-promises` ou a checagem de condições baseada em tipos: uma chamada
que retorna Promise pode passar no typecheck sem ser aguardada.

O contrato deve prometer apenas a cobertura do perfil escolhido. Se essas
checagens forem obrigatórias já nesta entrega, reabrir o escopo de análise de
tipos; não declarar que estão cobertas pelo linter sintático ou pelo compilador.
A regra Biome de floating promises ainda é nursery e requer o domínio `types`
[11]. A regra equivalente Oxlint requer `typeAware` e `oxlint-tsgolint` [6][13].
Nenhum desses caminhos foi habilitado ou avaliado aqui.

## Evidência local

### Instalação

No worktree isolado, a instalação documentada do projeto passou:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Resultado: TypeScript 7.0.2, typecheck exit 0, **362 testes passaram, 0 falharam**.
Um pacote de probe separado, descartável, instalou exatamente
`@biomejs/biome@2.5.15`, `oxlint@1.87.0` e `typescript@7.0.2`.
`npm install --ignore-scripts` gerou seu lockfile; `npm ci --ignore-scripts`
reinstalou e os três binários funcionaram sem scripts de instalação.
Os pacotes nativos da plataforma vieram de optionalDependencies [2][3].

Limite: instalação observada em macOS arm64, não em Linux/Windows, nem com
`--omit=optional`, que não faz parte da instalação documentada.

### Diagnósticos no código atual

Biome `preset: recommended`, sem domínios `project`/`types`, sobre `src test`:

| Categoria | Ocorrências | Severidade padrão |
| --- | ---: | --- |
| `style/noNonNullAssertion` | 59 | warning |
| `style/useTemplate` | 16 | information |
| `correctness/noUnusedImports` | 5 | warning |
| `suspicious/noImplicitAnyLet` | 4 | error |
| `complexity/useOptionalChain` | 3 | warning |
| `suspicious/noExplicitAny` | 1 | warning |
| **Total** | **88** | **4 errors, 68 warnings, 16 infos** |

Promover individualmente os recommended para `error` produziu 88 errors, zero
warnings/infos. Isso é possível, mas perde a configuração curta. Usar
`--error-on-warnings` não resolve o requisito: uma fixture só com `useTemplate`
continuou em exit 0, com um diagnóstico information [7].

**Não configurar grupos inteiros como `"error"` apenas para mudar severidade.**
No probe, isso também ativou regras não recomendadas, como `noConsole`.
A documentação descreve a configuração de grupo como habilitação do grupo [8].

Oxlint com `correctness: error`, `typescript/no-explicit-any: error` e
`eslint/no-empty: error`, plugins nativos padrão, sobre os mesmos 97 arquivos:

| Categoria | Ocorrências |
| --- | ---: |
| `eslint/no-unused-vars` (imports) | 5 |
| `typescript/no-explicit-any` | 1 |
| `unicorn/no-useless-spread` | 1 |
| `unicorn/no-invalid-fetch-options` | 1 |
| **Total** | **8 errors, 0 warnings** |

Diagnóstico de lint não é comprovação de bug: as ocorrências, sobretudo as que
inferem intenção ou opções de chamadas, ainda precisam de revisão antes de
corrigir ou suprimir. Não houve edição para fazê-las passar.

### Probes de comportamento

- Fixture limpa: exit 0.
- Biome recommended: variável não usada e `any` explícito emitiram warning,
  exit 0; código inalcançável e condição literal constante emitiram error.
- Oxlint no perfil descrito: variável não usada, `any` explícito, inalcançável e
  catch vazio deram exit 1 com arquivo, linha e regra.
- Chamada a função async sem tratamento e condição sobre union literal de
  strings passaram no perfil Biome sem tipos; a promessa também passou em
  Oxlint sem tipos.
- Biome `biome-ignore lint/suspicious/noExplicitAny: motivo` passou;
  `biome-ignore lint: motivo`, `biome-ignore lint/suspicious: motivo` e
  `biome-ignore-all lint: motivo` **também passaram**. Motivo vazio ou ausência
  de `:` produziram erro de supressão.
- Oxlint `oxlint-disable-next-line typescript/no-explicit-any -- motivo`
  passou; a variante genérica e a sem motivo **também passaram**.
- Fixtures com sintaxe inválida em diretórios ignorados, inclusive dentro de
  `src/`, não geraram erros de parsing. `.js` e `.tsx` ficaram fora; `.ts` em
  `src/` e `test/` foi analisado. Violação isolada em cada árvore deu exit 1.
- Os resultados foram conferidos por assertions Node (`assert/strict`), não
  apenas por inspeção do exit code do processo principal.

Erros do próprio harness (caminho incorreto, múltiplos configs raiz e invocation
`.` com includes positivos que não selecionavam a raiz) foram corrigidos antes
de obter as contagens acima. A invocação final usa **`src test` explicitamente**.
Falha de seleção de arquivos não foi contada como incompatibilidade de parser.

## Decisões necessárias antes de retomar a #13

Proposta condicionada para o operador:

1. **Escolher Oxlint nativo**, versão exata validada no momento da implementação,
   usando `correctness` em erro + `no-explicit-any` + `no-empty`; sem JS plugins,
   formatação, fix, análise de tipos ou `oxlint-tsgolint`.
2. **Elevar o mínimo de Node para 22.12**, coerente com o pacote avaliado. O host
   22.23.2 já atende; isso é alteração explícita do requisito, não automática.
3. **Manter supressões rigorosas**, autorizando um validador pequeno e central
   para comentários, chamado antes do linter no script `lint`. Isso relaxa a
   decisão original de não haver lógica de validação fora do config. Ambos os
   candidatos precisam de uma solução adicional para impedir supressões
   genéricas; Oxlint também precisa dela para exigir motivo. Não introduzir
   plugin JS alpha ou um segundo linter só para essa política [17].
4. **Definir a política verificável:** somente supressão de linha com nomes de
   regras explícitos e motivo não vazio; proibir supressões de arquivo/faixa e
   aliases que escapem à checagem. O guard deve analisar comentários reais, não
   regex sobre texto bruto, e cobrir comentários de bloco, múltiplas regras,
   aliases e tentativa de suprimir o próprio guard. Em Oxlint, desativar compatibilidade com
   `eslint-disable` e reportar diretivas sem efeito em erro [6][16]. O conteúdo
   substantivo do motivo continua responsabilidade da revisão humana.
5. **Explicitar limites sem type-aware:** promessas não tratadas e condições
   determinadas por tipos não são promessa desta entrega. Catch vazio é
   detectável; tratamento correto de toda exceção não é garantido. Aceitar ou
   rever também as exceções nativas das regras, como nomes unused iniciados em
   `_` e comentário comum em catch vazio [10][20]; elas não são diretivas de
   supressão e não devem ser apresentadas como sujeitas ao guard.
6. **Manter o restante:** TypeScript 7, scripts `typecheck`/`test` intactos,
   `verify` em sequência, apenas `.ts` de `src`/`test`, dependências travadas,
   correção revisada das violações, README atualizado, histórico preservado,
   gateway local sem CI.

Se a prioridade for preservar **um único config, sem qualquer guard adicional**,
então o requisito de rejeitar supressões genéricas precisa ser relaxado para
convenção de revisão humana, ou outra solução deve ser investigada. Não marcar a
#13 como pronta para retomada fingindo que Biome/Oxlint impõem essa política.

## Reprodução mínima dos pontos decisivos

Executar em área descartável **dentro do worktree da tarefa**, não no checkout
de integração. Usa binários locais, nunca uma instalação global ou latest.

```sh
mkdir lint-probe
cd lint-probe
printf '{"private":true,"type":"module"}\n' > package.json
npm install --ignore-scripts --save-dev --save-exact \
  @biomejs/biome@2.5.15 oxlint@1.87.0 typescript@7.0.2
npm ci --ignore-scripts
./node_modules/.bin/biome --version
./node_modules/.bin/oxlint --version
./node_modules/.bin/tsc --version
mkdir src test
```

Config `biome.json` para o probe (não configuração final aprovada):

```json
{
  "files": {
    "includes": [
      "src/**/*.ts", "test/**/*.ts",
      "!!**/node_modules", "!!**/.worktrees", "!!**/.smoke",
      "!!**/.pilot", "!!**/docs"
    ]
  },
  "formatter": { "enabled": false },
  "assist": { "enabled": false },
  "linter": {
    "domains": { "project": "none", "types": "none" },
    "rules": { "preset": "recommended" }
  }
}
```

Config `.oxlintrc.json` para o perfil de correção testado:

```json
{
  "categories": { "correctness": "error" },
  "rules": {
    "typescript/no-explicit-any": "error",
    "eslint/no-empty": "error"
  },
  "options": { "typeAware": false, "typeCheck": false }
}
```

Em `src/fixture.ts`, testar uma variante por vez; registrar código de saída,
regra e localização. Os comentários são parte dos exemplos a testar:

```ts
// Variante 1: warning no Biome, erro no perfil Oxlint
export function value(): number { const unused = 1; return 2; }

// Variante 2: aceita a supressão genérica no Biome
// biome-ignore lint: entrada legada validada externamente
export function value(input: any): unknown { return input; }

// Variante 3: aceita a supressão sem motivo no Oxlint
// oxlint-disable-next-line typescript/no-explicit-any
export function value(input: any): unknown { return input; }

// Variante 4: informação do Biome não falha com --error-on-warnings
export function value(name: string): string { return "hello " + name; }

// Variante 5: promessa não tratada passa sem type-aware
export async function value(): Promise<number> { return 1; }
value();
```

```sh
./node_modules/.bin/biome lint --error-on-warnings src test
./node_modules/.bin/oxlint -c .oxlintrc.json src test
```

Para reproduzir contagens, copiar `src/` e `test/` da base `cb08a57` para a área
(sobrescrevendo/removendo a fixture) e executar ambos com `--format=json` em
Oxlint ou `--reporter=json --max-diagnostics=none` em Biome. Para o experimento
de todos os recommended em erro, enumerar regras via schema instalado e
`biome explain`, promover **individualmente** as que são recommended e repetir.
Os arquivos de probe e JSONs são descartáveis; apenas este relatório é versionado.

## Fontes primárias

Consultadas em 2026-10-11; documentação online pode mudar depois destas versões.

1. [typescript-eslint: versões suportadas](https://typescript-eslint.io/users/dependency-versions/)
   e `npm view typescript-eslint@8.71.1 peerDependencies --json`.
2. [Metadados npm do Biome 2.5.15](https://registry.npmjs.org/@biomejs/biome/2.5.15),
   também conferidos no pacote instalado (engines, ausência de scripts/peer TS,
   optionalDependencies nativas com versão correspondente).
3. [Metadados npm do Oxlint 1.87.0](https://registry.npmjs.org/oxlint/1.87.0),
   conferidos no pacote instalado, inclusive peers opcionais e engines.
4. [Arquitetura do Biome](https://biomejs.dev/internals/architecture/).
5. [Configuração do Oxlint](https://oxc.rs/docs/guide/usage/linter/config.html).
6. [Referência de config Oxlint](https://oxc.rs/docs/guide/usage/linter/config-file-reference.html).
7. [CLI Biome: lint e tratamento de warnings](https://biomejs.dev/reference/cli/).
8. [Configuração Biome: grupos, presets, includes e force-ignore](https://biomejs.dev/reference/configuration/).
9. [Oxlint: ignore files](https://oxc.rs/docs/guide/usage/linter/ignore-files.html).
10. [Biome: noEmptyBlockStatements](https://biomejs.dev/linter/rules/no-empty-block-statements/).
11. [Biome: noFloatingPromises](https://biomejs.dev/linter/rules/no-floating-promises/).
12. [Biome: noUnnecessaryConditions](https://biomejs.dev/linter/rules/no-unnecessary-conditions/).
13. [Oxlint: no-floating-promises](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-floating-promises.html).
14. [Oxlint: no-unnecessary-condition](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unnecessary-condition.html).
15. [Biome: suppressions](https://biomejs.dev/analyzer/suppressions/).
16. [Oxlint: inline ignore comments](https://oxc.rs/docs/guide/usage/linter/ignore-comments.html).
17. [Oxlint: JS plugins, ainda alpha](https://oxc.rs/docs/guide/usage/linter/js-plugins.html).
18. [Biome: suporte de linguagem publicado, TS5.9](https://biomejs.dev/introduction/language-support/).
19. [Microsoft: TypeScript 7 e execução lado a lado com TS6](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
20. [Oxlint: no-empty](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-empty)
    e [source na tag 1.87.0](https://raw.githubusercontent.com/oxc-project/oxc/oxlint_v1.87.0/crates/oxc_linter/src/rules/eslint/no_empty.rs).
