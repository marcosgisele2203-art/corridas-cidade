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
Central:    Saída / Destino / 2,9 km · Qual veículo? 1 🏍️ Moto · 2 🚗 Carro · 3 🚐 Van · 4 🚚 Caminhão
Passageiro: 2
Central:    🚗 Carro · R$ 11,00 · Confirma? 1 Sim 2 Não
Passageiro: 1
Central:    🔎 Procurando motorista...
Central:    ✅ Pedro Lima · Onix branco XYZ9K87 · chega em ~9 min
Central:    📍 Pedro chegou!
Central:    🏁 Corrida finalizada: R$ 11,00 · avalie de 1 a 5
```

A qualquer momento o passageiro pode mandar **CANCELAR** (até a corrida começar).

**Cadastro do motorista** (ele mesmo faz, pelo WhatsApp da central)

```
Motorista: CADASTRO
Central:   1/5 Nome completo? · 2/5 Veículo? (1 Moto, 2 Carro, 3 Van, 4 Caminhão)
           3/5 Modelo? · 4/5 Cor? · 5/5 Placa?
Central:   ✅ Cadastro enviado! Você recebe uma mensagem quando for aprovado.
```

O administrador recebe um aviso no WhatsApp e aprova (ou recusa) em **Painel › Motoristas**. Na aprovação o
motorista recebe a lista de comandos. Em Configurações dá para ligar *Aprovar sozinho* (sem conferir).
O administrador também pode cadastrar motoristas direto no painel.

**Motorista** (depois de aprovado, conversa com o mesmo WhatsApp da central)

| Mensagem | O que faz |
|---|---|
| `ONLINE` / `OFFLINE` | começa / para de receber corridas |
| localização 📍 | atualiza onde ele está (melhor: **localização em tempo real**, assim recebe sempre a corrida mais perto) |
| `1` ou `ACEITAR` · `2` ou `RECUSAR` | responde a chamada |
| `CHEGUEI` | avisa o passageiro que chegou |
| `INICIAR` | passageiro embarcou |
| `FINALIZAR` ou `FINALIZAR 15` | encerra a corrida (com o valor, se for diferente do combinado ou no taxímetro) |
| `CANCELAR` | desiste da corrida aceita; o sistema procura outro motorista (a viagem usada não volta) |
| `SALDO` · `COMPRAR` · `COMPRAR 20` | ver o saldo de viagens e comprar mais |
| `RELATORIO` | recebe o próprio relatório do mês (corridas, ganhos, nota, viagens) |
| qualquer outra coisa | mostra a lista de comandos |

### Distribuição das chamadas

1. A corrida vai para o motorista **do tipo de veículo escolhido**, **online, livre e mais perto** da saída (pela última localização dele).
2. Ele tem **40 segundos** (configurável) para aceitar. Se recusar ou não responder, vai para o próximo.
3. Se todos estiverem ocupados, o sistema continua tentando por até 5 minutos.
4. Sem ninguém disponível, o passageiro é avisado e o **WhatsApp do administrador** recebe um alerta.

Só um motorista recebe a chamada por vez; dois motoristas nunca ficam com a mesma corrida.

### Preço

Cada tipo de veículo tem sua tabela: `taxa base + km × valor por km`, nunca abaixo do mínimo, arredondado para cima
de 50 em 50 centavos. A distância é a linha reta × 1,3 (aproxima o caminho pelas ruas).

| Veículo | Taxa base | Por km | Mínimo |
|---|---|---|---|
| 🏍️ Moto | R$ 4,00 | R$ 1,50 | R$ 6,00 |
| 🚗 Carro | R$ 5,00 | R$ 2,00 | R$ 8,00 |
| 🚐 Van | R$ 8,00 | R$ 3,00 | R$ 15,00 |
| 🚚 Caminhão (frete) | R$ 30,00 | R$ 5,00 | R$ 60,00 |

Tudo muda em Painel › Configurações, onde também dá para **desligar** um tipo (ele some do menu do passageiro).

- Quando o passageiro manda **localização**, o preço sai na hora.
- Quando **digita o endereço**, o sistema procura no OpenStreetMap dentro da cidade configurada. Se não achar, a corrida
  vai "no taxímetro" e o motorista informa o valor no fim (`FINALIZAR 15`).

O passageiro paga a corrida direto ao motorista (dinheiro ou Pix).

## Viagens pré-pagas (como a central ganha)

O motorista **compra pacotes de viagens antes**. Em Painel › Configurações › *Pacotes de viagens* você cadastra cada pacote
com a **quantidade** e o **preço** (ex.: 1 = R$ 1,00 · 10 = R$ 8,00 · 100 = R$ 55,00); o painel calcula o valor de cada
viagem e o **desconto**, que aparecem para o motorista no WhatsApp.
Cada corrida aceita usa 1 viagem; **sem saldo ele não recebe chamadas**. Se o passageiro ou a central cancelar
antes da corrida começar, a viagem volta para ele. Motorista novo ganha **3 viagens grátis** ao ser aprovado.

```
Motorista: COMPRAR
Central:   1 viagem · R$ 1,00 / 10 viagens · R$ 8,00 (R$ 0,80 cada · 20% off) → COMPRAR 10 / ...
Motorista: COMPRAR 20
Central:   Pedido #7 · R$ 20,00 + QR Code + Pix copia e cola (vale 30 min)
           ... paga no banco ...
