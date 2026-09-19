'use strict';
/* BAHREM · Salão — servidor único, zero dependência npm.
   node:http + node:sqlite + SSE. Roda em Termux, Render ou localhost. */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { abrir, confirmaPin, agora, codigoMesa, ARQUIVO } = require('./db');
const { semear } = require('./seed');
const urb1 = require('./urb1');
const pix = require('./pix');
const persistencia = require('./persistencia');
const { identificar, envelope } = require('./afericao');

const PORTA = Number(process.env.PORT) || 3000;
const CASA = {
  nome: process.env.CASA_NOME || 'Bahrem Marista',
  cidade: process.env.CASA_CIDADE || 'GOIANIA',
  pixChave: process.env.PIX_CHAVE || '',
  pixNome: process.env.PIX_NOME || 'BAHREM MARISTA',
  servicoPct: Number(process.env.SERVICO_PCT ?? 10)
};

const DIAS_EVENTO = Number(process.env.DIAS_EVENTO || 7);
let db = null;

/* O banco só existe depois de tentar trazer o último retrato de volta — em
   hospedagem sem disco (Render free) é isso que separa "o salão lembra da noite
   passada" de "o salão acorda vazio". Por isso o arranque é assíncrono. */
async function preparar() {
  if (db) return db;
  const veio = await persistencia.restaurar(ARQUIVO);
  db = abrir();
  semear(db);
  db.prepare(`DELETE FROM eventos WHERE criado_em < ?`)
    .run(new Date(Date.now() - DIAS_EVENTO * 86400000).toISOString());
  persistencia.iniciar(db);
  const e = persistencia.estado();
  console.log(veio ? `retrato restaurado (${e.bytes} bytes)`
    : e.modo === 'github' ? 'nenhum retrato no repositório ainda — banco novo'
      : 'sem persistência externa: banco novo a cada arranque');
  return db;
}

/* ─────────────────────────── sessões ─────────────────────────── */
const sessoes = new Map(); // token -> {id, nome, papel, exp}
const VALIDADE = 12 * 3600 * 1000;

function novaSessao(f) {
  const token = crypto.randomBytes(24).toString('hex');
  sessoes.set(token, { id: f.id, nome: f.nome, papel: f.papel, exp: Date.now() + VALIDADE });
  return token;
}
function sessao(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7)
    : (/(?:^|;\s*)sessao=([a-f0-9]+)/.exec(req.headers.cookie || '') || [])[1];
  if (!t) return null;
  const s = sessoes.get(t);
  if (!s) return null;
  if (s.exp < Date.now()) { sessoes.delete(t); return null; }
  return s;
}

/* ─────────────────────────── eventos (SSE) ─────────────────────────── */
const ouvintes = new Set();

function emitir(tipo, mesa, carga = {}, telegrama = null) {
  const quadro = telegrama || urb1.telegrama('SRV', tipo.slice(0, 4), mesa || 0,
    [carga.total_cent ? Math.round(carga.total_cent / 100) : 0]);
  db.prepare('INSERT INTO eventos (tipo, mesa, carga, urb1, criado_em) VALUES (?,?,?,?,?)')
    .run(tipo, mesa ?? null, JSON.stringify(carga), quadro, agora());
  const linha = `event: ${tipo}\ndata: ${JSON.stringify({ tipo, mesa, ...carga, urb1: quadro })}\n\n`;
  for (const res of ouvintes) { try { res.write(linha); } catch { ouvintes.delete(res); } }
  persistencia.marcar(db); // todo estado que muda passa por aqui
}

/* ─────────────────────────── contas ─────────────────────────── */
const dinheiro = c => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

function totais(comandaId) {
  const itens = db.prepare(
    `SELECT id, item_id, nome, qtd, preco_cent, origem, estacao, estado, criado_em
       FROM lancamentos WHERE comanda_id = ? ORDER BY id`).all(comandaId);
  const subtotal = itens.reduce((s, i) => s + i.qtd * i.preco_cent, 0);
  const c = db.prepare('SELECT * FROM comandas WHERE id = ?').get(comandaId);
  const servico = Math.round(subtotal * (c.servico_pct / 100));
  const total = subtotal + servico;
  const pessoas = Math.max(1, c.pessoas);
  /* rateio exato em centavos: ninguém paga fração de centavo e a soma bate */
  const base = Math.floor(total / pessoas);
  const resto = total - base * pessoas;
  const porPessoa = Array.from({ length: pessoas }, (_, i) => base + (i < resto ? 1 : 0));
  return { itens, subtotal_cent: subtotal, servico_cent: servico, servico_pct: c.servico_pct,
    total_cent: total, pessoas, porPessoa_cent: porPessoa, comanda: c };
}

