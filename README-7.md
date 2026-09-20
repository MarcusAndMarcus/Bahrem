# Bahrem · Salão

Controle de salão para bar: o garçom vê as mesas e a conta de cada uma, o cliente
vê a própria comanda pelo celular, e o prato entra na comanda por foto.

Node puro (`node:http`, `node:sqlite`, SSE), **zero dependência npm**. Roda no
Termux, no Render e em `localhost`.

```bash
node seed.js      # carga inicial (só na primeira vez)
node server.js    # sobe em http://localhost:3000
node testes.js    # 90 testes
node montar.js    # remonta o protótipo de arquivo único
```

**Pasta única, de propósito.** Todos os arquivos ficam no mesmo nível — não há
`public/` nem `demo/`. Como o código passa a morar junto com a interface, o
servidor não serve "o que estiver na pasta": há uma **lista branca** no topo do
`server.js` com os treze arquivos que são públicos. Pedir `/server.js`,
`/testes.js` ou `/dados/salao.db` devolve 404, e há teste cobrando isso. Para
publicar um arquivo novo (uma tela, um ícone), acrescente o nome em `PUBLICOS`
— senão ele não sai.

PINs da carga inicial: **1986** (Cafú, garçom), **2468** (Rodrigus, gerente),
**1357** (passe). Troque antes de usar de verdade.

## As três telas

| Rota | Quem usa | O que faz |
|---|---|---|
| `/` | equipe | entrada por PIN |
| `/salao` | garçom | grade de mesas por área, comanda, lançamento, fechamento, passe |
| `/mesa?c=CÓDIGO` | cliente | a conta dele, o rateio, chamar garçom, pedir a conta |
| `/passe` | cozinha e bar | KDS por estação: na fila → preparando → pronto |
| `/noite` | gerente | caixa por forma de pagamento, receita por hora, itens mais vendidos |
| `/qr?mesa=7&c=CÓDIGO` | impressão | cartão com o QR da mesa, pronto para plastificar |
| `/camera?mesa=7&comanda=12` | garçom | fotografa o prato, identifica e lança |

Cada comanda aberta ganha um código de 8 dígitos hexadecimais. O link do cliente
é `/mesa?c=CÓDIGO` — é esse link que vira o QR da mesa. **O gerador de QR não
está aqui**: por enquanto o sistema mostra o código e o link, e o QR é impresso
por fora. Encoder de QR escrito à mão é risco desnecessário; se for para gerar
dentro do sistema, entra uma biblioteca dedicada.

## O que a comanda faz

- **o cliente pede pelo celular** — o que ele monta entra como `sugerido`, aparece
  na aba Pedidos do garçom e **não conta nem vai para a cozinha** até ser aceito;
- **estados do item** — `pendente → preparo → pronto → entregue`, com hora
  gravada em pronto e entregue; é isso que alimenta o passe e o aviso de atraso;
- **rateio por item** — cada linha pode ser marcada com quem dividiu. Quem não
  marcou nada continua dividindo igual. Serviço e desconto entram proporcionais
  ao consumo de cada um;
- **observação por item** — ponto da carne, sem cebola, o que for; aparece na
  ficha do passe;
- **transferir a comanda** de mesa, levando tudo;
- **desconto e cortesia** — só com PIN de gerente e **só com motivo escrito**,
  que fica gravado na comanda;
- **reabrir comanda fechada por engano** — também só gerente, e só se a mesa
  ainda estiver livre.

## Claude no sistema

Três portas, e só estas três. A chave vive no servidor; o navegador nunca a vê.

**1. Assistente do cliente** (`/api/conta/:codigo/assistente`). O molde leva o
cardápio real e a conta da mesa. Ele explica pratos e sugere; **não faz pedido,
não cancela, não fecha conta e não fala de alergia** — para isso manda chamar o
garçom. A sugestão volta como id de item e o servidor **descarta qualquer id que
não exista no cardápio** antes de chegar na tela; quem confirma é o cliente,
tocando no botão. A fala do cliente entra como mensagem de usuário, nunca como
instrução de sistema, e o molde manda ignorar ordens vindas de dentro dela.
Teto de 25 mensagens por comanda e 200 por hora na casa, porque quem paga a
conta da API é o bar.