Central:   ✅ Pagamento confirmado! +20 viagens · saldo: 23
```

- **Com Mercado Pago** (`MP_ACCESS_TOKEN`): o Pix tem o valor exato e as viagens entram **sozinhas** quando o
  pagamento é aprovado. O sistema confere direto na API do Mercado Pago (o aviso do webhook sozinho não basta) e,
  se o aviso não chegar, confere de novo a cada 30 segundos.
- **Sem Mercado Pago**: o motorista recebe a chave Pix da central, manda a foto do comprovante, e você clica em
  **Pix recebido, liberar viagens** no painel.
- `SALDO` mostra quantas viagens ele tem. No painel, o botão **🎟️ Viagens** dá ou tira viagens na mão.
- O relatório mostra quanto a central vendeu de viagens no período.

Também existe uma **comissão %** por corrida (padrão 0%), só para controle no relatório.

## Painel (`/painel`)

Ao entrar aparece a tela **Escolha sua área** (como a entrada da equipe do Naturally Mania): a Manu com o celular e um
cartão para cada área, com avisos do que precisa de atenção (corridas em andamento, motoristas para aprovar, Pix para
liberar). Cada página tem uma dica da Manu no topo. As poses da Manu (`public/img/manu/`) foram recortadas das artes da
Vai de Manu.

| Aba | O que tem |
|---|---|
| **🛣️ Viagens** | **ao vivo** em 3 colunas (atualiza a cada 5 s): *Procurando motorista* (mostra qual motorista está sendo chamado e os segundos que ele tem), *Motorista a caminho* (quem aceitou, veículo, placa, "chegou") e *Em viagem*; som opcional de pedido novo. Embaixo, as **viagens feitas** com filtro por período, situação, motorista e busca. Clicando numa viagem abre o **passo a passo**: pedido, motoristas chamados, aceite, chegada, embarque e fim (ou cancelamento), com valor e nota |
| **Motoristas** | **aprovar/recusar** quem se cadastrou pelo WhatsApp, cadastro manual (tipo de veículo, modelo, placa), ativar/desativar, pôr online/tirar do ar, nota média |
| **Relatório** | **geral da central** (corridas, faturamento, venda de viagens) e **individual de cada motorista** (corridas, ganhos, nota, viagens compradas/usadas, saldo): ver, imprimir/PDF e **mandar no WhatsApp** dele, um por um ou para todos |
| **📣 Divulgar** | **artes da Vai de Manu para baixar** (`public/artes/`), link do WhatsApp da central (já com "Oi! Quero uma corrida"), **QR Code**, texto pronto para grupos/status/redes, **cartaz para imprimir**, e o link de cadastro para motoristas |
| **Configurações** | nome da central, cidade, **preços por veículo**, comissão, tempo para aceitar, WhatsApp do administrador, aprovação automática, abrir/fechar a central |

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
MP_ACCESS_TOKEN=APP_USR-...                  (opcional: Pix automático na compra de viagens)
```

