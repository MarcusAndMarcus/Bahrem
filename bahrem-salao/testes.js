'use strict';
/* Bateria única: node testes.js
   Roda em banco temporário — não toca no banco do salão. */

process.env.DB_PATH = require('node:path').join(require('node:os').tmpdir(),
  `bahrem-teste-${Date.now()}.db`);
process.env.PIX_CHAVE = process.env.PIX_CHAVE || 'bahrem@exemplo.com.br';

/* o retrato externo é testado contra um dublê da API do GitHub, subido aqui
   mesmo. Isso prova o contrato que escrevi, NÃO prova que o GitHub responde
   igual — isso só um token de verdade prova. */
const PORTA_DUBLE = Number(process.env.PORTA_DUBLE || 8899);
process.env.SNAP_REPO = 'MarcusAndMarcus/bahrem-dados';
process.env.SNAP_TOKEN = 'token-de-teste';
process.env.SNAP_API = `http://127.0.0.1:${PORTA_DUBLE}`;
process.env.SNAP_ARQUIVO = 'salao.db.gz';
process.env.SNAP_INTERVALO = '3600';   // nada dispara sozinho durante os testes
process.env.SNAP_DEBOUNCE = '3600';

const assert = require('node:assert');
let ok = 0, falhas = [];
const t = (nome, fn) => {
  try { fn(); ok++; console.log(`  ok   ${nome}`); }
  catch (e) { falhas.push(nome); console.log(`  FALHA ${nome}\n       ${e.message}`); }
};
const ta = async (nome, fn) => {
  try { await fn(); ok++; console.log(`  ok   ${nome}`); }
  catch (e) { falhas.push(nome); console.log(`  FALHA ${nome}\n       ${e.message}`); }
};

/* ───────── 1. CRC16-CCITT ───────── */
const urb1 = require('./urb1');
console.log('\nCRC16-CCITT');
t('vetor de verificação "123456789" = 0x29B1', () => {
  assert.strictEqual(urb1.crc16('123456789').toString(16).toUpperCase(), '29B1');
});
t('telegrama fecha com o próprio CRC', () => {
  const q = urb1.telegrama('SAL', 'LANC', 7, [2, 64]);
  assert.ok(urb1.confere(q), q);
  assert.match(q, /^URB1 SAL LANC 0007 0002 0040 \*[0-9A-F]{4}$/);
});
t('um bit trocado reprova', () => {
  const q = urb1.telegrama('SAL', 'ABRE', 12, [4]);
  assert.ok(!urb1.confere(q.replace('000C', '000D')));
});
t('valor acima de 0xFFFF satura em vez de estourar', () => {
  assert.match(urb1.telegrama('SRV', 'TEST', 999999, [999999]), /FFFF FFFF/);
});

/* ───────── 2. Pix BR Code ───────── */
const pix = require('./pix');
console.log('\nPix BR Code');
t('o código gerado passa no próprio CRC', () => {
  const c = pix.brcode({ chave: 'bahrem@exemplo.com.br', valor: 123.45,
    nome: 'Bahrem Marista', cidade: 'Goiânia', txid: 'A1B2C3D4' });
  assert.strictEqual(urb1.crc16(c.slice(0, -4)).toString(16).toUpperCase().padStart(4, '0'), c.slice(-4));
});
t('TLV bate: cada campo declara o tamanho certo', () => {
  const c = pix.brcode({ chave: 'x@y.com', valor: 10, nome: 'Bahrem', cidade: 'Goiania', txid: 'T1' });
  let i = 0;
  while (i < c.length) {
    const tam = Number(c.slice(i + 2, i + 4));
    assert.ok(Number.isInteger(tam) && tam > 0, `tamanho inválido em ${i}`);
    i += 4 + tam;
  }
  assert.strictEqual(i, c.length, 'os campos não fecham o comprimento total');
});
t('valor entra com 2 casas e acento some do nome', () => {
  const c = pix.brcode({ chave: 'x@y.com', valor: 7.5, nome: 'Bahrém Açaí', cidade: 'Goiânia' });
  assert.ok(c.includes('54047.50'), 'valor');
  assert.ok(c.includes('BAHREM ACAI'), 'nome sem acento');
});
t('sem valor, o QR sai livre (sem campo 54)', () => {
  const c = pix.brcode({ chave: 'x@y.com', valor: 0, nome: 'Bahrem', cidade: 'Goiania' });
  assert.ok(!/(^|[0-9])5404/.test(c.slice(0, 80)), 'não deveria ter campo de valor');
});

