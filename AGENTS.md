# Instruções para agentes (Codex, Claude Code e outros)

Este arquivo vale para **qualquer agente de IA** que trabalhe neste repositório.
O `CLAUDE.md` só importa este arquivo, então mantenha as regras **aqui**.

## O projeto

**Vai de Manu**: central de corridas tipo Uber para cidade pequena. Passageiro e motorista conversam com
o **WhatsApp da central** (Evolution API); o sistema calcula o preço e chama o motorista mais perto.
O administrador acompanha tudo no painel web. Detalhes no `README.md`.

| Arquivo / pasta | O que é |
|---|---|
| `server.js` | Servidor HTTP em Node.js puro (sem Express): rotas, painel, webhook da Evolution |
| `lib/bot.js` | Conversa do WhatsApp (passageiro, motorista, cadastro) |
| `lib/db.js` | Postgres; cria e migra as tabelas sozinho |
| `lib/geo.js` | Distância e geocodificação de endereços |
| `lib/whats.js` | Envio de mensagens pela Evolution API |
| `lib/mercadopago.js`, `lib/relatorio.js`, `lib/tipos.js` | Pix, relatórios, tipos de veículo e preço |
| `public/` | Páginas sem framework e sem build (início, painel, área do motorista) |

Dependências: só `pg` e `qrcode`. **Não adicione bibliotecas ou frameworks sem pedir ao dono.**

## Comandos

```bash
npm install
DATABASE_URL=postgres://... ADMIN_SENHA=teste node server.js   # porta 3000
```

- Sem `EVOLUTION_URL`, as mensagens que seriam enviadas aparecem no log: use isso para testar o bot
  sem mandar WhatsApp de verdade.
- Ainda **não há testes automatizados**. No mínimo, rode `node --check` em cada arquivo alterado.
  Ao mexer em regra de preço, distribuição de chamadas ou no bot, prefira criar testes com `node:test`
  em `test/` para as funções puras.

## Regras do código

- **Fuso horário:** a cidade usa `America/Campo_Grande` (definido no `Dockerfile`). Relatórios e
  "hoje" devem usar esse fuso.
- **Banco:** mudanças de tabela entram como migração idempotente em `lib/db.js`
  (`CREATE ... IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). Nunca apague corridas, passageiros ou motoristas.
- **Bot do WhatsApp:** os comandos do motorista (`ONLINE`, `ACEITAR`, `CHEGUEI`, `INICIAR`, `FINALIZAR`,
  `CANCELAR`...) e o fluxo do passageiro estão documentados no `README.md`. Se mudar algum, atualize o
  README no mesmo PR. Saudações não podem ser tratadas como endereço.
- **Webhook:** a rota da Evolution confere o `WEBHOOK_TOKEN`. Nunca remova essa checagem.
- **Privacidade:** a localização de passageiros e motoristas é sensível (ver seção do README).
  Não exponha localização fora do necessário para a corrida.
- **Cuidado com o WhatsApp:** evite envio em massa ou repetitivo (risco de banimento do número).
- **Idioma:** código, textos, commits e PRs em **português do Brasil**, seguindo o estilo existente.

## Fluxo de trabalho (equipe: dono + Claude Code + Codex)

- **Nunca** faça push direto na `main`. A `main` é publicada automaticamente pelo Easypanel.
- Uma tarefa = uma branch (`feat/...`, `fix/...`) = um Pull Request pequeno.
- Descreva no PR, em português simples: **o que mudou, por que, e como o dono pode testar**.
- Se a mudança exigir ação manual (variável nova no Easypanel, configuração na Evolution), escreva isso
  em destaque no PR.
- Quem não fez a tarefa revisa o PR (`@codex review` no GitHub, ou pedir ao Claude Code). O dono faz o merge.
- **Segredos:** nunca colocar chaves, tokens ou senhas no código ou em PRs. Tudo vem de variáveis de
  ambiente (`DATABASE_URL`, `EVOLUTION_*`, `WEBHOOK_TOKEN`, `ADMIN_SENHA`, `MP_ACCESS_TOKEN`...).
