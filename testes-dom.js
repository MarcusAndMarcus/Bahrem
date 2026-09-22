/* Teste de EXECUÇÃO das páginas: sobe o servidor de verdade e abre salão,
   cliente e cardápio num DOM simulado (jsdom), procurando erro de execução —
   o tipo de erro que a checagem de sintaxe não pega.

   Precisa do jsdom, que é a única dependência de desenvolvimento do projeto:
     npm install     (instala só ele; o Render não roda isto)
     npm run testes:dom
   O sistema em si continua sem dependência nenhuma. */
process.env.DB_PATH = `/tmp/reais-${Date.now()}.db`;
process.env.ANTHROPIC_API_KEY = 'so-para-a-caixinha-aparecer';
process.env.SESSAO_SEGREDO = 'teste';
const { JSDOM, VirtualConsole, ResourceLoader } = require('jsdom');
/* gerador de cenas para medir o núcleo: tudo em fração do quadro, supersample 2×2 */
function cena({ L = 480, A = 360, cx = .5, cy = .5, R = .36, tilt = 1, rot = 0, fundo = [26, 24, 22],
  prato = [238, 236, 231], forma = 'circulo', cast = [1, 1, 1], comida = true, desvioComida = 0,
  guarn = 5, extras = [] } = {}) {
  const d = new Uint8ClampedArray(L * A * 4);
  const m = Math.min(L, A), X = cx * L, Y = cy * A, r = R * m;
  const co = Math.cos(rot), si = Math.sin(rot);
  const loc = (x, y) => { const dx = x - X, dy = y - Y; return [(dx * co + dy * si), (-dx * si + dy * co) / tilt]; };
  const dentroPrato = (x, y) => { const [u, v] = loc(x, y);
    return forma === 'quadrado' ? Math.max(Math.abs(u), Math.abs(v)) <= r : Math.hypot(u, v) <= r; };
  const cor = (x, y) => {
    for (const e of extras) { const c = e(x, y, L, A); if (c) return c; }
    if (!dentroPrato(x, y)) return fundo;
    if (comida) {
      const [u, v] = loc(x, y);
      if (Math.hypot(u - desvioComida * r, v) < r * 0.42) return [150, 82, 46];
      for (let k = 0; k < guarn; k++) {
        const a = k * 2.4, gx = Math.cos(a) * r * .62, gy = Math.sin(a) * r * .62;
        if (Math.hypot(u - gx, v - gy) < r * 0.09) return [60, 120, 52];
      }
    }
    return prato;
  };
  for (let y = 0; y < A; y++) for (let x = 0; x < L; x++) {
    let R0 = 0, G0 = 0, B0 = 0;
    for (const [ox, oy] of [[.25, .25], [.75, .25], [.25, .75], [.75, .75]]) {
      const c = cor(x + ox, y + oy); R0 += c[0]; G0 += c[1]; B0 += c[2];
    }
    const i = (y * L + x) * 4;
    d[i] = R0 / 4 * cast[0]; d[i + 1] = G0 / 4 * cast[1]; d[i + 2] = B0 / 4 * cast[2]; d[i + 3] = 255;
  }
  return { width: L, height: A, data: d };
}


const srv = require('./server.js');
const erros = [], passos = [];
const passo = async (nome, fn) => { try { await fn(); passos.push(['ok', nome]); } catch (e) { passos.push(['FALHA', `${nome} — ${e.message}`]); } };
const espera = ms => new Promise(r => setTimeout(r, ms));

/* só carrega recurso do próprio servidor: Google Fonts não é alcançável daqui */
class SoLocal extends ResourceLoader {
  fetch(url, op) { return url.startsWith('http://127.0.0.1') ? super.fetch(url, op) : Promise.resolve(Buffer.from('')); }
}

async function abrir(base, rota, token, preparar = null) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => erros.push(`${rota}: ${e.detail?.message || e.message}`));
  const dom = await JSDOM.fromURL(base + rota, { runScripts: 'dangerously', resources: new SoLocal(),
    pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      if (token) w.localStorage.setItem('burguer.token', token);
      w.fetch = (u, o) => fetch(new URL(u, base), o);           // jsdom não traz fetch
      w.EventSource = class { constructor() {} addEventListener() {} close() {} };
      w.onerror = m => erros.push(`${rota}: ${m}`);
      if (preparar) preparar(w);
    } });
  await espera(900);
  return dom;
}

