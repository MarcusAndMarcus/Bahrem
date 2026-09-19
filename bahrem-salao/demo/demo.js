/* Protótipo autônomo. Toda a matemática — medição, envelope, Mahalanobis,
   rateio, CRC — é a mesma do servidor; o que é falso aqui é só o movimento do
   salão e os pratos desenhados no canvas. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const real = c => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const decorrido = ms => { const m = Math.floor(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`; };

  /* gerador determinístico: o salão abre sempre igual */
  let semente = 20260919;
  const rnd = () => (semente = (semente * 1664525 + 1013904223) >>> 0) / 4294967296;

  const CARDAPIO = [
    { id: 1, nome: 'Croqueta de costela (8 un.)', preco: 6400, afer: 1 },
    { id: 2, nome: 'Chapa de camarão', preco: 12900, afer: 1 },
    { id: 3, nome: 'Kiev de frango com palmito', preco: 7900, afer: 1 },
    { id: 4, nome: 'Costelinha de porco', preco: 8900, afer: 1 },
    { id: 5, nome: 'Picanha na chapa (2 pessoas)', preco: 18900, afer: 1 },
    { id: 6, nome: 'Executivo do dia', preco: 5900, afer: 1 },
    { id: 7, nome: 'Chopp Pilsen 300ml', preco: 1500, afer: 0 },
    { id: 8, nome: 'Chopp Pilsen 500ml', preco: 2200, afer: 0 },
    { id: 9, nome: 'Long neck', preco: 1400, afer: 0 },
    { id: 10, nome: 'Caipirinha de limão', preco: 2900, afer: 0 },
    { id: 11, nome: 'Taça de vinho tinto', preco: 3200, afer: 0 },
    { id: 12, nome: 'Refrigerante lata', preco: 900, afer: 0 }
  ];
  const AREAS = { salao: 'Salão', deck: 'Deck', mezanino: 'Mezanino' };
  const PLANTA = [[1, 4, 'salao'], [2, 4, 'salao'], [3, 6, 'salao'], [4, 2, 'salao'], [5, 4, 'salao'],
    [6, 8, 'salao'], [7, 4, 'salao'], [8, 4, 'salao'], [11, 4, 'deck'], [12, 4, 'deck'], [13, 6, 'deck'],
    [14, 2, 'deck'], [15, 4, 'deck'], [16, 10, 'deck'], [21, 4, 'mezanino'], [22, 6, 'mezanino'],
    [23, 4, 'mezanino'], [24, 4, 'mezanino']];

  const SERVICO = 10, TICKET_CHEIO = 40000;
  let mesas = [], mesaAberta = null, telegramas = [], padroes = [], ultimaMedida = null;

  /* ---------- salão inicial ---------- */
  function abrirSalao() {
    mesas = PLANTA.map(([numero, lugares, area]) => ({ numero, lugares, area, itens: [], chamada: null }));
    for (const m of mesas) {
      if (rnd() > 0.62) continue;
      m.pessoas = 1 + Math.floor(rnd() * m.lugares);
      m.abertaEm = Date.now() - Math.floor(rnd() * 140 + 8) * 60000;
      m.codigo = Array.from({ length: 8 }, () => '0123456789ABCDEF'[Math.floor(rnd() * 16)]).join('');
      const quantos = 1 + Math.floor(rnd() * 6);
      for (let i = 0; i < quantos; i++) {
        const it = CARDAPIO[Math.floor(rnd() * CARDAPIO.length)];
        m.itens.push({ id: Date.now() + i + m.numero * 100, nome: it.nome, qtd: 1 + Math.floor(rnd() * 3),
          preco: it.preco, origem: 'garcom', em: m.abertaEm + i * 600000 });
      }
    }
    const comChamada = mesas.filter(m => m.pessoas);
    if (comChamada.length) comChamada[Math.floor(rnd() * comChamada.length)].chamada = 'pediu-conta';
  }

  const totais = m => {
    const sub = m.itens.reduce((s, i) => s + i.qtd * i.preco, 0);
    const serv = Math.round(sub * SERVICO / 100), tot = sub + serv;
    const n = Math.max(1, m.pessoas || 1), base = Math.floor(tot / n), resto = tot - base * n;
    return { sub, serv, tot, porPessoa: Array.from({ length: n }, (_, i) => base + (i < resto ? 1 : 0)) };
  };

  function bus(orig, verbo, mesa, carga) {
    telegramas = [URB1.telegrama(orig, verbo, mesa, carga), ...telegramas].slice(0, 3);
    $('#urb1').textContent = telegramas.join('   ·   ');
  }

  /* ---------- desenho do salão ---------- */
  function desenhar() {
    const abertas = mesas.filter(m => m.pessoas);
    const emAberto = abertas.reduce((s, m) => s + totais(m).tot, 0);
    $('#resumo').innerHTML =
      `<span><b>${abertas.length}</b> de ${mesas.length} mesas</span>` +
      `<span><b>${abertas.reduce((s, m) => s + m.pessoas, 0)}</b> pessoas</span>` +
      `<span class="grana">${real(emAberto)} em aberto</span>` +
      (abertas.some(m => m.chamada) ? `<span style="color:var(--brasa)"><b>${abertas.filter(m => m.chamada).length}</b> chamando</span>` : '');

    $('#salao').innerHTML = Object.keys(AREAS).map(a => `
      <section class="area"><h2>${AREAS[a]}</h2>
        <div class="grade">${mesas.filter(m => m.area === a).map(cartao).join('')}</div></section>`).join('');
    $$('#salao .mesa').forEach(b => b.onclick = () => abrirGaveta(Number(b.dataset.n)));
  }

  function cartao(m) {
    if (!m.pessoas) return `<button class="mesa livre" data-n="${m.numero}"><div class="copo"></div>
      <div class="num">${m.numero}</div><div class="sit">${m.lugares} lugares</div>
      <div class="val">livre</div></button>`;
    const t = totais(m), nivel = Math.max(3, Math.min(100, Math.round(t.tot / TICKET_CHEIO * 100)));
    return `<button class="mesa${m.chamada ? ' chamando' : ''}" data-n="${m.numero}">
      <div class="copo"><i style="height:${nivel}%"><u></u></i></div>
      ${m.chamada ? '<span class="sino"></span>' : ''}
      <div class="num">${m.numero}</div>
      <div class="sit">${m.pessoas} pess. · ${decorrido(Date.now() - m.abertaEm)} · ${m.itens.length} itens</div>
      <div class="val">${real(t.tot)}</div></button>`;
  }

  /* ---------- gaveta ---------- */
  function abrirGaveta(numero) {
    const m = mesas.find(x => x.numero === numero);
    mesaAberta = numero;
    $('#gTitulo').textContent = `Mesa ${numero}`;
    $('#gaveta').classList.add('aberta');
    $('#gaveta').setAttribute('aria-hidden', 'false');
    m.pessoas ? telaComanda(m) : telaAbrir(m);
  }
  const fecharGaveta = () => { mesaAberta = null; $('#gaveta').classList.remove('aberta'); $('#gaveta').setAttribute('aria-hidden', 'true'); };
  $('#gFechar').onclick = fecharGaveta;
  addEventListener('keydown', e => e.key === 'Escape' && fecharGaveta());

  function telaAbrir(m) {
    $('#gCorpo').innerHTML = `<p class="vazio">Mesa livre, ${m.lugares} lugares. Quantas pessoas sentaram?</p>
      <div class="campo"><label for="qp">Pessoas</label>
      <input id="qp" type="number" inputmode="numeric" min="1" max="30" value="${m.lugares}"></div>`;
    $('#gPe').innerHTML = `<button class="btn forte" id="abrir">Abrir comanda</button>`;
    $('#abrir').onclick = () => {
      m.pessoas = Math.max(1, Number($('#qp').value) || 1);
      m.abertaEm = Date.now();
      m.codigo = Array.from({ length: 8 }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');
      bus('SAL', 'ABRE', m.numero, [m.pessoas]);
      desenhar(); abrirGaveta(m.numero);
    };
  }

  function telaComanda(m) {
    const t = totais(m), p = t.porPessoa;
    const faixa = p.length > 1 && p[0] !== p[p.length - 1] ? `${real(p[p.length - 1])} a ${real(p[0])}` : real(p[0] || 0);
    $('#gCorpo').innerHTML = `
      <div class="resumo" style="margin-bottom:14px"><span>${m.pessoas} pessoas</span>
        <span>aberta há ${decorrido(Date.now() - m.abertaEm)}</span>
        ${m.chamada ? '<span style="color:var(--brasa)">pediu a conta</span>' : ''}</div>
      <div class="comanda">
        ${m.itens.length ? m.itens.map(i => `<div class="linha"><span class="q">${i.qtd}×</span>
          <span class="n">${esc(i.nome)}${i.origem !== 'garcom' ? `<small>${esc(i.origem)}</small>` : ''}</span>
          <span class="v">${real(i.qtd * i.preco)}
            <button class="btn miudo perigo" data-estorno="${i.id}">−</button></span></div>`).join('')
          : '<p class="vazio">Nada lançado ainda.</p>'}
        <div class="soma"><span>subtotal</span><span>${real(t.sub)}</span></div>
        <div class="soma"><span>serviço ${SERVICO}% (opcional)</span><span>${real(t.serv)}</span></div>
        <div class="soma total"><span>total</span><b>${real(t.tot)}</b></div>
      </div>
      <div class="rateio">por pessoa (${m.pessoas}): <b>${faixa}</b></div>
      <h2 style="margin:22px 0 8px;font-size:13px;color:var(--papel-2)">Lançar item</h2>
      <div class="campo"><label for="item">Item do cardápio</label>
        <select id="item">${CARDAPIO.map(i => `<option value="${i.id}">${esc(i.nome)} — ${real(i.preco)}</option>`).join('')}</select></div>
      <div class="campo"><label for="qtd">Quantidade</label>
        <input id="qtd" type="number" inputmode="numeric" min="1" max="99" value="1"></div>
      <button class="btn" id="lancar">Lançar na mesa ${m.numero}</button>
      <p class="nota">Conta do cliente: <code>${esc(m.codigo)}</code> —
        <a href="#" id="verCliente">abrir a tela dele</a></p>`;
    $('#gPe').innerHTML = `<button class="btn" id="irCamera">Lançar pela câmera</button>
      <button class="btn forte" id="fechar">Fechar conta — ${real(t.tot)}</button>`;

    $('#lancar').onclick = () => {
      const it = CARDAPIO.find(i => i.id === Number($('#item').value));
      m.itens.push({ id: Date.now(), nome: it.nome, qtd: Number($('#qtd').value) || 1, preco: it.preco, origem: 'garcom', em: Date.now() });
      bus('SAL', 'LANC', m.numero, [Number($('#qtd').value) || 1, Math.round(it.preco / 100)]);
      desenhar(); telaComanda(m);
    };
    $$('#gCorpo [data-estorno]').forEach(b => b.onclick = () => {
      m.itens = m.itens.filter(i => String(i.id) !== b.dataset.estorno);
      bus('SAL', 'ESTO', m.numero, []); desenhar(); telaComanda(m);
    });
    $('#verCliente').onclick = e => { e.preventDefault(); fecharGaveta(); irPara('cliente', m.numero); };
    $('#irCamera').onclick = () => { fecharGaveta(); irPara('camera'); alvoCamera = m.numero; marcarAlvo(); };
    $('#fechar').onclick = () => {
      const t2 = totais(m);
      $('#gCorpo').innerHTML = `<p>Mesa ${m.numero} fechada: <b>${real(t2.tot)}</b>.</p>
        <div class="campo"><label>Pix copia e cola (chave de exemplo)</label>
        <input readonly value="${esc(PIX.brcode({ chave: 'bahrem@exemplo.com.br', valor: t2.tot / 100, nome: 'Bahrem Marista', cidade: 'Goiania', txid: m.codigo }))}" onclick="this.select()"></div>
        <p class="nota">No sistema real o código só aparece se a chave Pix estiver configurada,
          e a baixa continua manual: confira no app do banco antes de liberar a mesa.</p>`;
      $('#gPe').innerHTML = `<button class="btn forte" id="ok">Voltar ao salão</button>`;
      bus('SAL', 'FECH', m.numero, [Math.round(t2.tot / 100)]);
      $('#ok').onclick = () => { m.pessoas = 0; m.itens = []; m.chamada = null; delete m.abertaEm; fecharGaveta(); desenhar(); };
    };
  }

  /* ---------- tela do cliente ---------- */
  function telaCliente(numero) {
    const m = mesas.find(x => x.numero === numero) || mesas.find(x => x.pessoas);
    if (!m) { $('#cliente').innerHTML = '<p class="vazio" style="padding:40px;text-align:center">Nenhuma mesa aberta no protótipo.</p>'; return; }
    const t = totais(m), p = t.porPessoa;
    const faixa = p.length > 1 && p[0] !== p[p.length - 1] ? `${real(p[p.length - 1])} a ${real(p[0])}` : real(p[0] || 0);
    $('#cliente').innerHTML = `<div class="conta"><div class="talao">
      <h1>Bahrem Marista</h1>
      <div class="mesaNum">${m.numero}</div>
      <div class="sub">${AREAS[m.area]} · ${m.pessoas} ${m.pessoas > 1 ? 'pessoas' : 'pessoa'} · aberta há ${decorrido(Date.now() - m.abertaEm)}</div>
      <div class="comanda">
        ${m.itens.map(i => `<div class="linha"><span class="q">${i.qtd}×</span>
          <span class="n">${esc(i.nome)}</span><span class="v">${real(i.qtd * i.preco)}</span></div>`).join('')}
        <div class="soma"><span>subtotal</span><span>${real(t.sub)}</span></div>
        <div class="soma"><span>serviço ${SERVICO}% (opcional)</span><span>${real(t.serv)}</span></div>
        <div class="soma total"><span>total</span><b>${real(t.tot)}</b></div>
      </div>
      <div class="rateio">dividindo por ${m.pessoas}: <b>${faixa}</b> cada</div>
      <div class="acoes">
        <button class="btn" data-chama="garcom">Chamar o garçom</button>
        <button class="btn forte" data-chama="conta">Pedir a conta</button></div>
      <p class="nota">Os ${SERVICO}% de serviço são opcionais (Lei Municipal 9.418/14).
        No sistema real esta tela é o QR colado na mesa e atualiza sozinha a cada lançamento.</p>
    </div></div>`;
    $$('#cliente [data-chama]').forEach(b => b.onclick = () => {
      m.chamada = b.dataset.chama === 'conta' ? 'pediu-conta' : 'chamou-garcom';
      b.textContent = b.dataset.chama === 'conta' ? 'conta pedida' : 'garçom avisado';
      b.disabled = true;
      bus('CLI', b.dataset.chama === 'conta' ? 'CONT' : 'GARC', m.numero, []);
      desenhar();
    });
  }

  /* ---------- pratos sintéticos ---------- */
  const TIPOS = ['Picanha na chapa (2 pessoas)', 'Executivo do dia', 'Croqueta de costela (8 un.)'];
  function desenhaPrato(cv, tipo, jitter = 0) {
    const L = 480, A = 360;
    cv.width = L; cv.height = A;
    const g = cv.getContext('2d', { willReadFrequently: true });
    let s = 1000 + tipo * 97 + jitter * 13;
    const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    g.fillStyle = '#1a1816'; g.fillRect(0, 0, L, A);                     // mesa escura
    const cx = L / 2 + (r() - .5) * 14, cy = A / 2 + (r() - .5) * 10, R = 132 + (r() - .5) * 8;
    g.fillStyle = '#eeece7'; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();  // louça
    const bolha = (x, y, rr, cor) => { g.fillStyle = cor; g.beginPath(); g.arc(x, y, rr, 0, 7); g.fill(); };
    if (tipo === 0) {                                                     // picanha: massa grande deslocada
      g.fillStyle = '#8f4f2c';
      g.beginPath(); g.ellipse(cx + 10 + (r() - .5) * 8, cy, R * .52, R * .36, .3, 0, 7); g.fill();
      for (let k = 0; k < 4; k++) bolha(cx + Math.cos(k * 1.9) * R * .66, cy + Math.sin(k * 1.9) * R * .6, 13, '#3c7a34');
    } else if (tipo === 1) {                                              // executivo: campo claro e uniforme
      bolha(cx, cy, R * .68, '#d8b969');
      bolha(cx - R * .2, cy + R * .1, R * .18, '#c9a34e');
    } else {                                                              // croqueta: 8 unidades soltas
      for (let k = 0; k < 8; k++) {
        const a = k * 0.79 + r() * .1, rad = R * (.28 + (k % 3) * .17);
        bolha(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, 17, '#b5762f');
      }
      bolha(cx, cy, 15, '#3c7a34');
    }
    return cv;
  }

  function aprenderPadroes() {
    const cv = document.createElement('canvas');
    padroes = TIPOS.map((nome, tipo) => {
      const amostras = [];
      for (let j = 0; j < 6; j++) {
        const r = Nucleo.medir(desenhaPrato(cv, tipo, j));
        if (!r.falha) amostras.push(r.m);
      }
      if (amostras.length < 3) return null;
      const it = CARDAPIO.find(i => i.nome === nome);
      return { item_id: it.id, nome, preco_cent: it.preco, ...Afericao.envelope(amostras), n: amostras.length };
    }).filter(Boolean);
  }

  /* ---------- câmera ---------- */
  let alvoCamera = null, fonteAtual = null;
  const marcarAlvo = () => {
    const el = $('#camera').querySelector('.nota');
    if (el) el.dataset.alvo = alvoCamera || '';
  };

  $$('#camera [data-prato]').forEach(b => b.onclick = () => {
    $('#foto').hidden = true; $('#sintetico').hidden = false;
    fonteAtual = desenhaPrato($('#sintetico'), Number(b.dataset.prato), Math.floor(Math.random() * 900));
    $('#saida').innerHTML = '';
  });

  $('#arquivo').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const img = $('#foto');
    img.onload = () => { $('#sintetico').hidden = true; img.hidden = false; fonteAtual = img; $('#saida').innerHTML = ''; };
    img.src = URL.createObjectURL(f);
  };

  $('#aferir').onclick = () => {
    if (!fonteAtual) return;
    const t0 = performance.now();
    let r;
    try { r = Nucleo.medir(fonteAtual); } catch (e) { return aviso(`a medição parou: ${esc(e.message)}`); }
    const ms = Math.round(performance.now() - t0);
    if (r.falha) return aviso(r.falha, ms);
    ultimaMedida = r;
    const id = Afericao.identificar(r.m, padroes);
    bus('AFE', 'PRAT', alvoCamera || 0, [Math.round((id.dm || 0) * 100)]);

    const classe = id.camada === 0 ? '' : id.camada === 1 ? 'duvida' : 'ruim';
    const cands = (id.candidatos || []).map(c => `${esc(c.nome)} ${c.dm.toFixed(2)}`).join('  ·  ');
    $('#saida').innerHTML = `
      <div class="medidas">${Nucleo.CHAVES.map(k => `<div class="medida"><span>${k}</span>
        <span class="calibre"><i style="width:${(r.m[k] * 100).toFixed(1)}%"></i></span>
        <span>${r.m[k].toFixed(3)}</span></div>`).join('')}</div>
      <div class="veredito ${classe}">${esc(id.veredito)}
        <span class="dm">medido em ${ms} ms · nitidez ${r.nitidez} · raio ${r.raioPrato}px ·
          desencaixe ${r.desencaixe} · razão ${r.razaoElipse}${cands ? ` · candidatos: ${esc(cands)}` : ''}</span></div>
      ${r.ressalvas.length ? `<p class="nota">${r.ressalvas.map(esc).join(' · ')}</p>` : ''}
      <div id="acao"></div>`;

    const alvo = mesas.find(m => m.numero === alvoCamera && m.pessoas) || mesas.find(m => m.pessoas);
    if (!alvo) return;
    if (id.camada === 0) {
      $('#acao').innerHTML = `<div class="acoes"><button class="btn forte" id="lanc">
        Lançar ${esc(id.nome)} na mesa ${alvo.numero} — ${real(id.preco_cent)}</button></div>`;
      $('#lanc').onclick = () => lancar(alvo, id.item_id, $('#lanc'));
    } else {
      const lista = id.candidatos && id.candidatos.length ? id.candidatos
        : CARDAPIO.filter(i => i.afer).map(i => ({ item_id: i.id, nome: i.nome }));
      $('#acao').innerHTML = `<div class="campo" style="margin-top:14px">
        <label for="manual">Confirme o prato na mão</label>
        <select id="manual">${lista.map(c => `<option value="${c.item_id}">${esc(c.nome)}</option>`).join('')}</select></div>
        <button class="btn" id="lancM">Lançar na mesa ${alvo.numero}</button>`;
      $('#lancM').onclick = () => lancar(alvo, Number($('#manual').value), $('#lancM'));
    }
  };

  function lancar(m, itemId, botao) {
    const it = CARDAPIO.find(i => i.id === itemId);
    m.itens.push({ id: Date.now(), nome: it.nome, qtd: 1, preco: it.preco, origem: 'câmera', em: Date.now() });
    bus('SAL', 'LANC', m.numero, [1, Math.round(it.preco / 100)]);
    botao.textContent = `lançado na mesa ${m.numero}`;
    botao.disabled = true;
    desenhar();
  }

  const aviso = (txt, ms) => $('#saida').innerHTML = `<div class="veredito ruim">${esc(txt)}
    ${ms ? `<span class="dm">a foto foi processada em ${ms} ms — a recusa é da medição</span>` : ''}</div>`;

  /* ---------- navegação ---------- */
  function irPara(aba, numero) {
    $$('.abas a').forEach(a => a.classList.toggle('aqui', a.dataset.aba === aba));
    for (const id of ['salao', 'camera', 'cliente']) $('#' + id).hidden = id !== aba;
    if (aba === 'cliente') telaCliente(numero);
  }
  $$('.abas a').forEach(a => a.onclick = e => { e.preventDefault(); irPara(a.dataset.aba); });

  /* ---------- partida ---------- */
  abrirSalao();
  desenhar();
  aprenderPadroes();
  desenhaPrato($('#sintetico'), 0, 3);
  fonteAtual = $('#sintetico');
  bus('SRV', 'LIGA', 0, [mesas.filter(m => m.pessoas).length]);
  setInterval(desenhar, 60000);
})();
