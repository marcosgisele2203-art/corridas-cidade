# Central de Corridas pelo WhatsApp

Sistema de corridas tipo Uber para cidade pequena. O passageiro pede o carro **pelo WhatsApp** da central, o sistema
calcula o preço e chama o motorista mais perto, que aceita **também pelo WhatsApp**. Ninguém precisa instalar aplicativo.
O administrador acompanha tudo num painel web (funciona no celular).

Usa a mesma estrutura do Naturalle: **Easypanel + Postgres + Evolution API**.

## Como funciona

**Passageiro** (manda mensagem para o número da central)

```
Passageiro: oi
Central:    Olá Maria! 🚗 Envie sua localização 📍 ou digite o endereço
Passageiro: [localização]                         (ou "Rua X, 123")
Central:    Para onde você vai?
Passageiro: [localização] / Rodoviária
Central:    Saída / Destino / 2,9 km / R$ 11,00 · Confirma? 1 Sim 2 Não
Passageiro: 1
Central:    🔎 Procurando motorista...
Central:    ✅ Pedro Lima · Onix branco XYZ9K87 · chega em ~9 min
Central:    📍 Pedro chegou!
Central:    🏁 Corrida finalizada: R$ 11,00 · avalie de 1 a 5
```

A qualquer momento o passageiro pode mandar **CANCELAR** (até a corrida começar).

**Motorista** (o número dele é cadastrado no painel; ele conversa com o mesmo WhatsApp da central)

| Mensagem | O que faz |
|---|---|
| `ONLINE` / `OFFLINE` | começa / para de receber corridas |
| localização 📍 | atualiza onde ele está (melhor: **localização em tempo real**, assim recebe sempre a corrida mais perto) |
| `1` ou `ACEITAR` · `2` ou `RECUSAR` | responde a chamada |
| `CHEGUEI` | avisa o passageiro que chegou |
| `INICIAR` | passageiro embarcou |
| `FINALIZAR` ou `FINALIZAR 15` | encerra a corrida (com o valor, se for diferente do combinado ou no taxímetro) |
| `CANCELAR` | desiste da corrida aceita; o sistema procura outro motorista |
| qualquer outra coisa | mostra a lista de comandos |

### Distribuição das chamadas

1. A corrida vai para o motorista **online, livre e mais perto** da saída (pela última localização dele).
2. Ele tem **40 segundos** (configurável) para aceitar. Se recusar ou não responder, vai para o próximo.
3. Se todos estiverem ocupados, o sistema continua tentando por até 5 minutos.
4. Sem ninguém disponível, o passageiro é avisado e o **WhatsApp do administrador** recebe um alerta.

Só um motorista recebe a chamada por vez; dois motoristas nunca ficam com a mesma corrida.

### Preço

`taxa base + km × valor por km`, nunca abaixo do mínimo, arredondado para cima de 50 em 50 centavos.
Padrão: R$ 5,00 + R$ 2,00/km, mínimo R$ 8,00. A distância é a linha reta × 1,3 (aproxima o caminho pelas ruas).

- Quando o passageiro manda **localização**, o preço sai na hora.
- Quando **digita o endereço**, o sistema procura no OpenStreetMap dentro da cidade configurada. Se não achar, a corrida
  vai "no taxímetro" e o motorista informa o valor no fim (`FINALIZAR 15`).

A **comissão** da central (padrão 10%) é calculada em cada corrida e aparece no relatório por motorista.
O pagamento é feito direto ao motorista (dinheiro ou Pix).

## Painel (`/painel`)

| Aba | O que tem |
|---|---|
| **Corridas** | corridas do dia ao vivo (atualiza sozinho), botão de cancelar, link do WhatsApp do passageiro |
| **Motoristas** | cadastro (nome, WhatsApp, carro, placa), ativar/desativar, pôr online/tirar do ar, nota média |
| **Relatório** | corridas, faturamento e **comissão a receber de cada motorista** no período |
| **Configurações** | nome da central, cidade, preços, comissão, tempo para aceitar, WhatsApp do administrador, abrir/fechar a central |

## Instalação no Easypanel

Pode ficar no mesmo projeto do Naturalle, mas use **outro número e outra instância** da Evolution.

### 1. Postgres
**+ Service → Postgres**. Anote o *Internal connection URL*
(ex.: `postgres://postgres:SENHA@corridas_postgres:5432/corridas`). As tabelas são criadas sozinhas.

### 2. App
**+ Service → App**, fonte **GitHub**: este repositório, branch `main`, build por **Dockerfile**. Em *Environment*:

```
DATABASE_URL=postgres://postgres:SENHA@corridas_postgres:5432/corridas
EVOLUTION_URL=https://sua-evolution          (sem barra no final)
EVOLUTION_INSTANCE=corridas
EVOLUTION_APIKEY=apikey-da-evolution
WEBHOOK_TOKEN=uma-senha-forte-qualquer
ADMIN_SENHA=senha-do-painel
```

Em *Domains*, aponte o domínio (ex.: `corridas.seudominio.com`) para a porta **3000** e clique em **Implantar**.
Nos logs deve aparecer `Central de corridas no ar na porta 3000`.

### 3. Evolution API
1. Crie a instância `corridas` e leia o QR com o celular do **número da central** (um chip só para isso).
2. Em *Webhook* da instância:
   - URL: `https://corridas.seudominio.com/webhook/evolution?token=MESMO_WEBHOOK_TOKEN`
   - Evento: **`MESSAGES_UPSERT`**
   - Ligado: *Enabled*. Não precisa de *Webhook Base64*.

### 4. Primeiro uso
1. Abra `https://corridas.seudominio.com/painel` e entre com a `ADMIN_SENHA`.
2. **Configurações**: nome da central, cidade (ex.: `Bonito, MS`), preços, comissão e seu WhatsApp para alertas.
3. **Motoristas**: cadastre cada motorista com o WhatsApp dele.
4. Cada motorista salva o número da central e manda **ONLINE** e a **localização em tempo real** (8 horas).
5. Teste: de outro celular, mande **oi** para a central.

## Cuidados com o WhatsApp

A Evolution usa conexão não oficial; o WhatsApp pode bloquear números que parecem robô de propaganda.
- Use um **número só para a central**, nunca o pessoal.
- O sistema só responde quem mandou mensagem. Não use o número para disparos em massa.
- Tenha um chip reserva. A Evolution também aceita a API oficial da Meta (Cloud API): dá para migrar sem mudar este código.

## Rodar no computador (opcional)

```
npm install
DATABASE_URL=postgres://... ADMIN_SENHA=teste node server.js
```

Sem `EVOLUTION_URL`, as mensagens que seriam enviadas aparecem no log (bom para testar).
