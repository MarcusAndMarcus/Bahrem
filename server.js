'use strict';
/* BURGUER · Salão — servidor único, zero dependência npm.
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
const assistente = require('./assistente');
const conta = require('./conta');
const fiscal = require('./fiscal');
const { identificar, envelope, afastamento, LIM_OK, LIM_REJ, SEP_MIN } = require('./afericao');

const PORTA = Number(process.env.PORT) || 3000;
const CASA = {
  nome: process.env.CASA_NOME || 'Burguer',
  cidade: process.env.CASA_CIDADE || 'GOIANIA',
  pixChave: process.env.PIX_CHAVE || '',
  pixNome: process.env.PIX_NOME || 'BURGUER',
  servicoPct: Number(process.env.SERVICO_PCT ?? 10)
};

const DIAS_EVENTO = Number(process.env.DIAS_EVENTO || 7);
/* as fotos moram ao lado do banco, em arquivo — não dentro do SQLite */
const PASTA_FOTOS = path.join(path.dirname(ARQUIVO), 'fotos');
const FOTO_MAX = 350 * 1024;
let db = null;

/* O banco só existe depois de tentar trazer o último retrato de volta — em
   hospedagem sem disco (Render free) é isso que separa "o salão lembra da noite
   passada" de "o salão acorda vazio". Por isso o arranque é assíncrono. */
async function preparar() {
  if (db) return db;
  const veio = await persistencia.restaurar(ARQUIVO);
  const fotos = await persistencia.restaurarFotos(PASTA_FOTOS);
  if (fotos) console.log(`${fotos} foto(s) do cardápio restaurada(s)`);
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

/* ─────────────────────────── sessões ───────────────────────────
   Token assinado (HMAC-SHA256), não guardado em memória. Motivo: no Render
   free o processo hiberna e reinicia, e um Map em memória deslogava o salão
   inteiro a cada acordada. Com a assinatura, qualquer processo que tenha o
   mesmo SESSAO_SEGREDO reconhece o token.

   O token só carrega o id do funcionário e a validade. Nome e papel são lidos
   do banco a cada requisição — assim, desativar alguém ou tirar o papel de
   gerente vale na hora, sem esperar o token vencer. */
const VALIDADE = 12 * 3600 * 1000;
const SEGREDO = process.env.SESSAO_SEGREDO || crypto.randomBytes(32).toString('hex');
const SEGREDO_FIXO = Boolean(process.env.SESSAO_SEGREDO);

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const assinar = txt => b64url(crypto.createHmac('sha256', SEGREDO).update(txt).digest());

function novaSessao(f) {
  const carga = b64url(JSON.stringify({ i: f.id, e: Date.now() + VALIDADE }));
  return `${carga}.${assinar(carga)}`;
}

function sessao(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7)
    : (/(?:^|;\s*)sessao=([A-Za-z0-9_\-.]+)/.exec(req.headers.cookie || '') || [])[1];
  if (!t || t.length > 400) return null;
  const [carga, assinatura] = t.split('.');
  if (!carga || !assinatura) return null;
  const esperado = Buffer.from(assinar(carga));
  const veio = Buffer.from(assinatura);
  /* comparação em tempo constante: não deixa medir quantos bytes bateram */
  if (esperado.length !== veio.length || !crypto.timingSafeEqual(esperado, veio)) return null;
  let dados;
  try { dados = JSON.parse(Buffer.from(carga.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); }
  catch { return null; }
  if (!dados || !Number.isInteger(dados.i) || !(dados.e > Date.now())) return null;
  const f = db.prepare('SELECT id, nome, papel FROM funcionarios WHERE id=? AND ativo=1').get(dados.i);
  return f ? { id: f.id, nome: f.nome, papel: f.papel, exp: dados.e } : null;
}

/* ─────────────────────────── tentativas de PIN ───────────────────────────
   PIN de 4 dígitos são 10.000 combinações. Sem freio, um script testa todas.
   Duas travas:
   - por origem: 5 erros seguidos bloqueiam por 30 s, e cada novo bloqueio
     dobra (30 s, 60 s, 2 min… até 30 min). Acertar zera;
   - geral: mais de 20 erros por minuto, somando todas as origens, e a
     entrada recusa sem nem conferir o PIN até o minuto virar. É esta que
     segura quem troca de IP a cada tentativa. */
const TRAVA = { erros: 5, base: 30000, teto: 30 * 60000, geralPorMinuto: 20 };
const tentativas = new Map();       // origem -> { erros, travas, ate }
let geral = { inicio: Date.now(), erros: 0 };

function origem(req) {
  /* atrás de proxy, a última entrada do x-forwarded-for é a que o proxy
     acrescentou — o cliente não consegue forjá-la. Pode ser o IP da borda da
     CDN e não o do cliente; por isso existe também o teto geral. */
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || '?');
}

function podeTentar(chave) {
  const agora = Date.now();
  if (agora - geral.inicio > 60000) geral = { inicio: agora, erros: 0 };
  if (geral.erros >= TRAVA.geralPorMinuto)
    return { ok: false, espera: Math.ceil((geral.inicio + 60000 - agora) / 1000) };
  const t = tentativas.get(chave);
  if (t && t.ate > agora) return { ok: false, espera: Math.ceil((t.ate - agora) / 1000) };
  return { ok: true };
}

function errou(chave) {
  geral.erros++;
  const t = tentativas.get(chave) || { erros: 0, travas: 0, ate: 0 };
  t.erros++;
  if (t.erros >= TRAVA.erros) {
    t.ate = Date.now() + Math.min(TRAVA.teto, TRAVA.base * 2 ** t.travas);
    t.travas++; t.erros = 0;
  }
  tentativas.set(chave, t);
  if (tentativas.size > 5000) {                   // não deixa o Map crescer sem fim
    const agora = Date.now();
    for (const [k, v] of tentativas) if (v.ate < agora && v.erros === 0) tentativas.delete(k);
  }
}

/* ─────────────────────────── eventos (SSE) ─────────────────────────── */
const ouvintes = new Set();

function emitir(tipo, mesa, carga = {}, telegrama = null) {
  const quadro = telegrama || urb1.telegrama('SRV', tipo.slice(0, 4), mesa || 0,
    [carga.total_cent ? Math.round(carga.total_cent / 100) : 0]);
  db.prepare('INSERT INTO eventos (tipo, mesa, carga, urb1, criado_em) VALUES (?,?,?,?,?)')
    .run(tipo, mesa ?? null, JSON.stringify(carga), quadro, agora());
  /* Sem "event:" nomeado: tudo vai pelo canal padrão, e o tipo segue dentro
     do dado. Com nome, o navegador só entrega o evento a quem escuta aquele
     nome exato — e a lista das telas tinha 9 nomes para 17 tipos emitidos:
     pedido do celular, item pronto, transferência e nota nunca chegavam. */
  const linha = `data: ${JSON.stringify({ tipo, mesa, ...carga, urb1: quadro })}\n\n`;
  for (const res of ouvintes) { try { res.write(linha); } catch { ouvintes.delete(res); } }
  persistencia.marcar(db); // todo estado que muda passa por aqui
}

/* As formas que o caixa aceita. 'nao-informado' existe porque fechamento antigo
   (e chamada de API sem pagamento) precisa cair em algum lugar visível, em vez
   de sumir dentro do total como se fosse dinheiro. */
const FORMAS = ['dinheiro', 'pix', 'credito', 'debito', 'voucher', 'nao-informado'];

/* ─────────────────────────── fuso ───────────────────────────
   O servidor pode estar em UTC (o comum em nuvem) ou em qualquer outro fuso;
   a noite do bar é em Brasília. Todo cálculo de hora da noite passa por aqui,
   só com métodos UTC — o fuso do servidor deixa de importar. */
const FUSO_MIN = (() => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(process.env.FUSO || process.env.NFCE_FUSO || '-03:00');
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : -180;
})();
const horaLocal = iso => new Date(Date.parse(iso) + FUSO_MIN * 60000).getUTCHours();

/** início da "noite" corrente: o bar vira às NOITE_INICIO horas de Brasília */
function inicioDaNoite(agora = Date.now(), corte = Number(process.env.NOITE_INICIO ?? 12)) {
  const local = new Date(agora + FUSO_MIN * 60000);          // relógio de parede, lido em UTC
  if (local.getUTCHours() < corte) local.setUTCDate(local.getUTCDate() - 1);
  local.setUTCHours(corte, 0, 0, 0);
  return new Date(local.getTime() - FUSO_MIN * 60000);        // de volta ao instante real
}

/* ─────────────────────────── contas ─────────────────────────── */
const dinheiro = c => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

function totais(comandaId) {
  const itens = db.prepare(
    `SELECT id, item_id, nome, qtd, preco_cent, origem, estacao, estado, observacao,
            criado_em, pronto_em, entregue_em
       FROM lancamentos WHERE comanda_id = ? AND estornado_em IS NULL ORDER BY id`).all(comandaId);
  const c = db.prepare('SELECT * FROM comandas WHERE id = ?').get(comandaId);

  const divisao = new Map();
  for (const d of db.prepare(
    `SELECT d.lancamento_id, d.pessoa FROM divisao d
       JOIN lancamentos l ON l.id = d.lancamento_id WHERE l.comanda_id = ?`).all(comandaId)) {
    if (!divisao.has(d.lancamento_id)) divisao.set(d.lancamento_id, []);
    divisao.get(d.lancamento_id).push(d.pessoa);
  }
  for (const i of itens) i.divisao = divisao.get(i.id) || [];

  const soma = conta.calcular({ itens, pessoas: c.pessoas, divisao,
    servicoPct: c.servico_pct, descontoCent: c.desconto_cent });
  return { itens, ...soma, comanda: c, nomes: nomesDe(c),
    desconto_motivo: c.desconto_motivo || null };
}

