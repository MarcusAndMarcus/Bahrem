# Burguer · Salão

Controle de salão para bar: o garçom vê as mesas e a conta de cada uma, o cliente
vê a própria comanda pelo celular, e o prato entra na comanda por foto.

Node puro (`node:http`, `node:sqlite`, SSE), **zero dependência npm**. Roda no
Termux, no Render e em `localhost`.

```bash
node seed.js      # carga inicial (só na primeira vez)
node server.js    # sobe em http://localhost:3000
node testes.js    # 181 testes do servidor
npm run testes:dom  # execução das páginas (precisa de npm install)
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
| `/cardapio` | gerente | fotos reais de cada produto, tiradas na casa |
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

## Caixinha de perguntas

No molde do Sommelier do Paim: uma **seção no fluxo da página, centralizada**,
e não um botão flutuante. Rótulo pequeno em cima, a pergunta grande em itálico
como título, um subtítulo curto, a conversa em balões (a pergunta à direita em
latão, a resposta à esquerda), sugestões arredondadas que somem depois da
primeira pergunta, e campo + Enviar numa linha.

- **No salão**, ela é uma faixa entre os filtros e a grade de mesas. O
  contraste com as mesas vem de três lugares: a faixa é mais clara e mais
  quente que o breu do salão, o título é o único itálico do sistema, e as
  formas são arredondadas onde as mesas são retas. O filete vermelho da casa
  no topo amarra de volta à marca. **As sugestões mudam com o salão**: se
  alguém pediu a conta, a primeira sugestão é "Quem pediu a conta?". O botão
  "recolher" deixa só o título e o campo, e o navegador lembra da escolha.
  A tecla `/` leva direto para a pergunta.
- **No celular do cliente**, é o Sommelier do Burguer, entre a conta e as abas.
  O que ele sugere vira botão "+ Croqueta — R$ 64,00", que põe na sacola.

O componente é um só (`caixinha.js`); cada página diz o texto, as sugestões e
para onde a pergunta vai. O título usa o itálico da Archivo, carregado de
verdade — sem ele o navegador inclinaria a letra reta, que fica torta.

## Teste de execução das páginas

`node testes.js` cobre o servidor. `npm run testes:dom` cobre as **páginas**:
sobe o servidor de verdade, abre salão, cliente e cardápio num DOM simulado e
falha se qualquer script der erro ao rodar — o tipo de erro que a checagem de
sintaxe não pega. Precisa do `jsdom` (`npm install`), a única dependência de
desenvolvimento; o Render não roda isso e o sistema continua sem dependência.

## Fotos do cardápio

Cada produto pode ter uma **foto real, tirada na casa**. Dois caminhos:

- **`/cardapio`** (gerente): a vitrine com todos os itens; "fotografar" abre a
  câmera do tablet. A foto é recortada quadrada, reduzida a 720 px e comprimida
  **no próprio aparelho** antes de sair — uma foto de 4 MB vira ~70 KB.
- **Câmera, ao gravar o padrão de um prato**: a caixa "usar a última foto
  também no cardápio" vem marcada. A foto que ensina o reconhecimento é o prato
  montado do jeito aprovado — é exatamente a foto que o cardápio deve mostrar.

O servidor confere a **assinatura do arquivo** (os bytes `FF D8 FF` do JPEG),
não só o rótulo que veio escrito, e recusa acima de 350 KB. A rota pública
`/foto/12.jpg` só aceita número no nome.

**Por que as fotos não entram no retrato do banco:** JPEG já vem comprimido e
gzip não reduz nada. Dezoito fotos de ~60 KB viajariam de novo a cada retrato
de 10 minutos — cerca de 1 MB, 54 vezes por noite. Em vez disso, cada foto é um
arquivo próprio no repositório de dados (`fotos/12.jpg`), gravado quando muda e
baixado quando o serviço sobe.

Sem foto, o cardápio mostra a inicial do prato numa moldura escura — nunca uma
imagem de outro prato no lugar.

## Reconhecimento: núcleo versão 3

O que decide não é mais só a distância entre a foto e o padrão: cada medição
informa, **grandeza por grandeza, o quanto ela merece confiança naquela foto**,
e o comparador usa esses pesos. Prato cortado pelo quadro derruba as grandezas
de posição; foto borrada derruba textura; louça estourada derruba cor. É isto
que faz o enquadramento deixar de ser exigência: o que não dá para medir
direito pesa menos, em vez de reprovar a foto inteira.

**Três grandezas novas** — `textura` (quanto a luz varia dentro da comida),
`contraste` e `matiz` (o quanto a cor é uniforme). Na bancada de prato liso ×
prato granulado, mesma cor e mesmo tamanho: com as 8 grandezas antigas a
separação era **1,02×** (o prato errado tão perto quanto o certo, empate); com
as 11, **5,2×**. Rode `node calibra-forma.js` para reproduzir.

**Enquadramento, medido em cena sintética:**

| situação | antes | agora |
|---|---|---|
| prato 63% visível | afastamento 8,4 — rejeitado | **2,6** — confirma na mão |
| metade do prato fora | recusava a foto | lê, decidindo por cor e textura |
| limite de prato visível | 55% | **35%** |
| prato encostado na borda | desvio 0,056 na ocupação | **0,017** |
| 320×240 contra 480×360 | textura 0,0136 | **0,0060** |
| 4032×3024, retrato, 1280×960 | — | desvio abaixo de 0,003 |

Duas correções de raiz sustentam isso: **ocupação** passou a ser comida ÷ prato
contando só a parte visível (antes dividia a comida visível pelo prato inteiro
reconstruído, e bastava o prato sair um pouco para ela despencar), e **textura
e contraste** passaram a ser medidos em escala do prato, com passo fracionário
interpolado, em vez de em pixels da foto.

**As medidas mudaram de definição, então os padrões precisam ser regravados**
pela câmera. O sistema detecta a diferença de versão e diz isso, em vez de
comparar coisas incomparáveis.

**Resíduo conhecido:** prato ocupando menos de ~15% de um quadro grande ainda
desloca a textura em ~0,02, porque a informação não está no quadro de trabalho.
Na prática o zoom automático evita esse caso; a solução completa seria o núcleo
remedir num recorte em resolução cheia, e não está feita.

## Automação da câmera

- **Zoom automático:** a lente aproxima ou afasta sozinha até o prato ocupar
  cerca de 62% do quadro, entre duas leituras do guia. Onde o aparelho não
  expõe zoom, nada acontece — a medição lê em qualquer tamanho de prato.
- **Lanterna automática** quando as leituras seguidas vêm escuras.
- **Prato já pendente:** se a mesa já espera aquele prato, o caminho normal
  deixa de ser "lançar" e passa a ser **"marcar entregue"** — lançar de novo
  cobraria duas vezes. Se nenhuma mesa foi escolhida e só uma espera aquele
  prato, ela aparece como um toque.
- **Continua valendo:** guia ao vivo 4×/s, foto sozinha quando o prato fica
  firme, três quadros com média, contagem de 3 s antes de lançar com desfazer,
  e trava contra lançar o mesmo prato duas vezes.

## Revisão: o que estava falhando

Cada item abaixo foi reproduzido executando antes de ser corrigido, e cada um
tem hoje um teste que **reprova a versão antiga e passa na nova** — conferido
rodando os testes novos contra o código anterior.

1. **O tempo real não entregava 8 dos 17 tipos de evento.** O servidor mandava
   eventos com nome, e o navegador só entrega evento nomeado a quem escuta
   aquele nome exato; as telas escutavam 9. Pedido do celular, item pronto,
   transferência, desconto e nota nunca chegavam — e os avisos sonoros de
   pedido do celular e de item pronto nunca tocaram. Agora é um canal só, com
   o tipo dentro do dado. O teste abre o canal de verdade, faz o cliente pedir
   e a cozinha marcar pronto, e confere que os dois chegam.
2. **"Dividir", na tela do cliente, levava ao PIN da equipe.** A tela chamava
   a rota da equipe; sem login, 401, e o 401 redirecionava. Agora há uma rota
   pelo código da conta, que só mexe em item daquela conta.
3. **Fuso.** A virada da noite e o gráfico por hora usavam o relógio do
   servidor; num servidor em UTC, a noite virava às 9h de Brasília e 23h
   aparecia como 2h. Agora todo cálculo de hora passa pelo fuso da casa
   (`FUSO`), e a bateria inteira passa com o servidor em outro fuso.
4. **Ticket médio misturava comandas abertas no cálculo** e mostrava ao lado o
   número só das fechadas. Agora é o que entrou dividido pelas que fecharam.
5. **"Pediu a conta" saía no barramento URB1 como chamada de garçom** — a
   comparação olhava o tipo do evento em vez do pedido.
6. **`captura.js` sumiu de uma cópia da entrega em silêncio** e a tela da
   câmera foi ao ar chamando `Captura.nova()` sem o arquivo. Agora um teste lê
   cada página, busca do servidor tudo que ela carrega e falha se faltar — e
   ele já pegou uma segunda falha na hora: a câmera usando `Alerta` sem
   carregar `alerta.js`.
7. **A versão do núcleo estava escrita à mão no servidor** (`=== 2 ? 2 : 1`):
   padrão medido pela v3 era gravado como v1, e nenhum prato voltaria a ser
   reconhecido depois de atualizar o núcleo. Um teste agora grava um padrão
   com o núcleo de verdade e exige que a foto seguinte seja reconhecida.

E o que foi endurecido ou otimizado:

- **Chamar o garçom** segura o segundo aviso igual em menos de 30 s — sem
  isso, um dedo nervoso fazia o tablet do salão apitar sem parar.
- **Código da conta com 48 bits** (12 caracteres) em vez de 32: varrer códigos
  atrás das contas abertas deixa de ser questão de dias.
- **Índice na tabela de eventos.** O salão a consultava mesa a mesa a cada
  leitura. Medido com uma semana de eventos (30 mil) e 18 mesas abertas:
  de 19,9 ms para 2,8 ms por leitura, 7× mais rápido. Medido neste ambiente;
  no Render free, não medi.
- **Recarga agrupada:** uma rajada de eventos vira uma leitura só, e uma
  recarga de segurança a cada 45 s cobre o canal que cair calado.
- **Cada tela ouve o que interessa a ela:** o passe apita quando entra item
  novo na fila; o salão, com chamadas, pedidos do celular e itens prontos.

**No reconhecimento:**

- **Três quadros por foto, e a média deles.** Mão tremendo muda as medidas de
  um quadro para o outro; a média derruba o ruído, e quando os quadros variam
  demais a tela avisa.
- **A camada 2 recebe só o recorte do prato**, não o quadro inteiro: menos
  imagem para a API, e nada de mãos e rostos de clientes indo para fora.
- **Pratos gêmeos avisados no cadastro:** ao gravar um padrão, o sistema mede a
  distância dele para os outros e diz na hora se a geometria não vai separar.
- **O acerto, medido no uso** (`/sistema`, painel 05): cada lançamento feito
  pela câmera junta o que o sistema previu com o que o garçom de fato lançou.
  Taxa por camada, pares confundidos, lançamentos estornados depois. Abaixo de
  30 confirmações o painel avisa que o número ainda não diz muito.

Depois desta revisão, o núcleo de medição foi refeito (versão 2): lê prato
parcialmente fora do quadro, inclinado, sob luz colorida, em mesa clara e em
tábua. Os números estão na seção "Reconhecimento do prato".

## Nota fiscal: NFC-e pela Focus NFe

"Cupom fiscal eletrônico", em Goiás e na maior parte do país, é a **NFC-e**
(modelo 65). A Focus NFe assina o XML e fala com a SEFAZ; o sistema monta o
pedido, envia, e guarda o que foi enviado e o que voltou. O contrato usado foi
conferido na documentação da Focus de abril de 2026: emissão **síncrona** em
`POST /v2/nfce?ref=…`, consulta em `GET`, cancelamento em `DELETE` com
justificativa de 15 a 255 caracteres **em até 30 minutos**, autenticação HTTP
Basic com o token.

**Três modos, e o sistema diz qual está valendo** (painel `/sistema`):

| Modo | Quando | O que sai |
|---|---|---|
| sem valor fiscal | sem `FOCUS_NFE_TOKEN` ou `FOCUS_NFE_CNPJ` | comprovante marcado SEM VALOR FISCAL; nada é enviado |
| homologação | com token, `FOCUS_NFE_AMBIENTE=homologacao` (padrão) | NFC-e de teste da SEFAZ, sem valor fiscal |
| produção | `FOCUS_NFE_AMBIENTE=producao` | NFC-e com valor fiscal — **só se todos os itens estiverem com o cadastro fiscal revisado** |

**No fechamento**, a caixa "emitir NFC-e" vem marcada quando a Focus está
configurada, com CPF opcional (validado pelos dígitos). Se a nota falhar, a
conta **não** é desfeita: foi paga, a mesa está livre, e a nota se reemite pela
gaveta ou pela tela da noite. Com `NFCE_AUTO=1`, toda conta fechada emite.

**Os cuidados que o código toma:**

- **Rede caindo no meio da emissão** é o caso perigoso: a SEFAZ pode ter
  autorizado e a resposta se perdido. A nota fica "pendente", e a próxima
  tentativa **consulta antes** e reusa a mesma referência — a Focus reconhece a
  referência e não emite duas vezes. Só uma rejeição da SEFAZ abre referência
  nova. O teste simula exatamente isso: autoriza, derruba a conexão, e confere
  que a venda termina com uma nota só.
- **Grava antes de enviar**: se o processo cair no meio, fica o registro de que
  uma nota foi para a Focus com aquela referência. Nenhuma nota é apagada —
  rejeitada, cancelada ou sem resposta, fica com o pedido e a resposta.
- **Comanda com nota autorizada não reabre** sem cancelar a nota antes.
- **Pix é o código 20 (Pix estático)**, não o 17: o Pix deste sistema é o QR
  gerado a partir da chave, sem PSP. Cartão vai como maquininha avulsa
  (`tipo_integracao` 2). Voucher entra como vale-refeição (11).
- **A taxa de serviço fica fora da nota** — não é mercadoria. Como o cliente
  pagou mais do que a nota soma, e a SEFAZ leria a diferença como troco, cada
  forma de pagamento entra na nota com a sua proporção do total da nota, e a
  soma bate no centavo.
- **Data de emissão com fuso de Brasília explícito** (`NFCE_FUSO`, padrão
  `-03:00`); a Focus recusa diferença de mais de 5 minutos do relógio.

**O que é do contador, e por isso é editável e não decidido por mim:** NCM,
CFOP, CSOSN/CST, origem e unidade de cada item (em `/cardapio`, botão
"fiscal"). A carga inicial traz **exemplos** por tipo de item — preparo da
cozinha, cerveja, refrigerante, água, vinho, drink — e todos saem marcados como
**não revisados**. A homologação aceita; a produção recusa até o contador
marcar "revisado". Tratar o serviço de outro jeito na nota também é decisão
dele.

**Reforma Tributária:** segundo a Focus, os campos de IBS/CBS por item entraram
em produção em novembro de 2025, com validação ativa a partir de abril de 2026.
**Não sei se o seu regime precisa deles na NFC-e hoje** — isso é pergunta para o
contador. Se precisar, o campo "extra" do cadastro fiscal de cada item aceita o
JSON que ele indicar e vai direto para a nota, sem mudar código. O sistema
impede que esse extra sobrescreva quantidade, preço ou desconto.

**O cupom** (`/cupom?c=CÓDIGO`) é o resumo da nota para o cliente, em papel
claro de 80 mm na impressão, com o QR de consulta e a chave de acesso. Para a
impressão oficial existe o botão "DANFE oficial", que abre o DANFE gerado pela
Focus — o layout do DANFE NFC-e é regulado, e o documento com validade é o
dela.

**O que não está feito:** contingência offline (a Focus oferece, com
comunicador próprio), inutilização de numeração e envio por e-mail. E nada
disso foi testado contra a Focus de verdade — os testes usam um dublê que segue
o contrato da documentação. **O primeiro teste real é em homologação**, com o
token de homologação da sua conta na Focus.

## Claude no sistema

### Ligar a IA no Render

1. Crie a chave em **console.anthropic.com → API Keys** e coloque crédito em
   **Billing** — sem crédito, a API responde que a conta está sem saldo.
2. No Render, `ANTHROPIC_API_KEY` = a chave. Salve e deixe redeployar.
3. Entre como gerente, abra **`/sistema`** e toque em **"testar agora"** no
   painel da IA. Ele faz uma chamada de verdade, de 10 tokens, e mostra o que a
   API respondeu — ou o motivo, em português: chave recusada, sem crédito,
   limite de uso, API sobrecarregada.

Conferido daqui contra a API real: o endpoint, os cabeçalhos e o formato do
pedido passam até a autenticação, e uma chave inválida volta como "a chave da
API foi recusada". O que eu não pude ver foi uma resposta completa — isso só com
a sua chave, e é exatamente o que o botão de teste mostra.


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

Serviço: 10% por padrão, destacado como opcional nas duas telas.

## Reconhecimento do prato

### Como a câmera trabalha agora

Abra `/camera`, escolha a mesa nos botões do topo e aponte. **Não precisa
centralizar nem tocar em nada**:

1. quatro vezes por segundo, o guia lê o vídeo e desenha **o contorno do prato
   por cima da imagem**, onde quer que ele esteja — teal lendo, latão já lido,
   vermelho recusado;
2. quando o prato fica parado por cerca de um segundo, o anel em volta do
   contorno enche e a câmera **fotografa sozinha**: três quadros seguidos, e a
   média deles (mão tremendo muda as medidas de um quadro para o outro);
3. se a geometria tiver certeza, **conta 3 segundos e lança na mesa** — com
   "cancelar" durante a contagem e "desfazer" depois;
4. e **trava**: o mesmo prato parado no quadro não é lançado de novo. Destrava
   quando o prato sai (uma mão passando na frente não conta) ou quando outro
   prato entra no lugar.

A lógica de quando fotografar mora em `captura.js`, separada da tela, porque é
a parte que, errando, lança o mesmo prato duas vezes na conta de alguém. Há
teste para cada uma dessas regras, e um teste que abre a página real da câmera
e deixa ela achar, fotografar, reconhecer e lançar sozinha — e conferir que
não lançou duas vezes.

Na tela ainda: lanterna (quando o aparelho deixa), troca de câmera, AUTO
liga/desliga, foto do rolo, e a tela fica acesa enquanto a câmera está aberta.
Espaço fotografa; `a` liga e desliga o automático.

**Ensinar um prato** (botão ＋): escolha o prato, monte do jeito aprovado e
aponte. A cada foto, mexa um pouco o prato — o padrão precisa aprender a
folga. Com cinco fotos ele grava sozinho; a primeira pode ir para o cardápio.
Se o prato novo se confunde com outro, o aviso sai na hora.

### O núcleo de medição, versão 2

O núcleo anterior achava "a maior mancha clara" e exigia o prato inteiro no
quadro, de cima, em louça clara sobre mesa escura. O novo:

- **acha a borda, não a mancha:** ajusta uma elipse direto aos pontos do
  contorno que aparecem (Halir & Flusser), com amostragem robusta que ignora
  comida por cima da aba, copo encostado ou um segundo prato. Com a forma
  reconstruída, **a parte que ficou fora do quadro deixa de importar** — o
  ajuste acha o centro a 0,2 px com só 200° do contorno à vista;
- **mede em coordenadas do próprio prato:** prato inclinado vira círculo antes
  da medição, então o ângulo deixa de deformar as grandezas;
- **usa a aba branca como referência de cor** (correção de von Kries, ganho por
  canal no RGB linear). Se a louça estourou em dois canais, não corrige e avisa;
- **lê tábua e travessa** (retângulo competindo com a elipse);
- **separa o prato do fundo pela cor da moldura da foto**, então mesa clara,
  mesa de madeira e prato escuro funcionam;
- **qualquer resolução:** leva o lado maior a 480 px, reduzindo com filtro de
  caixa próprio ou ampliando;
- **sabe quando a comida saiu do quadro**, e manda ao servidor uma folga extra
  que reduz o peso das medidas de posição — em vez de errar com confiança.

Medido em cenas controladas (`node calibra-forma.js` reproduz a tabela). O
desvio é a maior diferença entre a medição e a mesma cena bem enquadrada; a
folga típica de um padrão fica entre 0,01 e 0,02.

| caso | núcleo anterior | núcleo novo |
|---|---|---|
| prato encostado na borda da foto (9% fora) | recusava | lê · desvio 0,000 |
| prato bem para fora (37% fora) | recusava | lê · desvio 0,073, com folga ×2 avisada |
| metade do prato para fora | recusava | recusa: "afaste ou centralize um pouco" |
| inclinado ~53° | desvio 0,074 | desvio 0,001 |
| luz fria / quente / verde | desvio 0,053 / 0,046 / 0,059 | 0,005 / 0,011 / 0,004 |
| mesa clara | recusava | lê · desvio 0,000 |
| tábua girada | recusava | lê como tábua |
| dois pratos encostados, copo ao lado, toalha xadrez | — | acha o prato certo |
| 1280×960, retrato, prato pequeno | desvio ≤ 0,007 | ≤ 0,002 |

Tempo por foto, **neste servidor**: 85 ms a medição completa e 17 ms o guia ao
vivo. Num tablet não medi — a estimativa é duas a três vezes mais.

### A decisão, em camadas

As 8 grandezas vão ao servidor, que calcula o afastamento de Mahalanobis
diagonal contra o envelope de cada prato:
- **camada 0** — afastamento < 1,8 e o 2º colocado pelo menos 35% mais longe:
  decide sozinho, sem custo de API. É a única que lança automaticamente;
- **camada 1** — empate: mostra os candidatos e pergunta;
- **camada 2** — com foto e chave da API, o **recorte do prato** vai ao modelo
  de visão, que escolhe entre os candidatos ou diz que não sabe. O veredito sai
  marcado como não medido, e o lançamento pede confirmação;
- **camada 3** — nenhum padrão explica a foto.

**Padrões gravados com o núcleo anterior não valem mais:** as grandezas mudaram
de definição, e o servidor não compara medição de uma versão com padrão da
outra — diz para regravar. O painel 05 de `/sistema` mostra quantos padrões há
de cada versão.

### O que não está medido, e o que continua sem solução

- **Nenhuma taxa de acerto em foto real.** Tudo acima é em cena sintética: prova
  que o método está certo, não quanto ele acerta nos pratos da sua casa. O painel
  05 de `/sistema` mede isso no uso — cada lançamento pela câmera junta o que o
  sistema previu com o que o garçom lançou.
- Os limiares de decisão (1,8 / 3,2 / 1,35) continuam valores de partida.
- **Pratos que só diferem na altura** — burguer simples e duplo vistos de cima
  — seguem difíceis: a foto é de cima. O aviso de gêmeos no cadastro diz quando
  é o caso.
- Comida branca em louça branca, e comida cobrindo a aba inteira, tiram do
  núcleo a referência de fundo.
- Louça de vidro ou transparente não foi testada.
- O guia ao vivo usa o reescalonador do navegador (rápido, mas muda entre
  aparelhos). É só guia: a foto que vira medição passa pelo caminho
  determinístico.

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

## Segurança

**Sessão que sobrevive ao restart.** O token é assinado com HMAC-SHA256 e não
fica guardado em memória. No Render free o processo hiberna e reinicia; antes,
cada acordada deslogava o salão inteiro. Agora qualquer processo com o mesmo
`SESSAO_SEGREDO` reconhece o token. O token carrega só o id e a validade — nome
e papel vêm do banco a cada requisição, então desativar alguém ou tirar o papel
de gerente vale na hora. **Sem `SESSAO_SEGREDO` configurado, o sistema sorteia
um a cada arranque e volta a deslogar todo mundo a cada restart.**

**Trava de PIN.** Cinco erros seguidos bloqueiam a origem por 30 s, dobrando a
cada novo bloqueio até 30 min; acertar zera. Por cima disso, mais de 20 erros
por minuto somando todas as origens fazem a entrada recusar sem nem conferir o
PIN até o minuto virar — é essa trava que segura quem troca de IP a cada
tentativa. O que ela não resolve: PIN de 4 dígitos continua sendo 10.000
combinações, e o teto geral deixa um atacante paciente testar todas em algumas
horas. **A correção de verdade é PIN de 6 dígitos**, e isso é só trocar a
lista `EQUIPE` no `seed.js`.

**Cabeçalhos em toda resposta.** `Referrer-Policy: no-referrer` importa mais do
que parece: a URL do cliente carrega o código da comanda, que é o que dá acesso
à conta dele, e sem isso o navegador mandaria esse código para o Google Fonts e
para o cdnjs. CSP com `frame-ancestors 'none'`, `nosniff`, HSTS quando atrás de
HTTPS, e câmera liberada só para a própria origem. A CSP mantém
`'unsafe-inline'` de propósito: as páginas têm script embutido e você edita os
arquivos à mão — CSP por hash quebraria a cada vírgula alterada.

## Estorno reversível

Estorno não apaga mais: marca o item com hora e autor. Ele some da conta, do
passe e do rateio, mas fica no banco — estorno é o lugar clássico de desvio em
bar (o garçom cobra, o cliente paga, o garçom estorna e fica com o dinheiro), e
a tela da noite lista **cada estorno com quem fez e a que horas**. Na gaveta não
há diálogo de confirmação: o estorno acontece e aparece "desfazer" por 10 s; o
servidor aceita desfazer por 2 min.

## Atalhos da equipe

**Ação do momento no cartão.** Cada mesa mostra o botão do que ela precisa
agora — "aceitar 2" se há pedido do celular, "levei 3" se há prato pronto,
"fechar conta" se pediram a conta. Um toque, sem abrir a gaveta.

**Barra de espera.** A linha fina no pé do cartão enche com o tempo da comida
mais antiga na fila e fica vermelha depois de 20 min. Varredura de longe, sem
ler número.

**Toque.** Em tela de toque, botões pequenos crescem para 40–44 px — estorno
principalmente. Com pouca luz e mão ocupada, alvo de 24 px erra.

**Passe em modo TV** (`/passe?tv=1`): para a tela na parede da cozinha. Sem
navegação, letra grande, relógio no canto.


Na tela do salão, digitar o número de uma mesa e apertar Enter abre a gaveta
dela. O garçom sabe o número de cor; procurar na grade é o passo que sobra.
Backspace corrige, e a caixinha some sozinha depois de 2,5 s.

## Estética

**Gramática do UROBOROS, paleta do Burguer.** A estrutura é a mesma língua dos
outros sistemas: preto, IBM Plex Mono como voz do sistema, rótulos em caixa
alta espaçada, painéis numerados `[01]`, calibres, barramento URB1 em hex,
densidade de instrumento. A cor é da casa.

Uma regra separa as duas e vale em toda a folha: **o teal é do instrumento, o
vermelho é da casa, e eles não se cruzam.** Telemetria, calibres, medição e
mira da câmera são teal (`--instru`). Chamada, urgência e marca são o vermelho
medido (`--marca`). Dinheiro é âmbar (`--chopp`).

O vermelho `#e30613` é a cor da casa; os neutros vêm da paleta reduzida da foto
do salão (`#2a1913` no
escuro, `#b08764` na madeira, `#d0bfa4` na luz dos globos). Trocar o bloco
`:root` no topo de `burguer.css` muda o sistema inteiro:

```css
--marca: #e30613;  --breu:  #0b0806;  --painel: #12100d;
--risco: #2e241c;  --papel: #f2e9d8;  --latao:  #c08a2e;
--chopp: #f0b429;  --folha: #7d8a5f;  --instru: #3f9e91;
--foto: url(/casa.jpg);   --veu: .91;
```

Há escala de espaço (`--e1` a `--e6`) e de raio (`--r1` a `--r3`): nenhum
padding solto no arquivo, o que é o que faz o conjunto parecer uma peça só.
Números em `tabular-nums` — coluna de valor não dança quando o total muda.

`casa.jpg` é a foto de fundo do salão — troque pela da sua casa para a demonstração
ficar sua. véu por cima controlado por `--veu`: 0,9 nas telas de trabalho, onde há número
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

1. Crie um repositório **privado** vazio, ex.: `MarcusAndMarcus/burguer-dados`,
   com um commit inicial no ramo `main` (pode ser um README de uma linha —
   a API precisa do ramo existindo).
2. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained**, só esse repositório, permissão **Contents: Read and write**.
3. No painel do Render, preencha `SNAP_REPO` e `SNAP_TOKEN`.

O token fica só no painel: as duas chaves estão como `sync: false` no
`render.yaml` justamente para não irem para o repositório do código.