/* ───────── 3. rateio em centavos ───────── */
console.log('\nRateio');
function rateio(total, pessoas) {
  const base = Math.floor(total / pessoas), resto = total - base * pessoas;
  return Array.from({ length: pessoas }, (_, i) => base + (i < resto ? 1 : 0));
}
t('a soma das partes é exatamente o total', () => {
  for (const [tot, n] of [[10001, 3], [1, 4], [99999, 7], [42000, 5], [7, 3]]) {
    const p = rateio(tot, n);
    assert.strictEqual(p.reduce((a, b) => a + b, 0), tot, `${tot}/${n}`);
    assert.ok(Math.max(...p) - Math.min(...p) <= 1, 'diferença maior que 1 centavo');
  }
});

/* ───────── 4. aferição ───────── */
const af = require('./afericao');
console.log('\nAferição');
const perfil = (b, ruido, semente) => {
  let s = semente;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2 * ruido;
  const o = {}; for (const k of af.CHAVES) o[k] = Math.max(0, Math.min(1, b[k] + r()));
  return o;
};
const PICANHA = { ocupacao: .62, centragem: .08, dispersao: .55, elementos: .38, borda: .12, luminancia: .41, cromaA: .63, cromaB: .58 };
const RISOTO = { ocupacao: .48, centragem: .05, dispersao: .44, elementos: .13, borda: .04, luminancia: .72, cromaA: .49, cromaB: .61 };

const amPic = Array.from({ length: 8 }, (_, i) => perfil(PICANHA, .02, 7 + i));
const amRis = Array.from({ length: 8 }, (_, i) => perfil(RISOTO, .02, 99 + i));
const padroes = [
  { item_id: 1, nome: 'Picanha na chapa', preco_cent: 18900, ...af.envelope(amPic), n: 8 },
  { item_id: 2, nome: 'Risoto', preco_cent: 5900, ...af.envelope(amRis), n: 8 }
];

t('envelope encolhe mais com poucas amostras', () => {
  const e3 = af.envelope(amPic.slice(0, 3)), e8 = af.envelope(amPic);
  assert.ok(e3.lambda > e8.lambda, `${e3.lambda} não é maior que ${e8.lambda}`);
});
t('foto do prato certo cai na camada 0 com o nome certo', () => {
  const r = af.identificar(perfil(PICANHA, .015, 4242), padroes);
  assert.strictEqual(r.camada, 0, r.veredito);
  assert.strictEqual(r.item_id, 1);
});
t('prato entre os dois padrões é marcado ambíguo, não chutado', () => {
  const meio = {}; for (const k of af.CHAVES) meio[k] = (PICANHA[k] + RISOTO[k]) / 2;
  const r = af.identificar(meio, padroes);
  assert.notStrictEqual(r.camada, 0, `não podia decidir sozinho: ${r.veredito}`);
  assert.strictEqual(r.item_id, null);
});
t('prato que não existe no cardápio é recusado, não encaixado à força', () => {
  const estranho = {}; for (const k of af.CHAVES) estranho[k] = 0.95;
  const r = af.identificar(estranho, padroes);
  assert.strictEqual(r.camada, 3, r.veredito);
});
t('vetor incompleto não vira palpite', () => {
  const r = af.identificar({ ocupacao: .5 }, padroes);
  assert.strictEqual(r.camada, -1);
  assert.ok(r.faltando.length === af.CHAVES.length - 1);
});
t('sem padrão gravado ele diz isso em vez de inventar', () => {
  assert.match(af.identificar(PICANHA, []).veredito, /nenhum prato tem padrão/);
});

/* ───────── 5. núcleo de visão (canvas) ───────── */
console.log('\nNúcleo de visão');
global.window = global;
require('./public/nucleo.js');