**2. Assistente da equipe** (`/api/assistente`, exige sessão). O molde recebe o
**retrato do salão no instante da pergunta**: cada mesa aberta com tempo,
pessoas, total, chamadas, pedidos do celular esperando e há quanto tempo a
comida mais antiga está na fila; a fila inteira do passe; e o que já fechou na
noite. Ele responde e **aponta os números das mesas** — a tela vira esses
números em botões que abrem a gaveta. Não abre, não fecha, não lança, não
estorna, não dá desconto: quem age é a pessoa. Não estima nem projeta
faturamento; o que não está no retrato, ele diz que não sabe. Mesa que não
existe no retrato é descartada antes de virar botão.

**3. Camada 2 do reconhecimento.** Quando a geometria empata, e só então, a foto
vai para o modelo de visão junto com **a lista curta de candidatos que a
geometria deixou de pé**. Ele escolhe entre eles ou diz que não sabe; item fora
da lista é recusado pelo servidor. É isso que faz a câmera sair de "mede e
duvida" para "resolve", sem gastar chamada de API nas fotos que a geometria já
resolve sozinha.

Sem `ANTHROPIC_API_KEY` as duas portas se desligam e o sistema **diz isso** — a
aba Perguntar some da tela do cliente e o veredito da câmera avisa que a camada 2
está desligada.

| Variável | Para quê |
|---|---|
| `ANTHROPIC_API_KEY` | liga as duas portas |
| `ANTHROPIC_MODEL` | modelo (padrão `claude-haiku-4-5-20251001`) |
| `IA_TETO_MESA`, `IA_TETO_HORA` | tetos de gasto (25 e 200) |

## O total da mesa

Vem das duas fontes, como no Paim Grill: lançamento do garçom e lançamento por
câmera. Tudo em **centavos inteiros** — nenhuma conta passa por ponto flutuante.

O rateio divide o total em partes iguais e distribui o resto em centavos: a soma
das partes é sempre exatamente o total, e a diferença entre a maior e a menor
parte nunca passa de um centavo (testado com 10001/3, 1/4, 99999/7, 7/3).

Serviço: 10% por padrão, destacado como opcional nas duas telas
(Lei Municipal 9.418/14, citada no próprio cardápio digital da casa).

## Reconhecimento do prato

Mesmo esqueleto do ALEX/AFERIDOR, adaptado de *avaliar montagem* para
*identificar o prato*:

1. **Medição no aparelho** (`nucleo.js`) — Canvas, sem rede, sem custo por
   foto. Reduz a imagem para 320 px com um filtro de caixa próprio (o
   reescalonador do Canvas muda entre Chrome, WebView e Firefox e faria a mesma
   foto medir diferente em cada aparelho), converte para CIE Lab, separa
   prato/mesa por Otsu com tratamento de platô, preenche os vãos que a comida
   escura abre na louça, mede o perfil radial em 48 raios e separa comida/louça
   por croma.
2. **8 grandezas**: `ocupacao`, `centragem`, `dispersao`, `elementos`, `borda`,
   `luminancia`, `cromaA`, `cromaB` — todas em [0,1].
3. **Identificação no servidor** (`afericao.js`) — afastamento de Mahalanobis
   diagonal contra o envelope de cada prato (média e variância com encolhimento
   para n pequeno), e cascata:
   - **camada 0** — afastamento < 1,8 e o 2º colocado pelo menos 35% mais longe:
     o sistema lança sozinho, sem gastar nada;
   - **camada 1** — ambíguo ou fora da folga;
   - **camada 2** — a foto e os candidatos da camada 1 vão para o modelo de
     visão, que escolhe entre eles ou diz que não sabe. O veredito sai marcado
     como **não medido** e o botão de lançar avisa "conferir antes";
   - **camada 3** — nenhum padrão explica a foto: recusa.
   Sobrando dúvida, a tela mostra os candidatos com os números e pede
   confirmação na mão. Nunca chuta.

   Na tela da câmera o mesmo pipeline roda **ao vivo no visor**, a cada 0,7 s,
   dizendo se o prato está cortado, rasante, longe ou tremido — o garçom
   enquadra antes de gastar o clique, e o botão de fotografar só fica aceso
   quando a medição está limpa.