function comandaAberta(mesaId) {
  return db.prepare(
    `SELECT * FROM comandas WHERE mesa_id = ? AND status = 'aberta' ORDER BY id DESC LIMIT 1`)
    .get(mesaId);
}

function salao() {
  const mesas = db.prepare('SELECT * FROM mesas ORDER BY numero').all();
  const saida = mesas.map(m => {
    const c = comandaAberta(m.id);
    if (!c) return { ...m, status: m.status === 'reservada' ? 'reservada' : 'livre' };
    const t = totais(c.id);
    const chamada = db.prepare(
      `SELECT tipo, criado_em FROM eventos WHERE mesa = ? AND tipo IN ('chamou-garcom','pediu-conta')
         AND criado_em > ? ORDER BY id DESC LIMIT 1`).get(m.numero, c.aberta_em);
    return { ...m, status: 'ocupada', comanda_id: c.id, codigo: c.codigo, pessoas: c.pessoas,
      aberta_em: c.aberta_em, itens: t.itens.length, total_cent: t.total_cent,
      subtotal_cent: t.subtotal_cent, chamada: chamada?.tipo || null };
  });
  const abertas = saida.filter(m => m.status === 'ocupada');
  return {
    mesas: saida,
    resumo: {
      mesas: saida.length,
      abertas: abertas.length,
      livres: saida.filter(m => m.status === 'livre').length,
      pessoas: abertas.reduce((s, m) => s + (m.pessoas || 0), 0),
      emAberto_cent: abertas.reduce((s, m) => s + (m.total_cent || 0), 0),
      chamadas: abertas.filter(m => m.chamada).length
    },
    casa: { nome: CASA.nome, servicoPct: CASA.servicoPct, pix: Boolean(CASA.pixChave) }
  };
}

/* ─────────────────────────── HTTP ─────────────────────────── */
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const json = (res, codigo, corpo) => {
  const txt = JSON.stringify(corpo);
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(txt), 'cache-control': 'no-store' });
  res.end(txt);
};

function corpo(req, limite = 6 * 1024 * 1024) {
  return new Promise((ok, falhou) => {
    let d = '', n = 0;
    req.on('data', p => { n += p.length; if (n > limite) { falhou(new Error('corpo grande')); req.destroy(); } d += p; });
    req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { falhou(new Error('json inválido')); } });
    req.on('error', falhou);
  });
}

