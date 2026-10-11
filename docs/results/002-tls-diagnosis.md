# Diagnóstico 002 — confiança TLS no endpoint Codex

Data: 2026-10-11. Somente inspeção de transporte/certificados públicos; sem
credenciais, chamada a modelo, alteração de trust store ou troca de provider.

## Conclusão

A chamada HTTPS Node ao endpoint padrão openai-codex falha na validação TLS:
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `unable to verify the first certificate`.
O certificado apresentado para chatgpt.com é emitido por **Fortinet**, não pela
cadeia pública esperada de uma conexão direta ao serviço. Há inspeção TLS nesse
caminho; a cadeia apresentada não pode ser validada no ambiente inspecionado.
Não é falha de prompt, concorrência, delegação ou retomada. Nenhum desses passos
foi alcançado no teste inicial.

## Repro mínima e resultados

HEAD sem Authorization nem payload em
`https://chatgpt.com/backend-api/codex/responses`:

- DNS resolve IPv4 e IPv6 normalmente.
- Node 22.23.2, fetch padrão: falha em aproximadamente 180 ms, código acima.
- Mesmo fetch com `node --use-system-ca`: mesma falha (~527 ms).
- curl 8.7.1/SecureTransport: erro TLS, HTTP 000, sem resposta utilizável.
- Node HEAD para registry.npmjs.org, api.github.com e www.google.com:
  HTTP 200 (~418–556 ms). Não é indisponibilidade geral de DNS/internet/Node.
- Variáveis HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY, NODE_OPTIONS,
  NODE_EXTRA_CA_CERTS e NODE_TLS_REJECT_UNAUTHORIZED estavam ausentes.

Comando mínimo, reproduzido durante a investigação:

```sh
node --input-type=module - <<'JS'
try {
  const res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'HEAD', signal: AbortSignal.timeout(10000),
  });
  console.log({ status: res.status });
} catch (error) {
  console.log({ message: error.message, code: error.cause?.code });
  process.exitCode = 1;
}
JS
```

Use `node --use-system-ca --input-type=module` para a comparação realizada.
Um HTTP 401/403 ainda seria sucesso de transporte; aqui a falha antecede HTTP.

## Certificado público e trust stores

Inspeção `openssl s_client -showcerts`, sem HTTP ou credenciais:

- Um certificado apresentado, subject CN=chatgpt.com, issuer O=Fortinet.
- Validade 2026-09-20 a 2026-12-19: o erro não foi expiração do leaf.
- SHA-256 D6:ED:BF:B7:48:69:03:EF:8E:DE:5C:14:B2:91:B3:D7:
  63:4D:13:7C:4C:F8:5E:35:E5:17:13:F6:BC:5D:06:DA.
- OpenSSL: unable to get local issuer certificate; verify return code 21.
- Consulta direcionada pelo nome do emissor não encontrou seu certificado nos
  keychains System, Apple roots e login. Não é varredura exaustiva de confiança
  nem prova de como a rede deve ser configurada; nenhum keychain foi alterado.
- Certificado público preservado em `.smoke/network/presented-0.pem`, ignorado.
  Não foi instalado ou usado como CA confiável.

## Escolha do provider do teste

O experimento inicial escolheu openai-codex/gpt-6.1-sol por disponibilidade de
modelo/autenticação. A sessão interativa expõe agora PI_PROVIDER=github-copilot.
Não foi comprovado que Codex era o provider corrente na preparação inicial.
Esse teste não é teste do endpoint Copilot. Ter auth ready não implica
conectividade, e dois providers com o mesmo model ID não são intercambiáveis
para diagnóstico de transporte. O script agora exige SMOKE_MODEL explícito.

## Caminhos legítimos para continuar

1. Confirmar com o operador se o piloto deve usar seu provider habitual Copilot;
   se autorizado, usar o mesmo protocolo de teste com seleção explícita, sem
   chamar essa mudança de correção do TLS Codex.
2. Se Codex for necessário, obter do responsável pela rede a configuração/CA
   oficial e a orientação de confiança adequada. Não desabilitar verificação
   TLS nem extrair confiança automaticamente do endpoint interceptado.

Causa exata da política Fortinet e configuração desejada da rede não foram
apuradas. Não se contornou filtro por IP, proxy, VPN ou trust store. O falso
sinal de conclusão Sandcastle é problema separado, já rejeitado pelo gate
([teste 001](001-pi-compatibility.md)).