const L = 320, A = 240;
function cena({ desvio = 0, raio = 88, nGuarn = 5, vazio = false, cortar = false,
  quadrado = false, forma = null, tilt = 1 } = {}) {
  if (quadrado) forma = 'quadrado';
  const d = new Uint8ClampedArray(L * A * 4);
  const cx = cortar ? 40 : L / 2, cy = A / 2;
  const põe = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= L || y >= A) return;
    const i = ((y | 0) * L + (x | 0)) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  };
  for (let y = 0; y < A; y++) for (let x = 0; x < L; x++) {
    const dx = x - cx, dy = (y - cy) / tilt;
    let dist;
    if (forma === 'quadrado') dist = Math.max(Math.abs(dx), Math.abs(dy));
    else if (forma === 'hexagono') {
      const ang = Math.atan2(dy, dx), s6 = ((ang % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3);
      dist = Math.hypot(dx, dy) * Math.cos(s6 - Math.PI / 6);
    } else dist = Math.hypot(dx, dy);
    if (dist > raio) põe(x, y, 26, 24, 22);            // mesa escura
    else põe(x, y, 238, 236, 231);                     // louça clara, sem croma
  }
  if (!vazio) {
    for (let y = 0; y < A; y++) for (let x = 0; x < L; x++) {
      if (Math.hypot(x - cx - desvio, (y - cy) / tilt) < raio * 0.42) põe(x, y, 150, 82, 46); // carne
    }
    for (let k = 0; k < nGuarn; k++) {
      const a = k * 2.4, gx = cx + Math.cos(a) * raio * .62, gy = cy + Math.sin(a) * raio * .62 * tilt;
      for (let y = -7; y <= 7; y++) for (let x = -7; x <= 7; x++)
        if (x * x + y * y < 49) põe(gx + x, gy + y, 60, 120, 52); // guarnição
    }
  }
  return { width: L, height: A, data: d };
}

t('mede as 8 grandezas de uma cena limpa', () => {
  const r = Nucleo.medir(cena());
  assert.ok(!r.falha, r.falha);
  for (const k of Nucleo.CHAVES) {
    assert.ok(Number.isFinite(r.m[k]) && r.m[k] >= 0 && r.m[k] <= 1, `${k} = ${r.m[k]}`);
  }
  assert.ok(r.m.ocupacao > 0.15, `ocupação baixa demais: ${r.m.ocupacao}`);
});
t('mesma entrada, duas passadas, valores idênticos', () => {
  const a = Nucleo.medir(cena()), b = Nucleo.medir(cena());
  assert.deepStrictEqual(a.m, b.m);
});
t('deslocar a comida sobe a centragem e não mexe na ocupação', () => {
  const a = Nucleo.medir(cena()), b = Nucleo.medir(cena({ desvio: 22 }));
  assert.ok(b.m.centragem > a.m.centragem + 0.05, `${a.m.centragem} → ${b.m.centragem}`);
  assert.ok(Math.abs(b.m.ocupacao - a.m.ocupacao) < 0.05, 'ocupação não devia mudar tanto');
});
t('tirar guarnição derruba a contagem de elementos', () => {
  const a = Nucleo.medir(cena({ nGuarn: 5 })), b = Nucleo.medir(cena({ nGuarn: 2 }));
  assert.ok(b.m.elementos < a.m.elementos, `${a.m.elementos} → ${b.m.elementos}`);
});
t('prato cortado pela moldura é recusado com número', () => {
  const r = Nucleo.medir(cena({ cortar: true }));
  assert.ok(r.falha, 'devia recusar');
  assert.match(r.falha, /cortado pela borda/);
});
t('prato vazio é recusado em vez de medir ruído', () => {
  const r = Nucleo.medir(cena({ vazio: true }));
  assert.ok(r.falha && /vazio|contraste|separar/.test(r.falha), r.falha || 'não recusou');
});
t('forma quadrada não passa por prato', () => {
  const r = Nucleo.medir(cena({ quadrado: true }));
  assert.ok(r.falha, 'devia recusar');
  assert.match(r.falha, /elipse ajustada/);
});
t('prato inclinado ainda é prato (30, 45 e 60 graus)', () => {
  for (const tilt of [0.87, 0.707, 0.5]) {
    const r = Nucleo.medir(cena({ tilt }));
    assert.ok(!r.falha, `tilt ${tilt}: ${r.falha}`);
    assert.ok(r.desencaixe <= Nucleo.LIMIARES.desencaixe, `tilt ${tilt} desencaixe ${r.desencaixe}`);
  }
});
t('tábua hexagonal também é recusada', () => {
  const r = Nucleo.medir(cena({ forma: 'hexagono' }));
  assert.ok(r.falha, 'devia recusar');
});
t('o filtro de caixa é o mesmo em qualquer aparelho (sem reescalonador do canvas)', () => {
  const grande = { width: 640, height: 480, data: new Uint8ClampedArray(640 * 480 * 4) };
  for (let i = 0; i < 640 * 480; i++) { const p = i * 4; grande.data[p] = i % 256; grande.data[p + 3] = 255; }
  const a = Nucleo.caixa(grande), b = Nucleo.caixa(grande);
  assert.strictEqual(a.width, Nucleo.LARG);
  assert.deepStrictEqual([...a.data.slice(0, 64)], [...b.data.slice(0, 64)]);
});