/* quem dividiu cada item — usada pela rota da equipe e pela do cliente */
function aplicarDivisao(l, c, pessoas) {
  const validas = [...new Set((Array.isArray(pessoas) ? pessoas : []).map(Number))]
    .filter(p => Number.isInteger(p) && p >= 1 && p <= c.pessoas);
  db.prepare('DELETE FROM divisao WHERE lancamento_id=?').run(l.id);
  for (const p of validas) db.prepare('INSERT INTO divisao (lancamento_id, pessoa) VALUES (?,?)').run(l.id, p);
  const mesa = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
  emitir('divisao', mesa.numero, { lancamento_id: l.id, pessoas: validas.length });
  return validas;
}

/* nomes das pessoas da mesa, quando alguém se deu ao trabalho de digitar */
function nomesDe(c) {
  let lista = [];
  try { lista = JSON.parse(c.nomes || '[]'); } catch {}
  return Array.from({ length: Math.max(1, c.pessoas) },
    (_, i) => (typeof lista[i] === 'string' && lista[i].trim()) ? lista[i].trim().slice(0, 24) : `Pessoa ${i + 1}`);
}

/* um item só existe no passe depois de virar conta */
const NA_CONTA = `estado NOT IN ('sugerido','recusado') AND estornado_em IS NULL`;
const DESFAZER_MS = 2 * 60000;

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
    const sugeridos = t.itens.filter(i => i.estado === 'sugerido').length;
    const naCozinha = t.itens.filter(i => i.estado === 'pendente' || i.estado === 'preparo');
    const prontos = t.itens.filter(i => i.estado === 'pronto').length;
    const maisVelho = naCozinha.reduce((a, i) => Math.min(a, Date.parse(i.criado_em)), Infinity);
    return { ...m, status: 'ocupada', comanda_id: c.id, codigo: c.codigo, pessoas: c.pessoas,
      aberta_em: c.aberta_em, itens: t.itens.filter(i => i.estado !== 'sugerido').length,
      total_cent: t.total_cent, subtotal_cent: t.subtotal_cent, chamada: chamada?.tipo || null,
      sugeridos, prontos, esperandoDesde: Number.isFinite(maisVelho) ? new Date(maisVelho).toISOString() : null };
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
      chamadas: abertas.filter(m => m.chamada).length,
      sugeridos: abertas.reduce((s, m) => s + (m.sugeridos || 0), 0),
      prontos: abertas.reduce((s, m) => s + (m.prontos || 0), 0),
      ticket_cent: abertas.length ? Math.round(abertas.reduce((s, m) => s + m.total_cent, 0) / abertas.length) : 0
    },
    casa: { nome: CASA.nome, servicoPct: CASA.servicoPct, pix: Boolean(CASA.pixChave),
      assistente: assistente.ligado(), fiscal: fiscal.modo() }
  };
}

/* ─────────────────────────── NFC-e ───────────────────────────
   Emitir é idempotente por comanda: se já há nota autorizada, devolve ela;
   se a última ficou "pendente" (a rede caiu no meio), consulta antes e, se
   precisar, reenvia com a MESMA referência — a Focus reconhece a ref e não
   emite duas vezes. Só uma rejeição da SEFAZ abre referência nova. */
const NOTA_PUBLICA = n => n && ({ ref: n.ref, status: n.status, ambiente: n.ambiente,
  chave: n.chave, numero: n.numero, serie: n.serie, mensagem: n.mensagem,
  danfe: n.danfe, qrcode: n.qrcode, consulta: n.consulta, total_cent: n.total_cent,
  criado_em: n.criado_em, autorizada_em: n.autorizada_em, cancelada_em: n.cancelada_em });

function ultimaNota(comandaId) {
  return db.prepare('SELECT * FROM notas WHERE comanda_id=? ORDER BY id DESC LIMIT 1').get(comandaId);
}

function gravarResultado(nota, r) {
  db.prepare(`UPDATE notas SET status=?, chave=COALESCE(?,chave), numero=COALESCE(?,numero),
      serie=COALESCE(?,serie), mensagem=?, danfe=COALESCE(?,danfe), xml=COALESCE(?,xml),
      qrcode=COALESCE(?,qrcode), consulta=COALESCE(?,consulta), resposta=?, atualizado_em=?,
      autorizada_em=CASE WHEN ?='autorizado' AND autorizada_em IS NULL THEN ? ELSE autorizada_em END
    WHERE id=?`).run(r.status === 'nao_encontrada' ? 'pendente' : r.status,
    r.chave || null, r.numero || null, r.serie || null, r.mensagem || null, r.danfe || null,
    r.xml || null, r.qrcode || null, r.consulta || null, JSON.stringify(r), agora(),
    r.status, agora(), nota.id);
  return db.prepare('SELECT * FROM notas WHERE id=?').get(nota.id);
}

