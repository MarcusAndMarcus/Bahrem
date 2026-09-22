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
const srv = require('./server.js');
const erros = [], passos = [];
const passo = async (nome, fn) => { try { await fn(); passos.push(['ok', nome]); } catch (e) { passos.push(['FALHA', `${nome} — ${e.message}`]); } };
const espera = ms => new Promise(r => setTimeout(r, ms));

/* só carrega recurso do próprio servidor: Google Fonts não é alcançável daqui */
class SoLocal extends ResourceLoader {
  fetch(url, op) { return url.startsWith('http://127.0.0.1') ? super.fetch(url, op) : Promise.resolve(Buffer.from('')); }
}

async function abrir(base, rota, token) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => erros.push(`${rota}: ${e.detail?.message || e.message}`));
  const dom = await JSDOM.fromURL(base + rota, { runScripts: 'dangerously', resources: new SoLocal(),
    pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      if (token) w.localStorage.setItem('burguer.token', token);
      w.fetch = (u, o) => fetch(new URL(u, base), o);           // jsdom não traz fetch
      w.EventSource = class { constructor() {} addEventListener() {} close() {} };
      w.onerror = m => erros.push(`${rota}: ${m}`);
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
  await passo('sistema real: quatro painéis, e o fiscal diz que está sem valor fiscal', () => {
    const ds = sis.window.document;
    const paineis = ds.querySelectorAll('.painel');
    if (paineis.length !== 4) throw new Error(`${paineis.length} painéis`);
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

  for (const [st, n] of passos) console.log(`  ${st.padEnd(5)} ${n}`);
  const reais = erros.filter(e => !/Could not load link|stylesheet|fonts\.g/i.test(e));
  console.log(reais.length ? '\nERROS DE EXECUÇÃO:\n  ' + reais.join('\n  ') : '\nnenhum erro de execução nas páginas reais');
  srv.servidor.close(); process.exit(0);
})().catch(e => { console.log('quebrou:', e); process.exit(1); });