function estatico(res, arquivo) {
  const base = path.join(__dirname, 'public');
  const alvo = path.join(base, arquivo);
  if (!alvo.startsWith(base)) return json(res, 403, { erro: 'fora do diretório' });
  fs.readFile(alvo, (e, buf) => {
    if (e) return json(res, 404, { erro: 'não encontrado' });
    res.writeHead(200, { 'content-type': TIPOS[path.extname(alvo)] || 'application/octet-stream',
      'cache-control': 'no-cache' });
    res.end(buf);
  });
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rota = url.pathname;
  const m = req.method;

  try {
    /* ---------- páginas ---------- */
    if (m === 'GET' && rota === '/') return estatico(res, 'index.html');
    if (m === 'GET' && rota === '/salao') return estatico(res, 'salao.html');
    if (m === 'GET' && rota === '/camera') return estatico(res, 'camera.html');
    if (m === 'GET' && rota === '/mesa') return estatico(res, 'mesa.html');
    if (m === 'GET' && !rota.startsWith('/api/')) return estatico(res, rota.slice(1));

    /* ---------- sinal de vida (usado pelo healthCheckPath da hospedagem) ---------- */
    if (m === 'GET' && rota === '/api/saude') {
      const p = persistencia.estado();
      return json(res, 200, { ok: true, desde: Math.round(process.uptime()), node: process.version,
        dados: { modo: p.modo, ultimoRetrato: p.ultimo, pendente: p.pendente, erro: p.erro } });
    }

    /* ---------- fluxo do cliente (sem login, só o código da mesa) ---------- */
    if (m === 'GET' && rota.startsWith('/api/conta/')) {
      const cod = decodeURIComponent(rota.split('/')[3] || '').toUpperCase();
      const c = db.prepare('SELECT * FROM comandas WHERE codigo = ?').get(cod);
      if (!c) return json(res, 404, { erro: 'comanda não encontrada' });
      const t = totais(c.id);
      const mesa = db.prepare('SELECT numero, area, lugares FROM mesas WHERE id = ?').get(c.mesa_id);
      return json(res, 200, { casa: CASA.nome, mesa, status: c.status, codigo: c.codigo,
        aberta_em: c.aberta_em, fechada_em: c.fechada_em,
        itens: t.itens.map(i => ({ nome: i.nome, qtd: i.qtd, preco_cent: i.preco_cent,
          total_cent: i.qtd * i.preco_cent, origem: i.origem, criado_em: i.criado_em })),
        subtotal_cent: t.subtotal_cent, servico_cent: t.servico_cent, servico_pct: t.servico_pct,
        total_cent: t.total_cent, pessoas: t.pessoas, porPessoa_cent: t.porPessoa_cent });
    }

    if (m === 'POST' && /^\/api\/conta\/[^/]+\/chamar$/.test(rota)) {
      const cod = decodeURIComponent(rota.split('/')[3]).toUpperCase();
      const { tipo } = await corpo(req);
      const c = db.prepare(`SELECT * FROM comandas WHERE codigo = ? AND status='aberta'`).get(cod);
      if (!c) return json(res, 404, { erro: 'comanda não está aberta' });
      const mesa = db.prepare('SELECT numero FROM mesas WHERE id = ?').get(c.mesa_id);
      const t = tipo === 'conta' ? 'pediu-conta' : 'chamou-garcom';
      emitir(t, mesa.numero, { comanda_id: c.id },
        urb1.telegrama('CLI', t === 'conta' ? 'CONT' : 'GARC', mesa.numero));
      return json(res, 200, { ok: true, tipo: t });
    }

    if (m === 'GET' && rota === '/api/cardapio') {
      return json(res, 200, db.prepare(
        'SELECT id, nome, categoria, preco_cent, estacao, afericao FROM cardapio WHERE ativo=1 ORDER BY categoria, nome').all());
    }

    /* ---------- entrada da equipe ---------- */
    if (m === 'POST' && rota === '/api/entrar') {
      const { pin } = await corpo(req);
      const equipe = db.prepare('SELECT * FROM funcionarios WHERE ativo = 1').all();
      const achou = equipe.find(f => { try { return confirmaPin(pin, f.sal, f.pin_hash); } catch { return false; } });
      if (!achou) { await new Promise(r => setTimeout(r, 400)); return json(res, 401, { erro: 'PIN não confere' }); }
      const token = novaSessao(achou);
      res.setHeader('set-cookie', `sessao=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
      return json(res, 200, { token, nome: achou.nome, papel: achou.papel });
    }

    /* ---------- daqui pra baixo, só com sessão ---------- */
    const s = sessao(req);
    if (rota.startsWith('/api/') && !s) return json(res, 401, { erro: 'sessão ausente' });

    if (m === 'GET' && rota === '/api/salao') return json(res, 200, { ...salao(), eu: { nome: s.nome, papel: s.papel } });

    if (m === 'GET' && rota === '/api/eventos') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache',
        connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`event: ligado\ndata: ${JSON.stringify({ urb1: urb1.telegrama('SRV', 'LIGA', 0) })}\n\n`);
      ouvintes.add(res);
      const bata = setInterval(() => { try { res.write(': .\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(bata); ouvintes.delete(res); });
      return;
    }

    if (m === 'POST' && /^\/api\/mesas\/\d+\/abrir$/.test(rota)) {
      const numero = Number(rota.split('/')[3]);
      const { pessoas } = await corpo(req);
      const mesa = db.prepare('SELECT * FROM mesas WHERE numero = ?').get(numero);
      if (!mesa) return json(res, 404, { erro: 'mesa não existe' });
      if (comandaAberta(mesa.id)) return json(res, 409, { erro: 'mesa já tem comanda aberta' });
      const cod = codigoMesa();
      const r = db.prepare(`INSERT INTO comandas (mesa_id, codigo, pessoas, servico_pct, aberta_em, aberta_por)
        VALUES (?,?,?,?,?,?)`).run(mesa.id, cod, Math.max(1, Number(pessoas) || 1), CASA.servicoPct, agora(), s.id);
      db.prepare(`UPDATE mesas SET status='ocupada' WHERE id = ?`).run(mesa.id);
      emitir('mesa-aberta', numero, { comanda_id: Number(r.lastInsertRowid), codigo: cod },
        urb1.telegrama('SAL', 'ABRE', numero, [pessoas || 1]));
      return json(res, 201, { comanda_id: Number(r.lastInsertRowid), codigo: cod });
    }

    if (m === 'POST' && /^\/api\/comandas\/\d+\/itens$/.test(rota)) {
      const id = Number(rota.split('/')[3]);
      const c = db.prepare(`SELECT * FROM comandas WHERE id=? AND status='aberta'`).get(id);
      if (!c) return json(res, 404, { erro: 'comanda não está aberta' });
      const b = await corpo(req);
      let nome = b.nome, preco = Number(b.preco_cent), estacao = b.estacao || 'cozinha';
      if (b.item_id) {
        const it = db.prepare('SELECT * FROM cardapio WHERE id=? AND ativo=1').get(Number(b.item_id));
        if (!it) return json(res, 404, { erro: 'item fora do cardápio' });
        nome = it.nome; preco = it.preco_cent; estacao = it.estacao;
      }
      if (!nome || !Number.isInteger(preco) || preco < 0) return json(res, 400, { erro: 'item sem nome ou preço inteiro em centavos' });
      const qtd = Math.max(1, Math.min(99, Number(b.qtd) || 1));
      const r = db.prepare(`INSERT INTO lancamentos
        (comanda_id, item_id, nome, qtd, preco_cent, origem, estacao, medicao_id, criado_em, por)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, b.item_id || null, nome, qtd, preco,
          b.origem || 'garcom', estacao, b.medicao_id || null, agora(), s.id);
      const mesa = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
      const t = totais(id);
      emitir('lancamento', mesa.numero, { comanda_id: id, nome, qtd, total_cent: t.total_cent },
        urb1.telegrama('SAL', 'LANC', mesa.numero, [qtd, Math.round(preco / 100)]));
      return json(res, 201, { lancamento_id: Number(r.lastInsertRowid), total_cent: t.total_cent });
    }

    if (m === 'DELETE' && /^\/api\/lancamentos\/\d+$/.test(rota)) {
      const id = Number(rota.split('/')[3]);
      const l = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(id);
      if (!l) return json(res, 404, { erro: 'lançamento não existe' });
      const c = db.prepare('SELECT * FROM comandas WHERE id=?').get(l.comanda_id);
      if (c.status !== 'aberta') return json(res, 409, { erro: 'comanda já fechada' });
      db.prepare('DELETE FROM lancamentos WHERE id=?').run(id);
      const mesa = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
      emitir('estorno', mesa.numero, { comanda_id: c.id, nome: l.nome, total_cent: totais(c.id).total_cent });
      return json(res, 200, { ok: true });
    }

    if (m === 'GET' && /^\/api\/comandas\/\d+$/.test(rota)) {
      const id = Number(rota.split('/')[3]);
      const c = db.prepare('SELECT * FROM comandas WHERE id=?').get(id);
      if (!c) return json(res, 404, { erro: 'comanda não existe' });
      const mesa = db.prepare('SELECT * FROM mesas WHERE id=?').get(c.mesa_id);
      return json(res, 200, { ...totais(id), mesa });
    }

    if (m === 'POST' && /^\/api\/comandas\/\d+\/fechar$/.test(rota)) {
      const id = Number(rota.split('/')[3]);
      const c = db.prepare(`SELECT * FROM comandas WHERE id=? AND status='aberta'`).get(id);
      if (!c) return json(res, 404, { erro: 'comanda não está aberta' });
      const { semServico } = await corpo(req);
      if (semServico) db.prepare('UPDATE comandas SET servico_pct=0 WHERE id=?').run(id);
      const t = totais(id);
      db.prepare(`UPDATE comandas SET status='fechada', fechada_em=? WHERE id=?`).run(agora(), id);
      db.prepare(`UPDATE mesas SET status='livre' WHERE id=?`).run(c.mesa_id);
      const mesa = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
      let brcode = null;
      if (CASA.pixChave) {
        brcode = pix.brcode({ chave: CASA.pixChave, valor: t.total_cent / 100,
          nome: CASA.pixNome, cidade: CASA.cidade, txid: c.codigo });
      }
      emitir('mesa-fechada', mesa.numero, { comanda_id: id, total_cent: t.total_cent },
        urb1.telegrama('SAL', 'FECH', mesa.numero, [Math.round(t.total_cent / 100)]));
      return json(res, 200, { total_cent: t.total_cent, subtotal_cent: t.subtotal_cent,
        servico_cent: t.servico_cent, porPessoa_cent: t.porPessoa_cent, pix: brcode,
        aviso_pix: brcode ? 'Copia-e-cola gerado. Confirme o recebimento no app do banco antes de liberar a mesa.'
          : 'PIX_CHAVE não configurada — nenhum código Pix foi gerado.' });
    }

    /* ---------- aferição de prato pela câmera ---------- */
    if (m === 'GET' && rota === '/api/padroes') {
      return json(res, 200, db.prepare(
        `SELECT p.item_id, p.n, p.mu, p.sigma, p.atualizado_em, c.nome
           FROM padroes p JOIN cardapio c ON c.id = p.item_id`).all()
        .map(p => ({ ...p, mu: JSON.parse(p.mu), sigma: JSON.parse(p.sigma) })));
    }

    if (m === 'POST' && rota === '/api/padroes') {
      const { item_id, amostras } = await corpo(req);
      const it = db.prepare('SELECT * FROM cardapio WHERE id=?').get(Number(item_id));
      if (!it) return json(res, 404, { erro: 'item fora do cardápio' });
      if (!Array.isArray(amostras) || amostras.length < 3)
        return json(res, 400, { erro: 'precisa de pelo menos 3 fotos do prato aprovado' });
      const env = envelope(amostras);
      db.prepare(`INSERT INTO padroes (item_id, n, mu, sigma, atualizado_em)
        VALUES (?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET
        n=excluded.n, mu=excluded.mu, sigma=excluded.sigma, atualizado_em=excluded.atualizado_em`)
        .run(it.id, amostras.length, JSON.stringify(env.mu), JSON.stringify(env.sigma), agora());
      emitir('padrao-gravado', null, { item: it.nome, n: amostras.length });
      return json(res, 200, { item: it.nome, n: amostras.length, mu: env.mu, sigma: env.sigma });
    }

    if (m === 'POST' && rota === '/api/reconhecer') {
      const { grandezas, mesa } = await corpo(req);
      if (!grandezas || typeof grandezas !== 'object')
        return json(res, 400, { erro: 'sem vetor de grandezas' });
      const padroes = db.prepare(
        `SELECT p.item_id, p.n, p.mu, p.sigma, c.nome, c.preco_cent, c.estacao
           FROM padroes p JOIN cardapio c ON c.id=p.item_id WHERE c.ativo=1`).all()
        .map(p => ({ ...p, mu: JSON.parse(p.mu), sigma: JSON.parse(p.sigma) }));
      const r = identificar(grandezas, padroes);
      const med = db.prepare(`INSERT INTO medicoes (comanda_id, item_id, grandezas, dm, confianca, camada, veredito, criado_em)
        VALUES (?,?,?,?,?,?,?,?)`).run(null, r.item_id ?? null, JSON.stringify(grandezas),
          r.dm ?? null, r.separacao ?? null, r.camada, r.veredito, agora());
      if (mesa) emitir('afericao', Number(mesa), { veredito: r.veredito, item: r.nome || null },
        urb1.telegrama('AFE', 'PRAT', Number(mesa), [Math.round((r.dm ?? 0) * 100)]));
      return json(res, 200, { ...r, medicao_id: Number(med.lastInsertRowid) });
    }

    /* ---------- retrato sob demanda (antes de fechar a casa, por exemplo) ---------- */
    if (m === 'POST' && rota === '/api/snapshot') {
      if (persistencia.estado().modo !== 'github')
        return json(res, 409, { erro: 'sem SNAP_REPO/SNAP_TOKEN configurados — não há onde guardar' });
      const ok = await persistencia.enviar(db, 'manual');
      return json(res, ok ? 200 : 502, ok ? { ok: true, ...persistencia.estado() }
        : { erro: persistencia.estado().erro || 'não deu para gravar o retrato' });
    }

    /* ---------- passe / KDS ---------- */
    if (m === 'GET' && rota === '/api/passe') {
      const linhas = db.prepare(
        `SELECT l.id, l.nome, l.qtd, l.estacao, l.estado, l.criado_em, m.numero mesa
           FROM lancamentos l JOIN comandas c ON c.id=l.comanda_id JOIN mesas m ON m.id=c.mesa_id
          WHERE c.status='aberta' AND l.estado='pendente' ORDER BY l.id`).all();
      return json(res, 200, linhas);
    }
    if (m === 'POST' && /^\/api\/passe\/\d+\/pronto$/.test(rota)) {
      const id = Number(rota.split('/')[3]);
      db.prepare(`UPDATE lancamentos SET estado='pronto' WHERE id=?`).run(id);
      emitir('passe-pronto', null, { lancamento_id: id });
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { erro: 'rota não existe' });
  } catch (e) {
    return json(res, e.message === 'json inválido' ? 400 : 500, { erro: e.message });
  }
});

if (require.main === module) {
  preparar().then(() => servidor.listen(PORTA, () => {
    console.log(`BAHREM · Salão em http://localhost:${PORTA}`);
    console.log(`banco: ${ARQUIVO}`);
    if (!CASA.pixChave) console.log('PIX_CHAVE ausente — fechamento não gera copia-e-cola.');
  }));
}

module.exports = { servidor, preparar, totais, salao, emitir, CASA, banco: () => db };