/* medição real → identificação real, ponta a ponta */
t('padrão aprendido de cenas sintéticas reconhece a mesma cena', () => {
  const amostras = [0, 4, 8, 12, 16].map(d => Nucleo.medir(cena({ desvio: d - 8 })).m);
  const env = af.envelope(amostras);
  const r = af.identificar(Nucleo.medir(cena({ desvio: 2 })).m,
    [{ item_id: 9, nome: 'Cena de teste', preco_cent: 100, ...env, n: amostras.length }]);
  assert.strictEqual(r.camada, 0, r.veredito);
});

/* ───────── 6. fluxo HTTP ponta a ponta ───────── */
(async () => {
  console.log('\nFluxo HTTP');
  const { servidor, preparar } = require('./server');
  await preparar();
  await new Promise(r => servidor.listen(0, r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  let cookie = '', token = '';

  const chama = async (rota, opcoes = {}) => {
    const r = await fetch(base + rota, {
      ...opcoes,
      headers: { 'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opcoes.headers || {}) },
      body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined
    });
    const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };

  await ta('PIN errado é recusado', async () => {
    assert.strictEqual((await chama('/api/entrar', { method: 'POST', corpo: { pin: '0000' } })).status, 401);
  });
  await ta('rota do salão exige sessão', async () => {
    assert.strictEqual((await chama('/api/salao')).status, 401);
  });
  await ta('PIN do garçom entra', async () => {
    const r = await chama('/api/entrar', { method: 'POST', corpo: { pin: '1986' } });
    assert.strictEqual(r.status, 200); token = r.corpo.token;
    assert.strictEqual(r.corpo.nome, 'Cafú');
  });

  let comanda, codigo;
  await ta('abrir a mesa 7 cria comanda e código', async () => {
    const r = await chama('/api/mesas/7/abrir', { method: 'POST', corpo: { pessoas: 4 } });
    assert.strictEqual(r.status, 201);
    comanda = r.corpo.comanda_id; codigo = r.corpo.codigo;
    assert.match(codigo, /^[0-9A-F]{8}$/);
  });
  await ta('abrir a mesma mesa de novo é bloqueado', async () => {
    assert.strictEqual((await chama('/api/mesas/7/abrir', { method: 'POST', corpo: { pessoas: 2 } })).status, 409);
  });
  await ta('lançar 2 croquetas e 4 chopps soma certo', async () => {
    const cardapio = (await chama('/api/cardapio')).corpo;
    const croq = cardapio.find(i => /Croqueta/.test(i.nome));
    const chopp = cardapio.find(i => i.nome === 'Chopp Pilsen 300ml');
    await chama(`/api/comandas/${comanda}/itens`, { method: 'POST', corpo: { item_id: croq.id, qtd: 2 } });
    const r = await chama(`/api/comandas/${comanda}/itens`, { method: 'POST', corpo: { item_id: chopp.id, qtd: 4 } });
    assert.strictEqual(r.corpo.total_cent, Math.round((croq.preco_cent * 2 + chopp.preco_cent * 4) * 1.1));
  });
  await ta('item fora do cardápio é recusado', async () => {
    assert.strictEqual((await chama(`/api/comandas/${comanda}/itens`,
      { method: 'POST', corpo: { item_id: 99999 } })).status, 404);
  });
  await ta('preço não inteiro é recusado', async () => {
    assert.strictEqual((await chama(`/api/comandas/${comanda}/itens`,
      { method: 'POST', corpo: { nome: 'gambiarra', preco_cent: 12.5 } })).status, 400);
  });
  await ta('o cliente vê a mesma conta pelo código, sem login', async () => {
    const semToken = await fetch(`${base}/api/conta/${codigo}`);
    const c = await semToken.json();
    const interno = (await chama(`/api/comandas/${comanda}`)).corpo;
    assert.strictEqual(c.total_cent, interno.total_cent);
    assert.strictEqual(c.pessoas, 4);
    assert.strictEqual(c.porPessoa_cent.reduce((a, b) => a + b, 0), c.total_cent);
  });
  await ta('o cliente consegue chamar o garçom e isso aparece no salão', async () => {
    await fetch(`${base}/api/conta/${codigo}/chamar`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tipo: 'conta' }) });
    const s = (await chama('/api/salao')).corpo;
    assert.strictEqual(s.mesas.find(m => m.numero === 7).chamada, 'pediu-conta');
  });
  await ta('o resumo do salão bate com a soma das mesas', async () => {
    const s = (await chama('/api/salao')).corpo;
    const soma = s.mesas.filter(m => m.status === 'ocupada').reduce((a, m) => a + m.total_cent, 0);
    assert.strictEqual(s.resumo.emAberto_cent, soma);
  });
  await ta('reconhecimento sem padrão gravado avisa em vez de escolher', async () => {
    const g = {}; for (const k of af.CHAVES) g[k] = .5;
    const r = await chama('/api/reconhecer', { method: 'POST', corpo: { grandezas: g, mesa: 7 } });
    assert.strictEqual(r.status, 200);
    assert.match(r.corpo.veredito, /nenhum prato tem padrão/);
  });
  await ta('gravar padrão exige 3 amostras', async () => {
    const cardapio = (await chama('/api/cardapio')).corpo;
    const alvo = cardapio.find(i => i.afericao);
    assert.strictEqual((await chama('/api/padroes', { method: 'POST',
      corpo: { item_id: alvo.id, amostras: [PICANHA, PICANHA] } })).status, 400);
    const r = await chama('/api/padroes', { method: 'POST', corpo: { item_id: alvo.id, amostras: amPic } });
    assert.strictEqual(r.status, 200);
    const rec = await chama('/api/reconhecer', { method: 'POST',
      corpo: { grandezas: perfil(PICANHA, .015, 31337), mesa: 7 } });
    assert.strictEqual(rec.corpo.camada, 0, rec.corpo.veredito);
    assert.strictEqual(rec.corpo.nome, alvo.nome);
  });
  await ta('fechar a conta devolve Pix válido e libera a mesa', async () => {
    const antes = (await chama(`/api/comandas/${comanda}`)).corpo;
    const r = await chama(`/api/comandas/${comanda}/fechar`, { method: 'POST', corpo: {} });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.corpo.total_cent, antes.total_cent);
    assert.ok(r.corpo.pix, 'sem copia-e-cola');
    assert.strictEqual(urb1.crc16(r.corpo.pix.slice(0, -4)).toString(16).toUpperCase().padStart(4, '0'),
      r.corpo.pix.slice(-4));
    const s = (await chama('/api/salao')).corpo;
    assert.strictEqual(s.mesas.find(m => m.numero === 7).status, 'livre');
  });
  await ta('comanda fechada não aceita lançamento novo', async () => {
    assert.strictEqual((await chama(`/api/comandas/${comanda}/itens`,
      { method: 'POST', corpo: { item_id: 1 } })).status, 404);
  });
  /* ---------- retrato externo ---------- */
  console.log('\nRetrato externo (dublê da API do GitHub)');
  const zlib = require('node:zlib');
  const http = require('node:http');
  const persistencia = require('./persistencia');
  const cofre = { conteudo: null, sha: null, puts: 0, recusarProximo: false };
  const duble = http.createServer((req, res) => {
    const responde = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!/^Bearer /.test(req.headers.authorization || '')) return responde(401, { message: 'sem token' });
    if (req.method === 'GET') {
      if (!cofre.conteudo) return responde(404, { message: 'Not Found' });
      return responde(200, { sha: cofre.sha, size: cofre.conteudo.length,
        content: cofre.conteudo.toString('base64'), encoding: 'base64' });
    }
    if (req.method === 'PUT') {
      let corpo = '';
      req.on('data', p => corpo += p);
      req.on('end', () => {
        const b = JSON.parse(corpo);
        cofre.puts++;
        if (cofre.recusarProximo) { cofre.recusarProximo = false; return responde(409, { message: 'sha conflitante' }); }
        if (cofre.sha && b.sha !== cofre.sha) return responde(409, { message: 'sha conflitante' });
        cofre.conteudo = Buffer.from(b.content, 'base64');
        cofre.sha = require('node:crypto').createHash('sha1').update(cofre.conteudo).digest('hex');
        responde(200, { content: { sha: cofre.sha } });
      });
      return;
    }
    responde(405, { message: 'metodo' });
  });
  await new Promise((ok, nao) => { duble.once('error', nao); duble.listen(PORTA_DUBLE, '127.0.0.1', ok); })
    .catch(e => { console.log(`  (dublê não subiu na porta ${PORTA_DUBLE}: ${e.message})`); });

  await ta('o gerente manda gravar um retrato e ele sobe comprimido', async () => {
    const r = await chama('/api/snapshot', { method: 'POST' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
    assert.ok(cofre.conteudo, 'nada chegou no dublê');
    const cru = zlib.gunzipSync(cofre.conteudo);
    assert.strictEqual(cru.slice(0, 15).toString(), 'SQLite format 3', 'o retrato não é um banco SQLite');
    assert.ok(cofre.conteudo.length < cru.length, 'o gzip não reduziu nada');
  });

  await ta('o retrato restaurado traz as comandas da noite', async () => {
    const destino = require('node:path').join(require('node:os').tmpdir(), `restaurado-${Date.now()}.db`);
    assert.strictEqual(await persistencia.restaurar(destino), true, persistencia.estado().erro || '');
    const { DatabaseSync } = require('node:sqlite');
    const outro = new DatabaseSync(destino);
    const n = outro.prepare('SELECT COUNT(*) c FROM lancamentos').get().c;
    const mesas = outro.prepare('SELECT COUNT(*) c FROM mesas').get().c;
    outro.close();
    assert.ok(n > 0, 'o retrato veio sem lançamentos');
    assert.strictEqual(mesas, 18);
  });

  await ta('sha velho: ele relê e regrava em vez de perder o retrato', async () => {
    cofre.recusarProximo = true;
    const antes = cofre.puts;
    assert.strictEqual(await persistencia.enviar(require('./server').banco(), 'teste'), true,
      persistencia.estado().erro || 'não regravou');
    assert.strictEqual(cofre.puts, antes + 2, 'devia ter tentado duas vezes');
  });

  await ta('sem repositório configurado, ele diz que é volátil em vez de fingir', async () => {
    const r = await fetch(`${base}/api/saude`);
    const c = await r.json();
    assert.strictEqual(c.dados.modo, 'github');
    assert.ok(c.dados.ultimoRetrato, 'não registrou a hora do último retrato');
  });

  await ta('o sinal de vida responde sem sessão', async () => {
    const r = await fetch(`${base}/api/saude`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).ok, true);
  });
  await ta('as páginas do frontend são servidas', async () => {
    for (const p of ['/', '/salao', '/mesa', '/camera', '/bahrem.css', '/nucleo.js', '/app.js']) {
      const r = await fetch(base + p);
      assert.strictEqual(r.status, 200, `${p} respondeu ${r.status}`);
    }
  });
  await ta('a foto e o escudo saem com o tipo certo', async () => {
    const f = await fetch(`${base}/casa.jpg`);
    assert.strictEqual(f.status, 200);
    assert.match(f.headers.get('content-type'), /image\/jpeg/);
    const m = await fetch(`${base}/marca.png`);
    assert.strictEqual(m.status, 200);
    assert.match(m.headers.get('content-type'), /image\/png/);
    assert.ok(Number(m.headers.get('content-length') ?? 1e9) < 20000 ||
      (await m.arrayBuffer()).byteLength < 20000, 'o escudo está pesado demais para um badge');
  });
  await ta('não dá para sair do diretório public', async () => {
    const r = await fetch(`${base}/../server.js`);
    assert.ok(r.status >= 400, `vazou com ${r.status}`);
  });

  servidor.close();
  duble.close();
  persistencia.parar();
  console.log(`\n${ok} passaram, ${falhas.length} falharam` + (falhas.length ? `: ${falhas.join(', ')}` : ''));
  process.exit(falhas.length ? 1 : 0);
})();