### O que o sistema recusa, e com qual número

- prato cortado pela moldura (> 10% dos raios terminam na borda);
- forma que não é prato: mais de 6% da área cai fora da elipse ajustada —
  pega tábua, travessa quadrada, dois pratos encostados, mesa inteira no quadro;
- ângulo rasante (prato mais de 2,2× mais largo que alto);
- prato vazio (menos de 2% de comida);
- foto sem contraste entre louça e mesa.

### Calibração — o que está medido e o que não está

`node calibra-forma.js` produz os números que sustentam os limiares de forma.
Medido em cenas sintéticas:

| cena | irregularidade | desencaixe da elipse |
|---|---|---|
| prato de frente | 0,005 | 0,000 |
| prato inclinado 30° | 0,050 | 0,001 |
| prato inclinado 45° | 0,125 | 0,001 |
| prato inclinado 60° | 0,249 | 0,001 |
| tábua quadrada | 0,110 | **0,180** |
| tábua hexagonal | — | **0,070** |

É por isso que a recusa de forma usa a elipse e não o desvio radial: o desvio
radial de uma tábua quadrada (0,11) é **menor** que o de um prato inclinado a 45°
(0,125) — reprovar por ele reprovaria o prato e aprovaria a tábua.

**O que não está medido:** os limiares de identificação (1,8 / 3,2 / 1,35) são
valores de partida escolhidos por mim, não ajustados em fotos desta casa. **Não
existe taxa de acerto conhecida** — nem da geometria, nem da camada 2 — enquanto
não houver fotos reais rotuladas pelo passe. Até lá o sistema trabalha, mas não
sabe quanto erra, e é por isso que o lançamento da camada 2 sai marcado para
conferência. Não há modelo treinado neste repositório: a camada 0 é geometria e
cor, e a camada 2 é um modelo de propósito geral olhando a foto — nenhuma das
duas foi ajustada para este cardápio.

## Pix

`pix.js` gera o BR Code EMV com o mesmo CRC16-CCITT do barramento URB1 — um
polinômio só no projeto inteiro, validado contra o vetor `"123456789" = 0x29B1`.
Sem `PIX_CHAVE` configurada, o fechamento **diz** que não gerou código, em vez de
mostrar um QR que não recebe. A baixa é manual: confira no app do banco antes de
liberar a mesa.

## URB1

Telegramas hexadecimais de tamanho fixo no rodapé do salão, mesmo vocabulário do
ALEX e do UROBOROS:

```
URB1 SAL LANC 0007 0002 0040 *A3D2
     │   │    │    │    │    └ CRC16-CCITT do corpo
     │   │    │    │    └ valor unitário em reais
     │   │    │    └ quantidade
     │   │    └ mesa
     │   └ verbo (ABRE, LANC, FECH, PRAT, CONT, GARC)
     └ origem (SAL salão, CLI cliente, AFE aferidor, SRV servidor)
```

Valor acima de 0xFFFF satura em `FFFF` em vez de estourar o campo.

## Atalhos da equipe

Na tela do salão, digitar o número de uma mesa e apertar Enter abre a gaveta
dela. O garçom sabe o número de cor; procurar na grade é o passo que sobra.
Backspace corrige, e a caixinha some sozinha depois de 2,5 s.

## Estética

**Gramática do UROBOROS, paleta do Bahrem.** A estrutura é a mesma língua dos
outros sistemas: preto, IBM Plex Mono como voz do sistema, rótulos em caixa
alta espaçada, painéis numerados `[01]`, calibres, barramento URB1 em hex,
densidade de instrumento. A cor é da casa.