Em *Domains*, aponte o domínio (ex.: `corridas.seudominio.com`) para a porta **3000** e clique em **Implantar**.
Nos logs deve aparecer `Central de corridas no ar na porta 3000`.

### 3. Evolution API
1. Crie a instância `corridas` e leia o QR com o celular do **número da central** (um chip só para isso).
2. Em *Webhook* da instância:
   - URL: `https://corridas.seudominio.com/webhook/evolution?token=MESMO_WEBHOOK_TOKEN`
   - Evento: **`MESSAGES_UPSERT`**
   - Ligado: *Enabled*. Não precisa de *Webhook Base64*.

### 4. Mercado Pago (Pix automático)
1. Entre em **https://www.mercadopago.com.br/developers/panel/app** → *Criar aplicação* → **Checkout Transparente**,
   tipo de API **API de Orders** (pode ser a mesma conta do Naturalle ou outra).
2. Em *Credenciais de produção*, copie o **Access Token** (`APP_USR-...`) e coloque em `MP_ACCESS_TOKEN` no Easypanel.
   Não mande essa chave para ninguém. Clique em **Implantar**.
3. Na aplicação do Mercado Pago, em *Webhooks* → *Configurar notificações* (modo produção), coloque
   `https://SEU-DOMINIO/api/mp/webhook` e marque o evento **Order (Mercado Pago)**. Sem isso também funciona
   (o sistema confere sozinho a cada 30 s), só fica uns segundos mais lento.
4. Em Painel › Configurações aparece "✅ conectado" ao lado de *Pix automático pelo Mercado Pago*.

O Mercado Pago cobra uma taxa por Pix recebido (veja no painel deles).

### 5. Primeiro uso
1. Abra `https://corridas.seudominio.com/painel` e entre com a `ADMIN_SENHA`.
2. **Configurações**: nome da central, cidade (ex.: `Bonito, MS`), preços, comissão e seu WhatsApp para alertas.
3. **Motoristas**: divulgue o número da central; cada motorista manda **CADASTRO** e você aprova no painel.
4. Depois de aprovado, o motorista manda **ONLINE** e a **localização em tempo real** (8 horas).
5. Teste: de outro celular, mande **oi** para a central.

## Arte de boas-vindas

O cliente que manda "oi" recebe o *Bem-vindo* junto com uma arte da Vai de Manu (no máximo 1 vez por semana para cada
pessoa; nas outras vezes vai só o texto). Em Configurações dá para escolher a arte ou deixar **Automática**: com van ou
caminhão ligados vai a de todos os veículos; só carro e moto, a de carro e moto. Para trocar uma arte, salve outra imagem
com o mesmo nome em `public/artes/` (JPG).

## Privacidade da localização

- **Motorista:** a posição só é guardada enquanto ele está **ONLINE**. Ao mandar **OFFLINE** (ou ser tirado do ar no
  painel) ela é apagada, e a localização em tempo real que continuar chegando é ignorada.
- **Cliente:** a localização de saída e destino é usada só durante a corrida. Quando a corrida termina (finalizada,
  cancelada ou sem motorista) as coordenadas são apagadas; ficam o nome do lugar, os km e o valor para os relatórios.
  Pedido abandonado no meio é apagado depois de 1 hora. A limpeza roda a cada 5 minutos.

## Cuidados com o WhatsApp

A Evolution usa conexão não oficial; o WhatsApp pode bloquear números que parecem robô de propaganda.
- Use um **número só para a central**, nunca o pessoal.
- O sistema só responde quem mandou mensagem. Não use o número para disparos em massa.
- **Proteção contra loop:** se outro robô (ex.: o atendimento automático de uma loja) ficar respondendo a central,
  depois de 6 mensagens em 30 segundos o número fica 30 minutos sem resposta e o administrador recebe um aviso.
  Mesmo assim, **não teste usando um número que tenha robô** (como o do Naturally Mania).
- Tenha um chip reserva. A Evolution também aceita a API oficial da Meta (Cloud API): dá para migrar sem mudar este código.

## Rodar no computador (opcional)

```
npm install
DATABASE_URL=postgres://... ADMIN_SENHA=teste node server.js
```

Sem `EVOLUTION_URL`, as mensagens que seriam enviadas aparecem no log (bom para testar).