async function emitirNota(comandaId, { cpf = '', por = null } = {}) {
  const c = db.prepare('SELECT * FROM comandas WHERE id=?').get(comandaId);
  if (!c) return { http: 404, erro: 'comanda não existe' };
  if (c.status !== 'fechada') return { http: 409, erro: 'a nota sai depois de fechar a conta' };

  let ultima = ultimaNota(comandaId);
  if (ultima && ultima.status === 'autorizado') return { http: 200, nota: ultima, jaExistia: true };
  if (ultima && ultima.status === 'pendente') {
    const r = await fiscal.consultar(ultima.ref);
    if (r.status === 'autorizado' || r.status === 'erro') {
      ultima = gravarResultado(ultima, r);
      if (r.status === 'autorizado') return { http: 200, nota: ultima };
    }
  }

  const itens = db.prepare(
    `SELECT item_id, nome, qtd, preco_cent, estacao FROM lancamentos
      WHERE comanda_id=? AND ${NA_CONTA} ORDER BY id`).all(comandaId);
  const cardapio = new Map(db.prepare('SELECT * FROM cardapio').all().map(i => [i.id, i]));
  const pagamentos = db.prepare('SELECT forma, valor_cent FROM pagamentos WHERE comanda_id=? ORDER BY id')
    .all(comandaId);

  let montada;
  try {
    montada = fiscal.montarNota({ itens, cardapio, desconto_cent: c.desconto_cent, pagamentos, cpf });
  } catch (e) {
    if (e.fiscal) return { http: 400, erro: e.message };
    throw e;
  }

  const modo = fiscal.modo();
  if (modo === 'producao' && montada.naoRevisados.length) {
    return { http: 409, erro: 'em produção só sai nota com cadastro fiscal revisado — faltam: ' +
      montada.naoRevisados.join(', '), naoRevisados: montada.naoRevisados };
  }

  const reusar = ultima && ultima.status === 'pendente';
  const tentativa = db.prepare('SELECT COUNT(*) n FROM notas WHERE comanda_id=?').get(comandaId).n + 1;
  const ref = reusar ? ultima.ref : `burguer-${comandaId}-${tentativa}`;

  if (modo === 'nao-fiscal') {
    db.prepare(`INSERT INTO notas (comanda_id, ref, ambiente, status, mensagem, total_cent, cpf,
        payload, criado_em, atualizado_em, por) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(comandaId, ref, 'nao-fiscal', 'nao-fiscal',
        'sem FOCUS_NFE_TOKEN/FOCUS_NFE_CNPJ: comprovante SEM VALOR FISCAL, nada foi enviado à SEFAZ',
        montada.total_cent, montada.nota.cpf_destinatario || null, JSON.stringify(montada.nota), agora(), agora(), por);
    return { http: 200, nota: ultimaNota(comandaId), avisos: montada.avisos };
  }

  /* grava ANTES de enviar: se o processo cair no meio, fica o registro de que
     uma nota foi para a Focus com esta referência */
  if (!reusar) {
    db.prepare(`INSERT INTO notas (comanda_id, ref, ambiente, status, total_cent, cpf, payload,
        criado_em, atualizado_em, por) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(comandaId, ref, modo, 'pendente', montada.total_cent,
        montada.nota.cpf_destinatario || null, JSON.stringify(montada.nota), agora(), agora(), por);
  }
  const registro = db.prepare('SELECT * FROM notas WHERE ref=?').get(ref);
  const r = await fiscal.emitir(ref, montada.nota);
  const nota = gravarResultado(registro, r);
  const mesa = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
  emitir('nfce-' + nota.status, mesa.numero, { comanda_id: comandaId, ref, numero: nota.numero });
  return { http: 200, nota, avisos: montada.avisos };
}

/* ─────────────────────────── HTTP ─────────────────────────── */
/* Pasta única: o código e o banco moram no mesmo diretório que a interface.
   Por isso o servidor NÃO serve "tudo o que estiver na pasta" — serve esta
   lista e mais nada. Pedir /server.js, /testes.js ou /dados/salao.db dá 404
   igual a pedir um arquivo que não existe. */
const PUBLICOS = new Set([
  'index.html', 'salao.html', 'mesa.html', 'passe.html', 'camera.html',
  'noite.html', 'qr.html', 'cardapio.html', 'cupom.html', 'sistema.html',
  'burguer.css', 'app.js', 'nucleo.js', 'alerta.js', 'caixinha.js', 'captura.js',
  'casa.jpg'
]);

const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json' };

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

/* Quando o sistema roda empacotado num arquivo só, a interface vem embutida
   aqui dentro em vez de vir do disco. É o mesmo servidor: muda a origem dos
   bytes, não a lista branca nem a rota. */
const EMBUTIDOS = globalThis.__BURGUER_ARQUIVOS || null;

function estatico(res, arquivo) {
  /* só o nome do arquivo importa: caminho com barra, .. ou subpasta não passa
     pela lista branca, então travessia de diretório morre aqui */
  if (!PUBLICOS.has(arquivo)) return json(res, 404, { erro: 'não encontrado' });

  if (EMBUTIDOS && EMBUTIDOS[arquivo]) {
    const { tipo, base64, texto } = EMBUTIDOS[arquivo];
    const buf = base64 ? Buffer.from(base64, 'base64') : Buffer.from(texto, 'utf8');
    res.writeHead(200, { 'content-type': tipo, 'cache-control': 'no-cache' });
    return res.end(buf);
  }

  const alvo = path.join(__dirname, arquivo);
  fs.readFile(alvo, (e, buf) => {
    if (e) return json(res, 404, { erro: 'não encontrado' });
    res.writeHead(200, { 'content-type': TIPOS[path.extname(alvo)] || 'application/octet-stream',
      'cache-control': 'no-cache' });
    res.end(buf);
  });
}

/* Cabeçalhos de segurança em toda resposta.
   - Referrer-Policy no-referrer: a URL do cliente carrega o código da comanda
     (/mesa?c=…), que é o que dá acesso à conta dele. Sem isto, o navegador
     mandaria esse código no Referer para o Google Fonts e para o cdnjs.
   - CSP: 'unsafe-inline' fica, e é uma escolha consciente — as páginas têm
     script embutido e você edita os arquivos à mão; CSP por hash quebraria a
     cada vírgula alterada. O que a CSP ainda segura: script de domínio
     estranho, página embutida em iframe alheio, envio de dado para fora. */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ');

function blindar(req, res) {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(self), microphone=(), geolocation=()');
  if (req.headers['x-forwarded-proto'] === 'https')
    res.setHeader('strict-transport-security', 'max-age=15552000');
}

const servidor = http.createServer(async (req, res) => {
  blindar(req, res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rota = url.pathname;
  const m = req.method;

  try {
    /* ---------- páginas ---------- */
    if (m === 'GET' && rota === '/') return estatico(res, 'index.html');
    if (m === 'GET' && rota === '/salao') return estatico(res, 'salao.html');
    if (m === 'GET' && rota === '/camera') return estatico(res, 'camera.html');
    if (m === 'GET' && rota === '/mesa') return estatico(res, 'mesa.html');
    if (m === 'GET' && rota === '/passe') return estatico(res, 'passe.html');
    if (m === 'GET' && rota === '/noite') return estatico(res, 'noite.html');
    if (m === 'GET' && rota === '/qr') return estatico(res, 'qr.html');
    if (m === 'GET' && rota === '/cardapio') return estatico(res, 'cardapio.html');
    if (m === 'GET' && rota === '/cupom') return estatico(res, 'cupom.html');
    if (m === 'GET' && rota === '/sistema') return estatico(res, 'sistema.html');
    /* foto do prato: pública, porque o cliente vê o cardápio sem login.
       Só número no nome — nada de caminho, nada de extensão alternativa. */
    if (m === 'GET' && /^\/foto\/\d+\.jpg$/.test(rota)) {
      const id = Number(rota.slice(6, -4));
      const alvo = path.join(PASTA_FOTOS, `${id}.jpg`);
      return fs.readFile(alvo, (e, buf) => {
        if (e) return json(res, 404, { erro: 'sem foto' });
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length,
          /* a URL leva ?v=versão, então pode guardar em cache sem medo */
          'cache-control': 'public, max-age=604800, immutable' });
        res.end(buf);
      });
    }

    if (m === 'GET' && !rota.startsWith('/api/')) return estatico(res, rota.slice(1));

    /* ---------- sinal de vida (usado pelo healthCheckPath da hospedagem) ---------- */
    if (m === 'GET' && rota === '/api/saude') {
      const p = persistencia.estado();
      return json(res, 200, { ok: true, desde: Math.round(process.uptime()), node: process.version,
        dados: { modo: p.modo, ultimoRetrato: p.ultimo, pendente: p.pendente, erro: p.erro } });
    }

    /* ---------- fluxo do cliente (sem login, só o código da mesa) ---------- */
    /* casa SÓ /api/conta/CÓDIGO — com "começa com", esta rota engolia
       /api/conta/CÓDIGO/nota antes de a rota da nota ser alcançada */
    if (m === 'GET' && /^\/api\/conta\/[^/]+$/.test(rota)) {
      const cod = decodeURIComponent(rota.split('/')[3] || '').toUpperCase();
      const c = db.prepare('SELECT * FROM comandas WHERE codigo = ?').get(cod);
      if (!c) return json(res, 404, { erro: 'comanda não encontrada' });
      const t = totais(c.id);
      const mesa = db.prepare('SELECT numero, area, lugares FROM mesas WHERE id = ?').get(c.mesa_id);
      return json(res, 200, { casa: CASA.nome, mesa, status: c.status, codigo: c.codigo,
        aberta_em: c.aberta_em, fechada_em: c.fechada_em, assistente: assistente.ligado(),
        itens: t.itens.map(i => ({ id: i.id, item_id: i.item_id, nome: i.nome, qtd: i.qtd,
          preco_cent: i.preco_cent, total_cent: i.qtd * i.preco_cent, origem: i.origem,
          estado: i.estado, observacao: i.observacao, divisao: i.divisao,
          criado_em: i.criado_em, pronto_em: i.pronto_em })),
        subtotal_cent: t.subtotal_cent, servico_cent: t.servico_cent, servico_pct: t.servico_pct,
        desconto_cent: t.desconto_cent, desconto_motivo: t.desconto_motivo,
        total_cent: t.total_cent, pessoas: t.pessoas, nomes: t.nomes,
        consumo_cent: t.consumo_cent, porPessoa_cent: t.porPessoa_cent, rateado: t.rateado });
    }

    if (m === 'POST' && /^\/api\/conta\/[^/]+\/chamar$/.test(rota)) {
      const cod = decodeURIComponent(rota.split('/')[3]).toUpperCase();
      const { tipo } = await corpo(req);
      const c = db.prepare(`SELECT * FROM comandas WHERE codigo = ? AND status='aberta'`).get(cod);
      if (!c) return json(res, 404, { erro: 'comanda não está aberta' });
      const mesa = db.prepare('SELECT numero FROM mesas WHERE id = ?').get(c.mesa_id);
      const t = tipo === 'conta' ? 'pediu-conta' : 'chamou-garcom';
      /* sem isto, um dedo nervoso (ou um script) fazia o tablet do salão
         apitar sem parar */
      const ultima = db.prepare(`SELECT criado_em FROM eventos WHERE mesa=? AND tipo=?
        ORDER BY id DESC LIMIT 1`).get(mesa.numero, t);
      if (ultima && Date.now() - Date.parse(ultima.criado_em) < 30000)
        return json(res, 429, { erro: 'o garçom já foi avisado — um instante' });
      /* o rótulo URB1 compara o PEDIDO ('conta'), não o tipo do evento: antes
         comparava t === 'conta', que nunca é verdade, e "pediu a conta" saía
         no barramento como chamada de garçom */
      emitir(t, mesa.numero, { comanda_id: c.id },
        urb1.telegrama('CLI', tipo === 'conta' ? 'CONT' : 'GARC', mesa.numero));
      return json(res, 200, { ok: true, tipo: t });
    }

    /* O cliente marca quem dividiu cada item, pela tela dele. Antes a tela
       chamava a rota da equipe: 401, e o 401 mandava o cliente para o PIN. */
    if (m === 'PUT' && /^\/api\/conta\/[^/]+\/divisao\/\d+$/.test(rota)) {
      const [, , , codTxt, , idTxt] = rota.split('/');
      const c = db.prepare(`SELECT * FROM comandas WHERE codigo=? AND status='aberta'`)
        .get(decodeURIComponent(codTxt).toUpperCase());
      if (!c) return json(res, 404, { erro: 'comanda não está aberta' });
      const l = db.prepare('SELECT * FROM lancamentos WHERE id=? AND comanda_id=?').get(Number(idTxt), c.id);
      if (!l) return json(res, 404, { erro: 'este item não é desta conta' });
      const { pessoas } = await corpo(req);
      return json(res, 200, { ok: true, pessoas: aplicarDivisao(l, c, pessoas) });
    }

    /* a nota do cliente, pelo código da comanda — é o que o cupom mostra */
    if (m === 'GET' && /^\/api\/conta\/[^/]+\/nota$/.test(rota)) {
      const cod = decodeURIComponent(rota.split('/')[3]).toUpperCase();
      const c = db.prepare('SELECT * FROM comandas WHERE codigo = ?').get(cod);
      if (!c) return json(res, 404, { erro: 'comanda não encontrada' });
      const n = ultimaNota(c.id);
      if (!n) return json(res, 404, { erro: 'esta conta ainda não tem nota' });
      const mesa = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
      let payload = null;
      try { payload = JSON.parse(n.payload || 'null'); } catch {}
      return json(res, 200, { casa: CASA.nome, mesa: mesa.numero, nota: NOTA_PUBLICA(n),
        itens: (payload?.items || []).map(i => ({ descricao: i.descricao, qtd: i.quantidade_comercial,
          unitario: i.valor_unitario_comercial, total: i.valor_bruto, desconto: i.valor_desconto || 0 })),
        pagamentos: (payload?.formas_pagamento || []).map(p => ({ codigo: p.forma_pagamento, valor: p.valor_pagamento })),
        cpf: n.cpf ? n.cpf.replace(/^(\d{3})\d{6}(\d{2})$/, '$1.***.***-$2') : null });
    }

    /* o cliente monta um pedido; ele entra como sugestão e o garçom decide */
    if (m === 'POST' && /^\/api\/conta\/[^/]+\/pedido$/.test(rota)) {
      const cod = decodeURIComponent(rota.split('/')[3]).toUpperCase();
      const c = db.prepare(`SELECT * FROM comandas WHERE codigo = ? AND status='aberta'`).get(cod);
      if (!c) return json(res, 404, { erro: 'comanda não está aberta' });
      const { itens } = await corpo(req);
      if (!Array.isArray(itens) || !itens.length) return json(res, 400, { erro: 'pedido vazio' });
      if (itens.length > 20) return json(res, 400, { erro: 'pedido grande demais para uma vez só' });

      const pendentes = db.prepare(
        `SELECT COUNT(*) n FROM lancamentos WHERE comanda_id=? AND estado='sugerido'`).get(c.id).n;
      if (pendentes >= 12) return json(res, 429, { erro: 'já há pedidos seus esperando o garçom' });

      const gravados = [];
      for (const pedido of itens.slice(0, 20)) {
        const it = db.prepare('SELECT * FROM cardapio WHERE id=? AND ativo=1').get(Number(pedido.item_id));
        if (!it) continue;
        const qtd = Math.max(1, Math.min(20, Number(pedido.qtd) || 1));
        const obs = String(pedido.observacao || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140) || null;
        const r = db.prepare(`INSERT INTO lancamentos
          (comanda_id, item_id, nome, qtd, preco_cent, origem, estacao, estado, observacao, criado_em)
          VALUES (?,?,?,?,?,?,?, 'sugerido', ?, ?)`)
          .run(c.id, it.id, it.nome, qtd, it.preco_cent, 'cliente', it.estacao, obs, agora());
        gravados.push({ id: Number(r.lastInsertRowid), nome: it.nome, qtd });
      }
      if (!gravados.length) return json(res, 400, { erro: 'nenhum item do pedido existe no cardápio' });
      const mesa = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
      emitir('pedido-cliente', mesa.numero, { comanda_id: c.id, itens: gravados.length },
        urb1.telegrama('CLI', 'PEDE', mesa.numero, [gravados.length]));
      return json(res, 201, { ok: true, itens: gravados });
    }

    /* assistente do cliente */
    if (m === 'POST' && /^\/api\/conta\/[^/]+\/assistente$/.test(rota)) {
      const cod = decodeURIComponent(rota.split('/')[3]).toUpperCase();
      if (!assistente.ligado()) return json(res, 503, { erro: 'assistente desligado nesta casa' });
      const c = db.prepare(`SELECT * FROM comandas WHERE codigo = ? AND status='aberta'`).get(cod);
      if (!c) return json(res, 404, { erro: 'comanda não está aberta' });
      const { mensagem, historico } = await corpo(req);
      const t = totais(c.id);
      const mesa = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
      const cardapio = db.prepare(
        'SELECT id, nome, categoria, preco_cent, estacao FROM cardapio WHERE ativo=1').all();
      const r = await assistente.assistir({ codigo: cod, mensagem,
        historico: Array.isArray(historico) ? historico : [], cardapio,
        conta: { ...t, mesa: mesa.numero } });
      if (r.erro) return json(res, 503, r);
      if (r.chamarGarcom) emitir('chamou-garcom', mesa.numero, { comanda_id: c.id, via: 'assistente' });
      return json(res, 200, r);
    }

    if (m === 'GET' && rota === '/api/cardapio') {
      return json(res, 200, db.prepare(
        `SELECT id, nome, categoria, preco_cent, estacao, afericao, foto_versao
           FROM cardapio WHERE ativo=1 ORDER BY categoria, nome`).all()
        .map(({ foto_versao, ...i }) => ({ ...i,
          foto: foto_versao ? `/foto/${i.id}.jpg?v=${foto_versao}` : null })));
    }

    /* ---------- entrada da equipe ---------- */
    if (m === 'POST' && rota === '/api/entrar') {
      const chave = origem(req);
      const livre = podeTentar(chave);
      if (!livre.ok) {
        res.setHeader('retry-after', String(livre.espera));
        return json(res, 429, { erro: `muitas tentativas — espere ${livre.espera} s`, espera: livre.espera });
      }
      const { pin } = await corpo(req);
      const equipe = db.prepare('SELECT * FROM funcionarios WHERE ativo = 1').all();
      const achou = equipe.find(f => { try { return confirmaPin(pin, f.sal, f.pin_hash); } catch { return false; } });
      if (!achou) {
        errou(chave);
        await new Promise(r => setTimeout(r, 400));
        return json(res, 401, { erro: 'PIN não confere' });
      }
      tentativas.delete(chave);
      const token = novaSessao(achou);
      const seguro = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('set-cookie', `sessao=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${seguro}`);
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
      const obs = String(b.observacao || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140) || null;
      const r = db.prepare(`INSERT INTO lancamentos
        (comanda_id, item_id, nome, qtd, preco_cent, origem, estacao, medicao_id, observacao, criado_em, por)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, b.item_id || null, nome, qtd, preco,
          b.origem || 'garcom', estacao, b.medicao_id || null, obs, agora(), s.id);
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
      if (l.estornado_em) return json(res, 409, { erro: 'já estornado' });
      /* estorno não apaga: marca. O item some da conta, mas fica no banco com
         hora e autor — estorno é o lugar clássico de desvio em bar, e a noite
         mostra cada um. Dá para desfazer por 2 minutos. */
      db.prepare('UPDATE lancamentos SET estornado_em=?, estornado_por=? WHERE id=?').run(agora(), s.id, id);
      const mesa = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
      emitir('estorno', mesa.numero, { comanda_id: c.id, nome: l.nome, total_cent: totais(c.id).total_cent });
      return json(res, 200, { ok: true, desfazerAte: new Date(Date.now() + DESFAZER_MS).toISOString() });
    }

    if (m === 'POST' && /^\/api\/lancamentos\/\d+\/desfazer$/.test(rota)) {
      const id = Number(rota.split('/')[3]);
      const l = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(id);
      if (!l || !l.estornado_em) return json(res, 404, { erro: 'nada para desfazer' });
      const c = db.prepare('SELECT * FROM comandas WHERE id=?').get(l.comanda_id);
      if (c.status !== 'aberta') return json(res, 409, { erro: 'comanda já fechada' });
      if (Date.now() - Date.parse(l.estornado_em) > DESFAZER_MS)
        return json(res, 409, { erro: 'passou o prazo de desfazer — lance o item de novo' });
      db.prepare('UPDATE lancamentos SET estornado_em=NULL, estornado_por=NULL WHERE id=?').run(id);
      const mesa = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
      emitir('lancamento', mesa.numero, { comanda_id: c.id, nome: l.nome, qtd: l.qtd,
        total_cent: totais(c.id).total_cent });
      return json(res, 200, { ok: true });
    }

    /* estados do item: pendente -> preparo -> pronto -> entregue */
    const ESTADOS = ['pendente', 'preparo', 'pronto', 'entregue'];
    if (m === 'POST' && /^\/api\/lancamentos\/\d+\/estado$/.test(rota)) {
      const id = Number(rota.split('/')[3]);
      const { estado } = await corpo(req);
      if (!ESTADOS.includes(estado)) return json(res, 400, { erro: 'estado que não existe' });
      const l = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(id);
      if (!l) return json(res, 404, { erro: 'lançamento não existe' });
      if (l.estado === 'sugerido' || l.estado === 'recusado')
        return json(res, 409, { erro: 'este item ainda é sugestão do cliente: aprove primeiro' });
      if (l.estornado_em) return json(res, 409, { erro: 'item estornado' });
      db.prepare(`UPDATE lancamentos SET estado=?,
        pronto_em = CASE WHEN ?='pronto' THEN ? ELSE pronto_em END,
        entregue_em = CASE WHEN ?='entregue' THEN ? ELSE entregue_em END WHERE id=?`)
        .run(estado, estado, agora(), estado, agora(), id);
      const mesa = db.prepare(`SELECT m.numero FROM comandas c JOIN mesas m ON m.id=c.mesa_id WHERE c.id=?`)
        .get(l.comanda_id);
      emitir('item-' + estado, mesa.numero, { lancamento_id: id, nome: l.nome });
      return json(res, 200, { ok: true, estado });
    }

    /* o garçom decide sobre o que o cliente pediu pelo celular */
    if (m === 'POST' && /^\/api\/lancamentos\/\d+\/(aprovar|recusar)$/.test(rota)) {
      const [, , , idTxt, acao] = rota.split('/');
      const id = Number(idTxt);
      const l = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(id);
      if (!l) return json(res, 404, { erro: 'lançamento não existe' });
      if (l.estado !== 'sugerido') return json(res, 409, { erro: 'este item não é uma sugestão pendente' });
      db.prepare('UPDATE lancamentos SET estado=?, por=? WHERE id=?')
        .run(acao === 'aprovar' ? 'pendente' : 'recusado', s.id, id);
      const mesa = db.prepare(`SELECT m.numero FROM comandas c JOIN mesas m ON m.id=c.mesa_id WHERE c.id=?`)
        .get(l.comanda_id);
      emitir(acao === 'aprovar' ? 'pedido-aceito' : 'pedido-recusado', mesa.numero,
        { lancamento_id: id, nome: l.nome, total_cent: totais(l.comanda_id).total_cent });
      return json(res, 200, { ok: true });
    }

    /* rateio por item: quem divide o quê */
    if (m === 'PUT' && /^\/api\/lancamentos\/\d+\/divisao$/.test(rota)) {
      const id = Number(rota.split('/')[3]);
      const { pessoas } = await corpo(req);
      const l = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(id);
      if (!l) return json(res, 404, { erro: 'lançamento não existe' });
      const c = db.prepare('SELECT * FROM comandas WHERE id=?').get(l.comanda_id);
      if (c.status !== 'aberta') return json(res, 409, { erro: 'comanda já fechada' });
      return json(res, 200, { ok: true, pessoas: aplicarDivisao(l, c, pessoas) });
    }

    /* quantas pessoas, e como se chamam — muda o rateio inteiro */
    if (m === 'POST' && /^\/api\/comandas\/\d+\/pessoas$/.test(rota)) {
      const id = Number(rota.split('/')[3]);
      const c = db.prepare(`SELECT * FROM comandas WHERE id=? AND status='aberta'`).get(id);
      if (!c) return json(res, 404, { erro: 'comanda não está aberta' });
      const b = await corpo(req);
      const n = Math.max(1, Math.min(40, Number(b.pessoas) || c.pessoas));
      const nomes = Array.isArray(b.nomes)
        ? b.nomes.slice(0, n).map(x => String(x || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 24))
        : null;
      db.prepare('UPDATE comandas SET pessoas=?, nomes=? WHERE id=?')
        .run(n, nomes ? JSON.stringify(nomes) : c.nomes, id);
      db.prepare('DELETE FROM divisao WHERE pessoa > ? AND lancamento_id IN (SELECT id FROM lancamentos WHERE comanda_id=?)')
        .run(n, id);
      const mesa = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
      emitir('mesa-pessoas', mesa.numero, { comanda_id: id, pessoas: n });
      return json(res, 200, { ok: true, pessoas: n });
    }

    /* desconto e cortesia: só gerente, e sempre com motivo escrito */
    if (m === 'POST' && /^\/api\/comandas\/\d+\/desconto$/.test(rota)) {
      if (s.papel !== 'gerente') return json(res, 403, { erro: 'só o gerente aplica desconto' });
      const id = Number(rota.split('/')[3]);
      const c = db.prepare(`SELECT * FROM comandas WHERE id=? AND status='aberta'`).get(id);
      if (!c) return json(res, 404, { erro: 'comanda não está aberta' });
      const { tipo, valor, motivo } = await corpo(req);
      const texto = String(motivo || '').trim().slice(0, 120);
      if (!texto) return json(res, 400, { erro: 'desconto sem motivo escrito não entra' });
      const t = totais(id);
      const cent = conta.desconto({ tipo, valor: Number(valor) }, t.subtotal_cent);
      db.prepare('UPDATE comandas SET desconto_cent=?, desconto_motivo=? WHERE id=?').run(cent, texto, id);
      const mesa = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
      emitir('desconto', mesa.numero, { comanda_id: id, desconto_cent: cent, motivo: texto });
      return json(res, 200, { desconto_cent: cent, ...totais(id) });
    }

    /* mesa cheia, grupo mudou de lugar: leva a comanda junto */
    if (m === 'POST' && /^\/api\/comandas\/\d+\/transferir$/.test(rota)) {
      const id = Number(rota.split('/')[3]);
      const c = db.prepare(`SELECT * FROM comandas WHERE id=? AND status='aberta'`).get(id);
      if (!c) return json(res, 404, { erro: 'comanda não está aberta' });
      const { mesa: numero } = await corpo(req);
      const destino = db.prepare('SELECT * FROM mesas WHERE numero=?').get(Number(numero));
      if (!destino) return json(res, 404, { erro: 'mesa de destino não existe' });
      if (destino.id === c.mesa_id) return json(res, 400, { erro: 'já é esta mesa' });
      if (comandaAberta(destino.id)) return json(res, 409, { erro: 'a mesa de destino já tem comanda aberta' });
      const origem = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
      db.prepare('UPDATE comandas SET mesa_id=? WHERE id=?').run(destino.id, id);
      db.prepare(`UPDATE mesas SET status='livre' WHERE id=?`).run(c.mesa_id);
      db.prepare(`UPDATE mesas SET status='ocupada' WHERE id=?`).run(destino.id);
      emitir('transferencia', destino.numero, { comanda_id: id, de: origem.numero },
        urb1.telegrama('SAL', 'TRAN', destino.numero, [origem.numero]));
      return json(res, 200, { ok: true, de: origem.numero, para: destino.numero });
    }

    /* fechou sem querer: só o gerente desfaz, e a mesa precisa estar livre */
    if (m === 'POST' && /^\/api\/comandas\/\d+\/reabrir$/.test(rota)) {
      if (s.papel !== 'gerente') return json(res, 403, { erro: 'só o gerente reabre comanda' });
      const id = Number(rota.split('/')[3]);
      const c = db.prepare(`SELECT * FROM comandas WHERE id=? AND status='fechada'`).get(id);
      if (!c) return json(res, 404, { erro: 'comanda não está fechada' });
      if (comandaAberta(c.mesa_id)) return json(res, 409, { erro: 'a mesa já tem outra comanda aberta' });
      const nf = ultimaNota(id);
      if (nf && nf.status === 'autorizado')
        return json(res, 409, { erro: 'esta comanda tem NFC-e autorizada — cancele a nota antes de reabrir' });
      /* os pagamentos do fechamento anterior saem junto: se ficassem, a noite
         contaria o mesmo dinheiro duas vezes quando a comanda fechasse de novo */
      db.prepare('DELETE FROM pagamentos WHERE comanda_id=?').run(id);
      db.prepare(`UPDATE comandas SET status='aberta', fechada_em=NULL WHERE id=?`).run(id);
      db.prepare(`UPDATE mesas SET status='ocupada' WHERE id=?`).run(c.mesa_id);
      const mesa = db.prepare('SELECT numero FROM mesas WHERE id=?').get(c.mesa_id);
      emitir('reabertura', mesa.numero, { comanda_id: id });
      return json(res, 200, { ok: true });
    }

    /* pagamentos de uma comanda já fechada, para conferência no caixa */
    if (m === 'GET' && /^\/api\/comandas\/\d+\/pagamentos$/.test(rota)) {
      const id = Number(rota.split('/')[3]);
      return json(res, 200, db.prepare(
        `SELECT forma, valor_cent, recebido_cent, troco_cent, criado_em
           FROM pagamentos WHERE comanda_id=? ORDER BY id`).all(id));
    }

    /* últimas comandas fechadas, para achar a que foi fechada por engano */
    if (m === 'GET' && rota === '/api/fechadas') {
      return json(res, 200, db.prepare(
        `SELECT c.id, c.codigo, c.fechada_em, m.numero mesa,
                (SELECT COALESCE(SUM(qtd*preco_cent),0) FROM lancamentos l
                  WHERE l.comanda_id=c.id AND ${NA_CONTA}) subtotal_cent,
                (SELECT GROUP_CONCAT(forma) FROM pagamentos p WHERE p.comanda_id=c.id) formas
           FROM comandas c JOIN mesas m ON m.id=c.mesa_id
          WHERE c.status='fechada' ORDER BY c.fechada_em DESC LIMIT 12`).all());
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
      const b = await corpo(req);
      if (b.semServico) db.prepare('UPDATE comandas SET servico_pct=0 WHERE id=?').run(id);
      const t = totais(id);

      /* Pagamento: ou vem a divisão por forma, ou o fechamento é marcado como
         não informado. O que não acontece é o dinheiro entrar sem forma e
         depois ninguém conseguir conferir a gaveta. */
      let pagamentos = Array.isArray(b.pagamentos) ? b.pagamentos : [];
      pagamentos = pagamentos
        .map(p => ({
          forma: FORMAS.includes(p.forma) ? p.forma : null,
          valor_cent: Math.round(Number(p.valor_cent) || 0),
          recebido_cent: p.recebido_cent != null ? Math.round(Number(p.recebido_cent)) : null
        }))
        .filter(p => p.forma && p.valor_cent > 0);

      if (pagamentos.length) {
        const somado = pagamentos.reduce((a, p) => a + p.valor_cent, 0);
        if (somado !== t.total_cent) {
          return json(res, 400, {
            erro: `o pagamento soma ${dinheiro(somado)} e a conta é ${dinheiro(t.total_cent)}`,
            diferenca_cent: somado - t.total_cent, total_cent: t.total_cent });
        }
        for (const p of pagamentos) {
          if (p.forma === 'dinheiro' && p.recebido_cent != null && p.recebido_cent < p.valor_cent) {
            return json(res, 400, { erro: 'o dinheiro recebido é menor que a parte em dinheiro' });
          }
        }
      } else {
        pagamentos = [{ forma: 'nao-informado', valor_cent: t.total_cent, recebido_cent: null }];
      }
      for (const p of pagamentos) {
        const troco = p.forma === 'dinheiro' && p.recebido_cent != null
          ? p.recebido_cent - p.valor_cent : null;
        db.prepare(`INSERT INTO pagamentos
          (comanda_id, forma, valor_cent, recebido_cent, troco_cent, criado_em, por)
          VALUES (?,?,?,?,?,?,?)`)
          .run(id, p.forma, p.valor_cent, p.recebido_cent ?? null, troco, agora(), s.id);
      }
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
      const troco = pagamentos.reduce((a, p) => a + (p.forma === 'dinheiro' && p.recebido_cent != null
        ? p.recebido_cent - p.valor_cent : 0), 0);

      /* a nota sai junto com o fechamento quando pedida (ou NFCE_AUTO=1). Se a
         nota falhar, o fechamento NÃO é desfeito: a conta foi paga, a mesa
         está livre, e a nota pode ser reemitida pela noite ou pela gaveta. */
      let notaFechamento = null;
      if (b.emitirNota || process.env.NFCE_AUTO === '1') {
        try { notaFechamento = await emitirNota(id, { cpf: b.cpf, por: s.id }); }
        catch (e) { notaFechamento = { http: 500, erro: e.message }; }
      }
      return json(res, 200, { total_cent: t.total_cent, subtotal_cent: t.subtotal_cent,
        servico_cent: t.servico_cent, desconto_cent: t.desconto_cent, nomes: t.nomes,
        pagamentos, troco_cent: troco,
        nota: notaFechamento ? (notaFechamento.nota ? NOTA_PUBLICA(notaFechamento.nota) : { status: 'erro', mensagem: notaFechamento.erro })
          : null, avisos_nota: notaFechamento?.avisos || [],
        porPessoa_cent: t.porPessoa_cent, pix: brcode,
        aviso_pix: brcode ? 'Copia-e-cola gerado. Confirme o recebimento no app do banco antes de liberar a mesa.'
          : 'PIX_CHAVE não configurada — nenhum código Pix foi gerado.' });
    }

    /* ---------- NFC-e ---------- */
    if (m === 'POST' && /^\/api\/comandas\/\d+\/nfce$/.test(rota)) {
      const id = Number(rota.split('/')[3]);
      const { cpf } = await corpo(req);
      const r = await emitirNota(id, { cpf, por: s.id });
      if (r.erro) return json(res, r.http, { erro: r.erro, naoRevisados: r.naoRevisados });
      return json(res, 200, { nota: NOTA_PUBLICA(r.nota), avisos: r.avisos || [], jaExistia: Boolean(r.jaExistia) });
    }
    if (m === 'GET' && /^\/api\/comandas\/\d+\/nfce$/.test(rota)) {
      const id = Number(rota.split('/')[3]);
      let n = ultimaNota(id);
      if (n && n.status === 'pendente') n = gravarResultado(n, await fiscal.consultar(n.ref));
      return json(res, 200, { nota: NOTA_PUBLICA(n) });
    }
    if (m === 'POST' && /^\/api\/nfce\/[\w-]+\/cancelar$/.test(rota)) {
      if (s.papel !== 'gerente') return json(res, 403, { erro: 'só o gerente cancela nota fiscal' });
      const ref = rota.split('/')[3];
      const n = db.prepare('SELECT * FROM notas WHERE ref=?').get(ref);
      if (!n) return json(res, 404, { erro: 'nota não existe' });
      if (n.status !== 'autorizado') return json(res, 409, { erro: `nota ${n.status} não se cancela` });
      const { justificativa } = await corpo(req);
      const minutos = (Date.now() - Date.parse(n.autorizada_em || n.criado_em)) / 60000;
      if (minutos > 30) return json(res, 409, { erro: `passaram ${Math.floor(minutos)} min — a NFC-e só se cancela em até 30 min da emissão` });
      const r = await fiscal.cancelar(ref, justificativa);
      if (r.status !== 'cancelado') return json(res, 422, { erro: r.mensagem });
      db.prepare(`UPDATE notas SET status='cancelado', cancelada_em=?, justificativa=?, mensagem=?, atualizado_em=? WHERE id=?`)
        .run(agora(), String(justificativa).trim(), r.mensagem, agora(), n.id);
      emitir('nfce-cancelado', null, { ref });
      return json(res, 200, { nota: NOTA_PUBLICA(db.prepare('SELECT * FROM notas WHERE id=?').get(n.id)) });
    }
    if (m === 'GET' && rota === '/api/notas') {
      const desde = new URL(req.url, 'http://x').searchParams.get('desde') ||
        new Date(Date.now() - 36 * 3600000).toISOString();
      return json(res, 200, db.prepare(
        `SELECT n.*, m.numero mesa, c.codigo FROM notas n JOIN comandas c ON c.id=n.comanda_id
           JOIN mesas m ON m.id=c.mesa_id WHERE n.criado_em >= ? ORDER BY n.id DESC LIMIT 200`)
        .all(desde).map(n => ({ ...NOTA_PUBLICA(n), mesa: n.mesa, comanda_id: n.comanda_id, codigo: n.codigo })));
    }

    /* ---------- cadastro fiscal do cardápio (gerente) ---------- */
    if (m === 'GET' && rota === '/api/cardapio/fiscal') {
      if (s.papel !== 'gerente') return json(res, 403, { erro: 'só o gerente vê o cadastro fiscal' });
      return json(res, 200, db.prepare('SELECT * FROM cardapio WHERE ativo=1 ORDER BY categoria, nome').all()
        .map(i => { const f = fiscal.fiscalDo(i); return { id: i.id, nome: i.nome, categoria: i.categoria,
          ncm: f.ncm, cfop: f.cfop, csosn: f.csosn, origem: f.origem, unidade: f.unidade,
          revisado: f.revisado, exemplo: f.exemplo, extra: f.extra }; }));
    }
    if (m === 'PUT' && /^\/api\/cardapio\/\d+\/fiscal$/.test(rota)) {
      if (s.papel !== 'gerente') return json(res, 403, { erro: 'só o gerente edita o cadastro fiscal' });
      const id = Number(rota.split('/')[3]);
      if (!db.prepare('SELECT id FROM cardapio WHERE id=?').get(id)) return json(res, 404, { erro: 'item fora do cardápio' });
      const b = await corpo(req);
      const f = { ncm: String(b.ncm || '').replace(/\D/g, ''), cfop: String(b.cfop || '').replace(/\D/g, ''),
        csosn: String(b.csosn || '').replace(/\D/g, ''), origem: String(b.origem ?? '0').replace(/\D/g, ''),
        unidade: String(b.unidade || 'UN').trim().toUpperCase().slice(0, 6) };
      const erros = fiscal.validarFiscal(f);
      if (erros.length) return json(res, 400, { erro: erros.join('; ') });
      let extra = null;
      if (b.extra && typeof b.extra === 'object' && Object.keys(b.extra).length) extra = JSON.stringify(b.extra);
      db.prepare(`UPDATE cardapio SET ncm=?, cfop=?, csosn=?, origem=?, unidade=?, fiscal_revisado=?, fiscal_extra=? WHERE id=?`)
        .run(f.ncm, f.cfop, f.csosn, f.origem, f.unidade, b.revisado ? 1 : 0, extra, id);
      persistencia.marcar(db);
      return json(res, 200, { ok: true });
    }

    /* ---------- estado do sistema, com teste de verdade (gerente) ---------- */
    if (m === 'GET' && rota === '/api/sistema') {
      if (s.papel !== 'gerente') return json(res, 403, { erro: 'só o gerente vê o sistema' });
      const p = persistencia.estado();
      const naoRev = db.prepare('SELECT COUNT(*) n FROM cardapio WHERE ativo=1 AND fiscal_revisado=0').get().n;
      return json(res, 200, {
        ia: { ligada: assistente.ligado(), modelo: assistente.MODELO,
          tetos: { mesa: assistente.TETO_MESA, hora: assistente.TETO_HORA } },
        fiscal: { modo: fiscal.modo(), ambiente: fiscal.CONF.ambiente,
          cnpj: fiscal.CONF.cnpj ? fiscal.CONF.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : null,
          itensNaoRevisados: naoRev, auto: process.env.NFCE_AUTO === '1' },
        dados: { modo: p.modo, ultimoRetrato: p.ultimo, erro: p.erro },
        sessao: { segredoFixo: SEGREDO_FIXO },
        pix: { chave: Boolean(CASA.pixChave) }
      });
    }
    if (m === 'POST' && rota === '/api/sistema/testar-ia') {
      if (s.papel !== 'gerente') return json(res, 403, { erro: 'só o gerente testa o sistema' });
      if (!assistente.ligado()) return json(res, 200, { ok: false, mensagem: 'ANTHROPIC_API_KEY não configurada' });
      const t0 = Date.now();
      try {
        const txt = await assistente.chamar({ sistema: 'Responda só com a palavra: funcionando',
          mensagens: [{ role: 'user', content: 'teste' }], maxTokens: 10 });
        return json(res, 200, { ok: true, mensagem: `a API respondeu "${txt.slice(0, 40)}" em ${Date.now() - t0} ms`, modelo: assistente.MODELO });
      } catch (e) { return json(res, 200, { ok: false, mensagem: e.message }); }
    }
    if (m === 'POST' && rota === '/api/sistema/testar-fiscal') {
      if (s.papel !== 'gerente') return json(res, 403, { erro: 'só o gerente testa o sistema' });
      return json(res, 200, await fiscal.testar());
    }

    /* ---------- aferição de prato pela câmera ---------- */
    if (m === 'GET' && rota === '/api/padroes') {
      return json(res, 200, db.prepare(
        `SELECT p.item_id, p.n, p.mu, p.sigma, p.atualizado_em, c.nome
           FROM padroes p JOIN cardapio c ON c.id = p.item_id`).all()
        .map(p => ({ ...p, mu: JSON.parse(p.mu), sigma: JSON.parse(p.sigma) })));
    }

    if (m === 'POST' && rota === '/api/padroes') {
      const { item_id, amostras, versao: vPadrao } = await corpo(req);
      /* a versão vem do núcleo que mediu, sem lista fixa aqui: antes estava
         escrito "=== 2 ? 2 : 1", e a v3 gravava como v1 — os padrões novos
         nunca seriam comparados com as medições novas */
      const versaoPadrao = Math.min(99, Math.max(1, Math.round(Number(vPadrao) || 1)));
      const it = db.prepare('SELECT * FROM cardapio WHERE id=?').get(Number(item_id));
      if (!it) return json(res, 404, { erro: 'item fora do cardápio' });
      if (!Array.isArray(amostras) || amostras.length < 3)
        return json(res, 400, { erro: 'precisa de pelo menos 3 fotos do prato aprovado' });
      const env = envelope(amostras);
      db.prepare(`INSERT INTO padroes (item_id, n, mu, sigma, atualizado_em, versao)
        VALUES (?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET
        n=excluded.n, mu=excluded.mu, sigma=excluded.sigma, atualizado_em=excluded.atualizado_em,
        versao=excluded.versao`)
        .run(it.id, amostras.length, JSON.stringify(env.mu), JSON.stringify(env.sigma), agora(), versaoPadrao);
      emitir('padrao-gravado', null, { item: it.nome, n: amostras.length });

      /* Pratos gêmeos: se a foto típica deste prato cai dentro do envelope de
         outro (ou o contrário), a geometria não vai separar os dois. Melhor
         saber agora, no cadastro, do que descobrir na conta de um cliente. */
      const gemeos = db.prepare(
        `SELECT p.item_id, p.mu, p.sigma, c.nome FROM padroes p JOIN cardapio c ON c.id=p.item_id
          WHERE p.item_id <> ? AND p.versao = ?`).all(it.id, versaoPadrao).map(o => {
          const outro = { mu: JSON.parse(o.mu), sigma: JSON.parse(o.sigma) };
          const dm = Math.min(afastamento(env.mu, outro).dm, afastamento(outro.mu, env).dm);
          return { item: o.nome, dm: Number(dm.toFixed(2)),
            nivel: dm < LIM_OK ? 'indistinguivel' : dm < LIM_REJ ? 'proximo' : null };
        }).filter(g => g.nivel).sort((a, b) => a.dm - b.dm);
      return json(res, 200, { item: it.nome, n: amostras.length, versao: versaoPadrao, mu: env.mu, sigma: env.sigma, gemeos });
    }

    if (m === 'POST' && rota === '/api/reconhecer') {
      const { grandezas, mesa, foto, versao, inflar, pesos } = await corpo(req);
      if (!grandezas || typeof grandezas !== 'object')
        return json(res, 400, { erro: 'sem vetor de grandezas' });
      const padroes = db.prepare(
        `SELECT p.item_id, p.n, p.mu, p.sigma, p.versao, c.nome, c.preco_cent, c.estacao
           FROM padroes p JOIN cardapio c ON c.id=p.item_id WHERE c.ativo=1`).all()
        .map(p => ({ ...p, mu: JSON.parse(p.mu), sigma: JSON.parse(p.sigma) }));
      let r = identificar(grandezas, padroes, { versao, inflar, pesos });

      /* Camada 2: a geometria empatou, e há foto e chave. Só aqui se gasta
         chamada de API — quando a medição sozinha não resolveu. O modelo
         escolhe entre os candidatos que a geometria deixou de pé, ou diz que
         não sabe; ele não pode trazer item de fora da lista. */
      if (r.camada === 1 && foto && assistente.ligado() && r.candidatos?.length) {
        const olhada = await assistente.olharPrato({ foto, candidatos: r.candidatos });
        if (olhada.item_id) {
          const escolhido = padroes.find(p => p.item_id === olhada.item_id);
          r = { ...r, camada: 2, item_id: olhada.item_id, nome: escolhido?.nome,
            preco_cent: escolhido?.preco_cent, estacao: escolhido?.estacao,
            certeza: olhada.certeza,
            veredito: `o modelo de visão escolheu ${escolhido?.nome} entre os candidatos ` +
              `(certeza ${olhada.certeza}, não medida)${olhada.porque ? ` — ${olhada.porque}` : ''}` };
        } else {
          r = { ...r, olhada: olhada.erro || olhada.porque || 'o modelo também não soube',
            veredito: `${r.veredito}. O modelo de visão olhou e também não decidiu.` };
        }
      } else if (r.camada === 1 && foto && !assistente.ligado()) {
        r = { ...r, veredito: `${r.veredito} (camada 2 desligada: sem chave da API)` };
      }

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

    /* ---------- a noite ---------- */
    /* A "noite" de um bar não é o dia do calendário: ela começa à tarde e
       termina de madrugada. NOITE_INICIO (hora local) marca a virada. */

    if (m === 'GET' && rota === '/api/noite') {
      const inicio = inicioDaNoite();
      const desde = inicio.toISOString();

      const itens = db.prepare(
        `SELECT l.qtd, l.preco_cent, l.nome, l.criado_em, c.id comanda_id, c.status, c.pessoas,
                c.servico_pct, c.desconto_cent
           FROM lancamentos l JOIN comandas c ON c.id = l.comanda_id
          WHERE l.criado_em >= ? AND ${NA_CONTA}`).all(desde);

      const subtotal = itens.reduce((a, i) => a + i.qtd * i.preco_cent, 0);

      /* serviço e desconto saem por comanda, não por item: refaço a conta de
         cada uma e somo, para o total bater com o que o cliente pagou */
      const idsComanda = [...new Set(itens.map(i => i.comanda_id))];
      let servico = 0, desconto = 0, total = 0;
      for (const id of idsComanda) {
        const t = totais(id);
        servico += t.servico_cent; desconto += t.desconto_cent; total += t.total_cent;
      }

      const fechadas = db.prepare(
        `SELECT COUNT(*) n, COALESCE(SUM(pessoas),0) p FROM comandas
          WHERE status='fechada' AND fechada_em >= ?`).get(desde);
      const cobertas = db.prepare(
        `SELECT COALESCE(SUM(pessoas),0) p FROM comandas WHERE aberta_em >= ?`).get(desde).p;

      /* receita por hora, pela hora local de cada lançamento */
      const porHoraMapa = new Map();
      for (const i of itens) {
        const hora = horaLocal(i.criado_em);
        porHoraMapa.set(hora, (porHoraMapa.get(hora) || 0) + i.qtd * i.preco_cent);
      }
      const porHora = [...porHoraMapa.entries()]
        .map(([hora, total_cent]) => ({ hora, total_cent }))
        .sort((a, b) => (a.hora < horaLocal(inicio.toISOString()) ? a.hora + 24 : a.hora) -
          (b.hora < horaLocal(inicio.toISOString()) ? b.hora + 24 : b.hora));

      const topMapa = new Map();
      for (const i of itens) {
        const atual = topMapa.get(i.nome) || { nome: i.nome, qtd: 0, total_cent: 0 };
        atual.qtd += i.qtd; atual.total_cent += i.qtd * i.preco_cent;
        topMapa.set(i.nome, atual);
      }
      const topItens = [...topMapa.values()].sort((a, b) => b.total_cent - a.total_cent).slice(0, 8);

      /* ── caixa: o que entrou, por forma ──
         Só conta pagamento de comanda fechada dentro desta virada. O que está
         em mesa aberta ainda não é caixa: é promessa. */
      const pagos = db.prepare(
        `SELECT p.forma, COUNT(*) n, COALESCE(SUM(p.valor_cent),0) v,
                COALESCE(SUM(p.troco_cent),0) troco
           FROM pagamentos p JOIN comandas c ON c.id = p.comanda_id
          WHERE c.status='fechada' AND c.fechada_em >= ?
          GROUP BY p.forma ORDER BY v DESC`).all(desde);

      const recebido = pagos.reduce((a, f) => a + f.v, 0);
      const porForma = pagos.map(f => ({
        forma: f.forma, n: f.n, total_cent: f.v, troco_cent: f.troco,
        fatia: recebido ? Math.round(f.v / recebido * 1000) / 10 : 0
      }));
      const acha = f => porForma.find(x => x.forma === f)?.total_cent || 0;

      /* noite anterior, para comparar: mesma janela, um dia atrás */
      const ontemFim = new Date(inicio);
      const ontemIni = new Date(inicio); ontemIni.setDate(ontemIni.getDate() - 1);
      const ontem = db.prepare(
        `SELECT COALESCE(SUM(p.valor_cent),0) v, COUNT(DISTINCT c.id) n
           FROM pagamentos p JOIN comandas c ON c.id = p.comanda_id
          WHERE c.status='fechada' AND c.fechada_em >= ? AND c.fechada_em < ?`)
        .get(ontemIni.toISOString(), ontemFim.toISOString());

      /* estornos da noite, com autor — é o número que o dono mais precisa ver */
      const estornos = db.prepare(
        `SELECT l.nome, l.qtd, l.preco_cent, l.estornado_em, m.numero mesa,
                COALESCE(f.nome, '?') por
           FROM lancamentos l JOIN comandas c ON c.id=l.comanda_id
           JOIN mesas m ON m.id=c.mesa_id
           LEFT JOIN funcionarios f ON f.id=l.estornado_por
          WHERE l.estornado_em >= ? ORDER BY l.estornado_em DESC`).all(desde);

      const s2 = salao();
      return json(res, 200, {
        estornos: { n: estornos.length,
          total_cent: estornos.reduce((a, e) => a + e.qtd * e.preco_cent, 0),
          lista: estornos.slice(0, 20) },
        inicio: desde, subtotal_cent: subtotal, servico_cent: servico,
        desconto_cent: desconto, total_cent: total,
        comandas: fechadas.n, cobertas, lancamentos: itens.length,
        /* ticket = o que entrou ÷ as comandas que fecharam. Antes dividia o
           total de TODAS as comandas tocadas (abertas inclusive) pelo número
           delas, e mostrava ao lado o número só das fechadas. */
        ticket_cent: fechadas.n ? Math.round(recebido / fechadas.n) : 0,
        porHora, topItens, porForma,
        caixa: {
          recebido_cent: recebido,
          dinheiro_cent: acha('dinheiro'),
          eletronico_cent: acha('pix') + acha('credito') + acha('debito') + acha('voucher'),
          naoInformado_cent: acha('nao-informado'),
          troco_cent: porForma.reduce((a, f) => a + (f.troco_cent || 0), 0),
          fundo_cent: Math.round(Number(process.env.FUNDO_TROCO || 0) * 100),
          /* o que a gaveta deve ter agora: fundo de troco + o que entrou em espécie */
          gaveta_cent: Math.round(Number(process.env.FUNDO_TROCO || 0) * 100) + acha('dinheiro')
        },
        ontem: { total_cent: ontem.v, comandas: ontem.n },
        agora: { abertas: s2.resumo.abertas, emAberto_cent: s2.resumo.emAberto_cent,
          chamadas: s2.resumo.chamadas, pessoas: s2.resumo.pessoas }
      });
    }

    /* ---------- assistente da equipe ---------- */
    if (m === 'POST' && rota === '/api/assistente') {
      if (!assistente.ligado()) return json(res, 503, { erro: 'assistente desligado nesta casa' });
      const { mensagem, historico } = await corpo(req);
      const s2 = salao();
      const passe = db.prepare(
        `SELECT l.nome, l.qtd, l.estacao, l.estado, l.observacao, l.criado_em, m.numero mesa
           FROM lancamentos l JOIN comandas c ON c.id=l.comanda_id JOIN mesas m ON m.id=c.mesa_id
          WHERE c.status='aberta' AND l.estado IN ('pendente','preparo','pronto')
            AND l.estornado_em IS NULL
          ORDER BY l.id`).all();
      const inicio = inicioDaNoite().toISOString();
      const fechadas = db.prepare(
        `SELECT COUNT(*) n, COALESCE(SUM(pessoas),0) p FROM comandas
          WHERE status='fechada' AND fechada_em >= ?`).get(inicio);
      const faturado = db.prepare(
        `SELECT COALESCE(SUM(l.qtd*l.preco_cent),0) v FROM lancamentos l
           JOIN comandas c ON c.id=l.comanda_id
          WHERE c.status='fechada' AND c.fechada_em >= ? AND ${NA_CONTA}`).get(inicio).v;

      const r = await assistente.assistirEquipe({
        quem: `${s.nome} (${s.papel})`, mensagem,
        historico: Array.isArray(historico) ? historico : [],
        estado: { resumo: s2.resumo, mesas: s2.mesas, passe,
          noite: { comandas: fechadas.n, cobertas: fechadas.p, total_cent: faturado } }
      });
      if (r.erro) return json(res, 503, r);
      return json(res, 200, r);
    }

    /* ---------- fotos do cardápio (gerente) ---------- */
    if ((m === 'PUT' || m === 'DELETE') && /^\/api\/cardapio\/\d+\/foto$/.test(rota)) {
      if (s.papel !== 'gerente') return json(res, 403, { erro: 'só o gerente troca foto do cardápio' });
      const id = Number(rota.split('/')[3]);
      const it = db.prepare('SELECT id, nome FROM cardapio WHERE id=?').get(id);
      if (!it) return json(res, 404, { erro: 'item fora do cardápio' });
      const alvo = path.join(PASTA_FOTOS, `${id}.jpg`);

      if (m === 'DELETE') {
        fs.rmSync(alvo, { force: true });
        db.prepare('UPDATE cardapio SET foto_versao=NULL WHERE id=?').run(id);
        const nuvem = await persistencia.apagarFoto(id);
        emitir('cardapio', null, { item: it.nome });
        return json(res, 200, { ok: true, nuvem });
      }

      const { imagem } = await corpo(req);
      const mt = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(imagem || ''));
      if (!mt) return json(res, 400, { erro: 'mande a foto como JPEG (data:image/jpeg;base64,…)' });
      const buf = Buffer.from(mt[1], 'base64');
      /* confere a assinatura do arquivo, não só o rótulo que veio escrito */
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff)
        return json(res, 400, { erro: 'o conteúdo não é um JPEG' });
      if (buf.length > FOTO_MAX)
        return json(res, 413, { erro: `foto grande demais (${Math.round(buf.length / 1024)} KB; o limite é ${FOTO_MAX / 1024} KB)` });

      fs.mkdirSync(PASTA_FOTOS, { recursive: true });
      const tmp = `${alvo}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, alvo);                       // troca atômica: ninguém lê meia foto
      const versao = Date.now();
      db.prepare('UPDATE cardapio SET foto_versao=? WHERE id=?').run(versao, id);
      persistencia.marcar(db);
      const nuvem = await persistencia.gravarFoto(id, buf);
      emitir('cardapio', null, { item: it.nome });
      return json(res, 200, { ok: true, foto: `/foto/${id}.jpg?v=${versao}`, bytes: buf.length,
        nuvem, aviso: nuvem || persistencia.estado().modo !== 'github' ? null
          : 'a foto ficou no servidor, mas não subiu para o repositório — some no próximo restart' });
    }

    /* ---------- quanto o reconhecimento acerta, medido no uso ----------
       O par já estava no banco: cada medição guarda o prato que o sistema
       previu, e o lançamento feito pela câmera aponta para ela com o prato que
       o garçom de fato lançou. Isto só junta os dois. */
    if (m === 'GET' && rota === '/api/afericao/relatorio') {
      if (s.papel !== 'gerente') return json(res, 403, { erro: 'só o gerente vê o relatório' });
      const linhas = db.prepare(
        `SELECT m.camada, m.item_id previsto, l.item_id lancado, l.estornado_em,
                cp.nome nome_previsto, cl.nome nome_lancado
           FROM lancamentos l JOIN medicoes m ON m.id = l.medicao_id
           LEFT JOIN cardapio cp ON cp.id = m.item_id LEFT JOIN cardapio cl ON cl.id = l.item_id
          WHERE l.origem = 'camera'`).all();
      const camada = k => {
        const d = linhas.filter(x => x.camada === k);
        const certos = d.filter(x => x.previsto != null && x.previsto === x.lancado && !x.estornado_em).length;
        return { n: d.length, acertos: certos, taxa: d.length ? Number((certos / d.length).toFixed(3)) : null };
      };
      const conf = new Map();
      for (const x of linhas) {
        if (x.previsto == null || x.previsto === x.lancado) continue;
        const chave = `${x.nome_previsto} → ${x.nome_lancado}`;
        conf.set(chave, (conf.get(chave) || 0) + 1);
      }
      return json(res, 200, {
        confirmadas: linhas.length,
        geometria: camada(0), modeloVisao: camada(2),
        decididasNaMao: linhas.filter(x => x.camada === 1).length,
        estornadasDepois: linhas.filter(x => x.estornado_em).length,
        medicoesSemLancamento: db.prepare(
          `SELECT COUNT(*) n FROM medicoes m WHERE NOT EXISTS (SELECT 1 FROM lancamentos l WHERE l.medicao_id = m.id)`).get().n,
        confusoes: [...conf.entries()].map(([par, n]) => ({ par, n })).sort((a, b) => b.n - a.n).slice(0, 10),
        limiares: { LIM_OK, LIM_REJ, SEP_MIN },
        padroesPorVersao: Object.fromEntries(db.prepare(
          'SELECT versao, COUNT(*) n FROM padroes GROUP BY versao').all().map(x => [`v${x.versao}`, x.n])),
        suficiente: linhas.length >= 30
      });
    }

    /* ---------- passe / KDS ---------- */
    if (m === 'GET' && rota === '/api/passe') {
      const linhas = db.prepare(
        `SELECT l.id, l.nome, l.qtd, l.estacao, l.estado, l.observacao, l.criado_em,
                l.pronto_em, m.numero mesa, c.id comanda_id
           FROM lancamentos l JOIN comandas c ON c.id=l.comanda_id JOIN mesas m ON m.id=c.mesa_id
          WHERE c.status='aberta' AND l.estado IN ('pendente','preparo','pronto')
            AND l.estornado_em IS NULL
          ORDER BY l.id`).all();
      return json(res, 200, { linhas, agora: agora() });
    }

    return json(res, 404, { erro: 'rota não existe' });
  } catch (e) {
    return json(res, e.message === 'json inválido' ? 400 : 500, { erro: e.message });
  }
});

if (require.main === module) {
  preparar().then(() => servidor.listen(PORTA, () => {
    console.log(`BURGUER · Salão em http://localhost:${PORTA}`);
    console.log(`banco: ${ARQUIVO}`);
    if (!CASA.pixChave) console.log('PIX_CHAVE ausente — fechamento não gera copia-e-cola.');
    if (!SEGREDO_FIXO) console.log('SESSAO_SEGREDO ausente — cada restart desloga a equipe.');
  }));
}

module.exports = { servidor, preparar, totais, salao, emitir, CASA, banco: () => db,
  inicioDaNoite, horaLocal };