### Deploy (a partir do Termux)

```bash
cd burguer-salao
git init && git add -A && git commit -m "salao"
git remote add origin git@github.com:MarcusAndMarcus/burguer-salao.git
git push -u origin main
```

No Render: **New → Blueprint**, aponte o repositório, ele lê o `render.yaml`.
Preencha `PIX_CHAVE`, `SNAP_REPO` e `SNAP_TOKEN` no painel.

### Quando o deploy falha

**`Cannot find module '/opt/render/project/src/server.js'`** — os arquivos estão
numa subpasta do repositório, e o Render roda a partir da raiz. O próprio log
entrega isso na linha `Using Node.js version ... via burguer-salao/package.json`:
se aparece um caminho com pasta ali, a raiz está um nível abaixo. Resolve-se em
Settings → **Root Directory** = nome da pasta (`burguer-salao`). Blueprint é
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
| `SESSAO_SEGREDO` | assina as sessões; qualquer texto longo e aleatório |
| `ANTHROPIC_API_KEY` | liga o assistente do cliente, o da equipe e a camada 2 da câmera |
| `FOCUS_NFE_TOKEN` | token da Focus NFe (o de homologação ou o de produção) |
| `FOCUS_NFE_CNPJ` | CNPJ do emitente, com ou sem pontuação |
| `FOCUS_NFE_AMBIENTE` | `homologacao` (padrão) ou `producao` |
| `NFCE_AUTO` | `1` para toda conta fechada emitir NFC-e |
| `NFCE_FUSO` | fuso da data de emissão (padrão `-03:00`) |
| `FUSO` | fuso da casa para a noite e o gráfico por hora (padrão `-03:00`) |
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

**QR** (`/qr?mesa=7&area=deck&c=CÓDIGO`): o QR leva o código **desta comanda**,
não da mesa — ao fechar a conta, ele deixa de valer. É de propósito: um QR fixo
na mesa deixaria quem guardou o link ver a conta dos próximos clientes. Mostre
no tablet ao abrir a mesa, ou imprima no ticket de abertura; **não plastifique**.
Número da mesa em corpo grande, QR nas cores da casa, estilo de impressão em
preto no branco. O encoder é o `qrcodejs` pelo cdnjs,
com `integrity` fixado — não escrevi encoder de QR à mão, que é risco sem
retorno. O botão "QR desta mesa" fica na aba Comanda da gaveta.

## O que ainda não existe
- NFC-e em contingência offline, inutilização de numeração e envio por e-mail;
- sangria, suprimento e fechamento de caixa por operador;
- baixa automática do Pix (hoje é confirmação manual);
- reserva de mesa e brinquedoteca;
- calibração do reconhecimento com fotos reais e rótulo do passe — **este é o
  item que decide se a câmera serve para lançar sozinha ou só para conferir**.