(async () => {
  await srv.preparar();
  await new Promise(r => srv.servidor.listen(0, r));
  const base = `http://127.0.0.1:${srv.servidor.address().port}`;
  const entra = await (await fetch(base + '/api/entrar', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '2468' }) })).json();
  const abre = await (await fetch(base + '/api/mesas/7/abrir', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${entra.token}` },
    body: JSON.stringify({ pessoas: 3 }) })).json();

  const s = await abrir(base, '/salao', entra.token);
  const ds = s.window.document;
  await passo('salão real: caixinha centralizada entre os filtros e a grade', () => {
    const sec = ds.querySelector('#caixinhaSalao .sommelier');
    if (!sec) throw new Error('não montou');
    const filhos = [...ds.body.children].map(e => e.id || e.tagName.toLowerCase() + '.' + e.className);
    const iF = filhos.findIndex(x => x.includes('pilhas')), iC = filhos.indexOf('caixinhaSalao'), iM = filhos.indexOf('salao');
    if (!(iF < iC && iC < iM)) throw new Error(filhos.join(' > '));
  });
  await passo('salão real: 18 mesas e a mesa 7 ocupada', () => {
    const mesas = ds.querySelectorAll('#salao .mesa');
    if (mesas.length !== 18) throw new Error(`${mesas.length}`);
    const sete = [...mesas].find(m => m.dataset.n === '7');
    if (sete.classList.contains('livre')) throw new Error('mesa 7 aparece livre');
  });
  await passo('salão real: sugestões vêm do estado do salão', () => {
    const chips = [...ds.querySelectorAll('#caixinhaSalao .sommelier-chip')].map(b => b.textContent);
    if (!chips.length) throw new Error('sem sugestões');
  });
  await passo('salão real: "/" leva o foco para a pergunta', () => {
    ds.body.dispatchEvent(new s.window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
    if (ds.activeElement !== ds.querySelector('#caixinhaSalao input')) throw new Error('foco não foi');
  });

  await passo('salão real: o fechamento oferece a nota e explica o modo fiscal', async () => {
    const cab = { 'content-type': 'application/json', authorization: `Bearer ${entra.token}` };
    const card = await (await fetch(base + '/api/cardapio')).json();
    const burg = card.find(i => /Burguer da casa/.test(i.nome));
    await fetch(`${base}/api/comandas/${abre.comanda_id}/itens`, { method: 'POST', headers: cab,
      body: JSON.stringify({ item_id: burg.id, qtd: 2 }) });
    const s2 = await abrir(base, '/salao', entra.token);
    const d2 = s2.window.document;
    const sete = [...d2.querySelectorAll('#salao .mesa')].find(x => x.dataset.n === '7');
    sete.dispatchEvent(new s2.window.MouseEvent('click', { bubbles: true }));
    await espera(400);
    d2.querySelector('#fechar').dispatchEvent(new s2.window.MouseEvent('click', { bubbles: true }));
    await espera(100);
    const bloco = d2.querySelector('.bloco-nota');
    if (!bloco) throw new Error('sem o bloco da nota no fechamento');
    if (!/sem valor fiscal/i.test(bloco.textContent)) throw new Error('não explicou o modo: ' + bloco.textContent.trim());
  });

  const m = await abrir(base, `/mesa?c=${abre.codigo}`, null);
  const dm = m.window.document;
  await passo('cliente real: conta, depois o sommelier, depois as abas', () => {
    const talao = dm.querySelector('#cabeca .mesaNum');
    if (!talao || talao.textContent !== '7') throw new Error('a conta não carregou');
    const cx = dm.querySelector('#caixinhaMesa .sommelier h3');
    if (!cx || !/pedido perfeito/.test(cx.textContent)) throw new Error('sommelier não montou');
    const ordem = [...dm.querySelector('main').children].map(e => e.id || e.className);
    if (ordem.join(',') !== 'conta,caixinhaMesa,conta') throw new Error(ordem.join(','));
  });
  await passo('cliente real: marcar quem dividiu funciona sem login e não manda para o PIN', async () => {
    dm.querySelector('#abas [data-aba="dividir"]').dispatchEvent(new m.window.MouseEvent('click', { bubbles: true }));
    await espera(100);
    const botao = dm.querySelector('#painel [data-lanc][data-p="2"]');
    if (!botao) throw new Error('sem botões de pessoa na aba Dividir');
    botao.dispatchEvent(new m.window.MouseEvent('click', { bubbles: true }));
    await espera(700);
    if (m.window.location.pathname !== '/mesa') throw new Error('mandou o cliente para ' + m.window.location.pathname);
    const depois = dm.querySelector('#painel [data-lanc][data-p="2"]');
    if (!depois || !depois.classList.contains('marcado')) throw new Error('a marcação não ficou gravada');
  });
  await passo('cliente real: o cardápio mostra a moldura de foto', async () => {
    dm.querySelector('#abas [data-aba="cardapio"]').dispatchEvent(new m.window.MouseEvent('click', { bubbles: true }));
    await espera(100);
    if (!dm.querySelector('#painel .prato .foto')) throw new Error('sem moldura');
  });

  await passo('cupom real: comprovante sem valor fiscal, com itens e total', async () => {
    const cab = { 'content-type': 'application/json', authorization: `Bearer ${entra.token}` };
    const conta = await (await fetch(`${base}/api/comandas/${abre.comanda_id}`, { headers: cab })).json();
    const f = await (await fetch(`${base}/api/comandas/${abre.comanda_id}/fechar`, { method: 'POST', headers: cab,
      body: JSON.stringify({ emitirNota: true, pagamentos: [{ forma: 'pix', valor_cent: conta.total_cent }] }) })).json();
    if (!f.nota || f.nota.status !== 'nao-fiscal') throw new Error('nota: ' + JSON.stringify(f.nota || f));
    const cp = await abrir(base, `/cupom?c=${abre.codigo}`, null);
    const dc = cp.window.document;
    const faixa = dc.querySelector('.faixa.alerta');
    if (!faixa || !/SEM VALOR FISCAL/.test(faixa.textContent)) throw new Error('sem a faixa de sem valor fiscal');
    if (!dc.querySelector('.folha table tr')) throw new Error('sem itens');
    if (!/TOTAL/.test(dc.querySelector('.total').textContent)) throw new Error('sem total');
  });

  const sis = await abrir(base, '/sistema', entra.token);
  await passo('sistema real: cinco painéis, e o fiscal diz que está sem valor fiscal', () => {
    const ds = sis.window.document;
    const paineis = ds.querySelectorAll('.painel');
    if (paineis.length !== 5) throw new Error(`${paineis.length} painéis`);
    if (!/sem valor fiscal/.test(paineis[1].textContent)) throw new Error('modo fiscal não informado');
    if (!ds.querySelector('[data-testar="ia"]')) throw new Error('sem o botão de testar a IA');
  });

  const c = await abrir(base, '/cardapio', entra.token);
  await passo('cardápio real: o gerente vê o cadastro fiscal de cada item', () => {
    const dcard = c.window.document;
    if (!dcard.querySelector('.form-fiscal input[name="ncm"]')) throw new Error('sem o formulário fiscal');
    if (!/de exemplo/.test(dcard.querySelector('.vitrine-item .selo-estado').textContent)) throw new Error('sem o selo fiscal');
  });
  await passo('cardápio real: vitrine do gerente com botão de fotografar', () => {
    const itens = c.window.document.querySelectorAll('.vitrine-item');
    if (itens.length < 10) throw new Error(`${itens.length} itens`);
    if (!c.window.document.querySelector('.vitrine-item input[type=file]')) throw new Error('sem botão de foto');
  });

  /* ── câmera: a automação inteira, sem nenhum toque ──
     O navegador simulado não tem câmera: o "vídeo" é uma cena sintética, e
     cada quadro que a página pede ao canvas sai do gerador. A página faz o
     resto sozinha: acha o prato, espera firmar, fotografa três quadros,
     reconhece, conta 3 s e lança na mesa. */
  await passo('câmera real: acha, fotografa, reconhece e lança sozinha — e não lança o mesmo prato duas vezes', async () => {
    const cab = { 'content-type': 'application/json', authorization: `Bearer ${entra.token}` };
    const card = await (await fetch(base + '/api/cardapio')).json();
    const burg = card.find(i => /Burguer da casa/.test(i.nome));
    globalThis.window = globalThis; require('./nucleo.js');
    const amostras = [[.5, .5, .36], [.47, .52, .35], [.53, .48, .37], [.5, .53, .355], [.49, .47, .365]]
      .map(([cx, cy, R]) => Nucleo.medir(cena({ L: 480, A: 270, cx, cy, R })).m);
    const pad = await (await fetch(base + '/api/padroes', { method: 'POST', headers: cab,
      body: JSON.stringify({ item_id: burg.id, amostras, versao: Nucleo.VERSAO }) })).json();
    if (pad.versao !== Nucleo.VERSAO)
      throw new Error(`padrão gravou como v${pad.versao}, núcleo mede v${Nucleo.VERSAO}: ` + JSON.stringify(pad));
    const mesa = await (await fetch(base + '/api/mesas/8/abrir', { method: 'POST', headers: cab, body: JSON.stringify({ pessoas: 2 }) })).json();

    const cacheCena = new Map();
    const quadro = (w, h) => { const k = `${w}x${h}`; if (!cacheCena.has(k)) cacheCena.set(k, cena({ L: w, A: h })); return cacheCena.get(k); };
    const cam = await abrir(base, '/camera?mesa=8', entra.token, w => {
      const ctx = el => ({ drawImage() {}, setTransform() {}, clearRect() {}, save() {}, restore() {}, translate() {},
        rotate() {}, beginPath() {}, ellipse() {}, rect() {}, stroke() {}, setLineDash() {},
        getImageData: (x, y, ww, hh) => quadro(ww, hh) });
      w.HTMLCanvasElement.prototype.getContext = function () { return ctx(this); };
      w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,/9j/AAAA';
      Object.defineProperty(w.HTMLVideoElement.prototype, 'videoWidth', { get: () => 1280 });
      Object.defineProperty(w.HTMLVideoElement.prototype, 'videoHeight', { get: () => 720 });
      const trilha = { stop() {}, getCapabilities: () => ({}), applyConstraints: async () => {} };
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { getUserMedia: async () =>
        ({ getTracks: () => [trilha], getVideoTracks: () => [trilha] }) } });
    });
    const d = cam.window.document;
    const lancados = async () => (await (await fetch(`${base}/api/comandas/${mesa.comanda_id}`, { headers: cab })).json())
      .itens.filter(i => i.origem === 'camera');
    let ok = false;
    for (let t = 0; t < 40 && !ok; t++) { await espera(250); ok = (await lancados()).length > 0; }
    if (!ok) throw new Error('não lançou sozinha em 10 s — estado: ' + d.querySelector('#estado').textContent.trim()
      + ' · saída: ' + d.querySelector('#saida').textContent.trim().slice(0, 160));
    const l = await lancados();
    if (l[0].item_id !== burg.id) throw new Error('lançou o prato errado: ' + l[0].nome);
    await espera(3000);                               // o mesmo prato continua no quadro
    const depois = await lancados();
    if (depois.length !== 1) throw new Error(`lançou ${depois.length} vezes o mesmo prato`);
    if (!/lançado/.test(d.querySelector('#saida').textContent)) throw new Error('a tela não mostrou o lançamento');
    cam.window.close();
  });

  for (const [st, n] of passos) console.log(`  ${st.padEnd(5)} ${n}`);
  const reais = erros.filter(e => !/Could not load link|stylesheet|fonts\.g/i.test(e));
  console.log(reais.length ? '\nERROS DE EXECUÇÃO:\n  ' + reais.join('\n  ') : '\nnenhum erro de execução nas páginas reais');
  srv.servidor.close(); process.exit(0);
})().catch(e => { console.log('quebrou:', e); process.exit(1); });