Uma regra separa as duas e vale em toda a folha: **o teal é do instrumento, o
vermelho é da casa, e eles não se cruzam.** Telemetria, calibres, medição e
mira da câmera são teal (`--instru`). Chamada, urgência e marca são o vermelho
medido (`--marca`). Dinheiro é âmbar (`--chopp`).

Três cores são **medidas**, não escolhidas: `#e30613` ocupa 81,7% dos pixels do
logotipo, e os neutros vêm da paleta reduzida da foto do salão (`#2a1913` no
escuro, `#b08764` na madeira, `#d0bfa4` na luz dos globos). Trocar o bloco
`:root` no topo de `bahrem.css` muda o sistema inteiro:

```css
--marca: #e30613;  --breu:  #0b0806;  --painel: #12100d;
--risco: #2e241c;  --papel: #f2e9d8;  --latao:  #c08a2e;
--chopp: #f0b429;  --folha: #7d8a5f;  --instru: #3f9e91;
--foto: url(/casa.jpg);   --veu: .91;
```

Há escala de espaço (`--e1` a `--e6`) e de raio (`--r1` a `--r3`): nenhum
padding solto no arquivo, o que é o que faz o conjunto parecer uma peça só.
Números em `tabular-nums` — coluna de valor não dança quando o total muda.

`casa.jpg` é a foto do salão e `marca.png` é o escudo — ambos
fornecidos pela casa. A foto entra em `body::before` com desfoque de 7px e um
véu por cima controlado por `--veu`: 0,9 nas telas de trabalho, onde há número
de mesa para ler, e 0,58 na portaria, onde não há nada competindo. Baixar o véu
mostra mais salão; subir apaga a foto sem removê-la.

A foto enviada tem 447×447. Esticada em tela cheia de tablet ela fica macia —
o desfoque disfarça, mas se houver o original em resolução maior, é só
substituir `casa.jpg` e remontar o protótipo (`node montar.js`).

Tipografia: Archivo para número de mesa e interface, IBM Plex Mono para comanda e
telemetria.

Na grade do salão, a faixa da esquerda de cada mesa é um copo que enche conforme
a conta sobe, cheio em R$ 400 (`TICKET_CHEIO` em `salao.html`). É o único enfeite
do sistema e ele carrega informação: dá para varrer o salão e ver onde está o
dinheiro sem ler número nenhum.

## Onde rodar: Render free

O plano free do Render impõe quatro coisas. Três têm resposta dentro do próprio
sistema; uma não tem e você convive com ela.

| Limite do free | Resposta |
|---|---|
| Sem disco persistente | retrato externo: o banco comprimido sobe para um repositório privado e volta no arranque |
| Hiberna após 15 min | abra a tela do salão 2 min antes de abrir a casa; o SSE se religa sozinho com recuo progressivo |
| 750 h de instância por mês | **não** mantenha acordado com ping: o mês tem 744 h e o ping come a cota inteira |
| Sem shell e sem job avulso | a carga inicial roda sozinha no arranque |

O que não tem resposta: o primeiro acesso depois de uma hibernação espera cerca
de um minuto, e essa tela de espera é do Render, não minha.

### O retrato externo

`persistencia.js` guarda o banco inteiro, comprimido, num repositório **privado**
do GitHub, e o traz de volta quando o serviço sobe.

- `VACUUM INTO` gera um retrato consistente mesmo com o WAL ativo;
- gzip nível 9 antes de subir;
- sobe a cada mudança (com 2 min de espera para agrupar), no máximo a cada
  10 min, **e sempre no `SIGTERM`** — que é como o Render desliga em deploy e em
  hibernação. É esse último que faz quase nada se perder;
- na tela do salão, ao lado dos telegramas URB1, aparece há quanto tempo foi o
  último retrato. Se não houver repositório configurado, aparece em vermelho
  **"dados voláteis — somem no próximo restart"**. Clicar grava um retrato na hora.

Medido aqui com uma noite cheia (126 comandas, 1.134 lançamentos, 1.135 eventos):

| | |
|---|---|
| banco cru | 260 KB |
| retrato comprimido | 34 KB (7,6×) |
| tempo do `VACUUM INTO` + gzip | 12 ms |
| 54 retratos numa noite de 9 h | 1,8 MB |

Ou seja, algo como 50 MB de objetos git por mês. Quando o repositório de dados
incomodar, apague e recrie: só o retrato mais recente importa.

**O que isso não cobre:** morte abrupta do processo (SIGKILL, queda da
plataforma) perde o que entrou desde o último retrato — no pior caso, os 2 min
da espera de agrupamento. Em desligamento normal, nada.

**O que não foi testado:** o cliente do GitHub foi exercitado contra um dublê da
API subido nos próprios testes (grava, lê de volta, abre o banco restaurado,
e refaz a gravação quando o `sha` está velho). Isso prova o contrato que
escrevi; não prova que o GitHub responde igual. O primeiro deploy é o teste
de verdade — confira o indicador na tela do salão.

Por que não o Postgres free do Render: ele expira 30 dias depois de criado e
exigiria um driver npm, o que quebra o projeto inteiro sem dependência.

### Preparando o retrato

1. Crie um repositório **privado** vazio, ex.: `MarcusAndMarcus/bahrem-dados`,
   com um commit inicial no ramo `main` (pode ser um README de uma linha —
   a API precisa do ramo existindo).
2. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained**, só esse repositório, permissão **Contents: Read and write**.
3. No painel do Render, preencha `SNAP_REPO` e `SNAP_TOKEN`.

O token fica só no painel: as duas chaves estão como `sync: false` no
`render.yaml` justamente para não irem para o repositório do código.

### Deploy (a partir do Termux)

```bash
cd bahrem-salao
git init && git add -A && git commit -m "salao"
git remote add origin git@github.com:MarcusAndMarcus/bahrem-salao.git
git push -u origin main
```

No Render: **New → Blueprint**, aponte o repositório, ele lê o `render.yaml`.
Preencha `PIX_CHAVE`, `SNAP_REPO` e `SNAP_TOKEN` no painel.

### Quando o deploy falha

**`Cannot find module '/opt/render/project/src/server.js'`** — os arquivos estão
numa subpasta do repositório, e o Render roda a partir da raiz. O próprio log
entrega isso na linha `Using Node.js version ... via bahrem-salao/package.json`:
se aparece um caminho com pasta ali, a raiz está um nível abaixo. Resolve-se em
Settings → **Root Directory** = nome da pasta (`bahrem-salao`). Blueprint é
diferente: o `render.yaml` **precisa** estar na raiz do repositório, então nesse
caso não há Root Directory que resolva — é mover os arquivos para a raiz.

**Node mais novo do que o testado** — `engines` está fixado em `22.x` e há um
`.node-version` com `22` justamente porque a bateria de 48 testes passa no
Node 22. Com `>=22` o Render instala a versão mais nova que existir (já apareceu
26.9.0), e `node:sqlite` nunca foi exercitado aqui acima do 22. Se preferir
mandar pelo painel em vez de commitar, a variável `NODE_VERSION` tem precedência
sobre o `package.json`.

**Build rodando `yarn`** — é o padrão do Render quando não há Build Command.
Não quebra nada (o projeto não tem dependência), mas cria um `yarn.lock` inútil.
O Build Command certo é `echo sem dependencias`.

### Uma restrição que o free não muda

A câmera do navegador (`getUserMedia`) exige contexto seguro. No Render isso
está resolvido de graça — o domínio `.onrender.com` já vem com HTTPS, então a
aferição funciona em qualquer tablet. Numa instalação local por `http://192.168…`
não funcionaria: o Chrome bloqueia antes de pedir permissão.

## Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `PORT` | porta (3000) |
| `DB_PATH` | arquivo do banco (`dados/salao.db`) |
| `CASA_NOME`, `CASA_CIDADE` | cabeçalho e Pix |
| `PIX_CHAVE`, `PIX_NOME` | recebedor do copia-e-cola |
| `SERVICO_PCT` | percentual de serviço (10) |
| `SNAP_REPO`, `SNAP_TOKEN` | repositório privado e token do retrato externo |
| `SNAP_ARQUIVO`, `SNAP_BRANCH` | caminho (`salao.db.gz`) e ramo (`main`) do retrato |
| `SNAP_INTERVALO`, `SNAP_DEBOUNCE` | segundos entre retratos (600) e espera após mudança (120) |
| `NOITE_INICIO` | hora da virada da noite (12) |
| `FUNDO_TROCO` | fundo de troco da gaveta, em reais, para a conferência |
| `DIAS_EVENTO` | dias de telemetria URB1 mantidos (7) |

## Caixa: como o dinheiro entrou

Uma comanda pode fechar em mais de uma forma — metade no cartão, o resto em
espécie — então pagamento é **tabela, não coluna**. No fechamento, um toque na
forma já preenche o que falta: o caso comum (uma forma só) vira dois toques, e
dividir é tocar na segunda.

O servidor **recusa o fechamento se a soma não der o total**, e devolve a
diferença em centavos para a tela dizer "falta R$ 12,00" em vez de "erro". Em
dinheiro dá para digitar o que o cliente entregou: o troco sai na hora, e o que
entra na gaveta é o valor da conta, não o recebido.

Duas decisões que valem explicar:

- **`nao-informado` existe de propósito.** Fechamento por API sem forma cai
  nele, e a tela da noite mostra esse valor em vermelho dizendo que não dá para
  conferir contra gaveta nem contra extrato. O contrário — deixar cair em
  "dinheiro" por omissão — seria inventar uma informação que ninguém deu.
- **Reabrir comanda apaga os pagamentos.** Sem isso, a comanda reaberta e
  fechada de novo contaria o mesmo dinheiro duas vezes na noite. Há teste
  medindo exatamente isso.

Em `/noite`: barra por forma com a fatia de cada uma, e o bloco de conferência
de gaveta — recebido, espécie, eletrônico, troco devolvido, fundo de troco
(`FUNDO_TROCO`, em reais) e **quanto a gaveta deve ter agora**. O cabeçalho
compara com a mesma janela da noite anterior.

O que o caixa **não** faz: sangria, suprimento, fechamento por operador e
conferência cega. Nada disso está aqui, e o número da gaveta é o esperado
teórico — não há contagem física para bater contra ele.

## Som e QR

**Som** (`alerta.js`): cada evento tem um padrão de beeps próprio,
sintetizado na hora pela Web Audio API — zero arquivo de áudio no repositório.
Num bar barulhento a melodia identifica o tipo antes de a pessoa ler a tela:
chamada de garçom sobe em duas notas, conta pedida é um arpejo de quatro,
pedido do celular são duas notas curtas, item pronto é um trinado agudo. Toasts
aparecem junto, no canto, e repetição rápida do mesmo aviso colapsa em `×N` em
vez de empilhar. O navegador só libera áudio depois do primeiro toque na tela —
é por isso que o primeiro clique da noite destrava o som.

**QR** (`/qr?mesa=7&area=deck&c=CÓDIGO`): cartão pronto para imprimir e
plastificar, com o número da mesa em corpo grande, o QR nas cores da casa e
estilo de impressão em preto no branco. O encoder é o `qrcodejs` pelo cdnjs,
com `integrity` fixado — não escrevi encoder de QR à mão, que é risco sem
retorno. O botão "QR desta mesa" fica na aba Comanda da gaveta.

## O que ainda não existe
- NFC-e — o Focus NFe do Alphaville encaixa aqui sem mudar o resto;
- sangria, suprimento e fechamento de caixa por operador;
- baixa automática do Pix (hoje é confirmação manual);
- reserva de mesa e brinquedoteca;
- calibração do reconhecimento com fotos reais e rótulo do passe — **este é o
  item que decide se a câmera serve para lançar sozinha ou só para conferir**.
