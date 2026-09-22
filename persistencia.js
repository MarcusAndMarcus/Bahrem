'use strict';
/* O plano free do Render não aceita disco persistente: o arquivo do banco vive
   num sistema de arquivos efêmero e some a cada deploy, restart ou hibernação.
   Este módulo guarda um retrato comprimido do banco num repositório privado do
   GitHub e o traz de volta no arranque.

   Por que GitHub e não Postgres: o Postgres free do Render expira 30 dias
   depois de criado e exigiria um driver npm — o projeto inteiro é sem
   dependência. Aqui só se usa fetch, node:zlib e node:crypto, todos embutidos.

   Por que gzip: o retrato vira um commit por vez. Um banco de ~200 KB comprime
   para ~50 KB, e a um retrato a cada 10 min o repositório cresce alguns MB por
   mês em vez de centenas. Quando incomodar, apague e recrie o repositório — só
   o retrato mais recente importa.

   O que este módulo NÃO garante: se o processo morrer de forma abrupta
   (SIGKILL, queda da plataforma), perde-se o que entrou desde o último retrato.
   Em desligamento normal — que é o caso do deploy e da hibernação do Render —
   o retrato é gravado antes de sair. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const CONF = {
  repo: process.env.SNAP_REPO || '',            // "usuario/repositorio" PRIVADO
  token: process.env.SNAP_TOKEN || '',          // PAT com contents: read/write
  arquivo: process.env.SNAP_ARQUIVO || 'salao.db.gz',
  ramo: process.env.SNAP_BRANCH || 'main',
  api: process.env.SNAP_API || 'https://api.github.com',
  intervalo: Number(process.env.SNAP_INTERVALO || 600) * 1000,
  espera: Number(process.env.SNAP_DEBOUNCE || 120) * 1000
};

const estado = {
  modo: CONF.repo && CONF.token ? 'github' : 'volatil',
  repo: CONF.repo || null,
  ultimo: null, erro: null, retratos: 0, bytes: null
};

let sha = null, sujo = false, enviando = false, relogio = null, atraso = null;

const cabecalho = () => ({
  authorization: `Bearer ${CONF.token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'burguer-salao'
});

const alvo = () =>
  `${CONF.api}/repos/${CONF.repo}/contents/${encodeURIComponent(CONF.arquivo)}`;

/** traz o último retrato para `destino`. Devolve true se restaurou algo. */
async function restaurar(destino) {
  if (estado.modo !== 'github') return false;
  try {
    const r = await fetch(`${alvo()}?ref=${encodeURIComponent(CONF.ramo)}`, { headers: cabecalho() });
    if (r.status === 404) { estado.erro = null; return false; }      // primeira subida
    if (!r.ok) throw new Error(`GitHub respondeu ${r.status} ao buscar o retrato`);
    const meta = await r.json();
    sha = meta.sha;
    let bruto;
    if (meta.content) {
      bruto = Buffer.from(meta.content, 'base64');
    } else if (meta.download_url) {                                   // arquivo grande
      const d = await fetch(meta.download_url, { headers: cabecalho() });
      if (!d.ok) throw new Error(`GitHub respondeu ${d.status} ao baixar o retrato`);
      bruto = Buffer.from(await d.arrayBuffer());
    } else throw new Error('retrato sem conteúdo e sem link de download');

    const db = CONF.arquivo.endsWith('.gz') ? zlib.gunzipSync(bruto) : bruto;
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, db);
    for (const sufixo of ['-wal', '-shm']) fs.rmSync(destino + sufixo, { force: true });
    estado.ultimo = new Date().toISOString();
    estado.bytes = db.length;
    estado.erro = null;
    return true;
  } catch (e) {
    estado.erro = e.message;
    return false;                                                     // segue com banco novo
  }
}

/** VACUUM INTO dá um retrato consistente mesmo com o WAL ativo */
function retrato(db) {
  const tmp = path.join(os.tmpdir(), `salao-retrato-${process.pid}-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const bruto = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return CONF.arquivo.endsWith('.gz') ? zlib.gzipSync(bruto, { level: 9 }) : bruto;
}

async function enviar(db, motivo = 'periodico') {
  if (estado.modo !== 'github' || enviando) return false;
  enviando = true;
  try {
    const corpo = retrato(db);
    const manda = () => fetch(alvo(), {
      method: 'PUT', headers: { ...cabecalho(), 'content-type': 'application/json' },
      body: JSON.stringify({
        message: `retrato ${motivo} ${new Date().toISOString()}`,
        content: corpo.toString('base64'), branch: CONF.ramo, ...(sha ? { sha } : {})
      })
    });
    let r = await manda();
    if (r.status === 409 || r.status === 422) {       // sha velho: releia e repita uma vez
      const m = await fetch(`${alvo()}?ref=${encodeURIComponent(CONF.ramo)}`, { headers: cabecalho() });
      if (m.ok) { sha = (await m.json()).sha; r = await manda(); }
    }
    if (!r.ok) throw new Error(`GitHub respondeu ${r.status} ao gravar o retrato`);
    const resposta = await r.json().catch(() => ({}));
    sha = resposta?.content?.sha || sha;
    estado.ultimo = new Date().toISOString();
    estado.bytes = corpo.length;
    estado.retratos++;
    estado.erro = null;
    sujo = false;
    return true;
  } catch (e) {
    estado.erro = e.message;
    return false;
  } finally { enviando = false; }
}

/** chamado a cada mudança de estado do salão; agenda o envio com folga */
function marcar(db) {
  if (estado.modo !== 'github') return;
  sujo = true;
  if (atraso) return;
  atraso = setTimeout(() => { atraso = null; enviar(db, 'mudanca'); }, CONF.espera);
  if (atraso.unref) atraso.unref();
}

function iniciar(db) {
  if (estado.modo !== 'github') {
    console.log('SNAP_REPO/SNAP_TOKEN ausentes — os dados somem no próximo restart.');
    return estado;
  }
  relogio = setInterval(() => { if (sujo) enviar(db, 'periodico'); }, CONF.intervalo);
  if (relogio.unref) relogio.unref();

  /* o desligamento do Render é gracioso: é aqui que quase nada se perde */
  let saindo = false;
  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.on(sinal, async () => {
      if (saindo) return;
      saindo = true;
      clearInterval(relogio); if (atraso) clearTimeout(atraso);
      if (sujo) await enviar(db, 'desligamento');
      process.exit(0);
    });
  }
  console.log(`retratos em ${CONF.repo}/${CONF.arquivo} a cada ${CONF.intervalo / 1000}s`);
  return estado;
}

/* ─────────── fotos do cardápio ───────────
   As fotos NÃO entram no retrato do banco. JPEG já vem comprimido — gzip não
   reduz nada —, e 18 fotos de ~60 KB viajariam de novo a cada retrato de 10
   minutos: ~1 MB × 54 retratos por noite. Em vez disso, cada foto é um
   arquivo próprio no repositório de dados (fotos/12.jpg), gravado uma vez
   quando muda e baixado uma vez quando o serviço sobe. */
const PASTA_FOTOS = 'fotos';
const alvoFoto = id => `${CONF.api}/repos/${CONF.repo}/contents/${PASTA_FOTOS}/${Number(id)}.jpg`;

async function shaDe(url) {
  const r = await fetch(`${url}?ref=${encodeURIComponent(CONF.ramo)}`, { headers: cabecalho() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub respondeu ${r.status}`);
  return (await r.json()).sha || null;
}

async function gravarFoto(id, buf) {
  if (estado.modo !== 'github') return false;
  try {
    const url = alvoFoto(id);
    const sha = await shaDe(url);
    const r = await fetch(url, {
      method: 'PUT', headers: { ...cabecalho(), 'content-type': 'application/json' },
      body: JSON.stringify({ message: `foto do item ${id}`, content: Buffer.from(buf).toString('base64'),
        branch: CONF.ramo, ...(sha ? { sha } : {}) })
    });
    if (!r.ok) throw new Error(`GitHub respondeu ${r.status} ao gravar a foto`);
    return true;
  } catch (e) { estado.erro = e.message; return false; }
}

async function apagarFoto(id) {
  if (estado.modo !== 'github') return false;
  try {
    const url = alvoFoto(id);
    const sha = await shaDe(url);
    if (!sha) return true;
    const r = await fetch(url, {
      method: 'DELETE', headers: { ...cabecalho(), 'content-type': 'application/json' },
      body: JSON.stringify({ message: `tira a foto do item ${id}`, sha, branch: CONF.ramo })
    });
    if (!r.ok) throw new Error(`GitHub respondeu ${r.status} ao apagar a foto`);
    return true;
  } catch (e) { estado.erro = e.message; return false; }
}

/** baixa todas as fotos do repositório para `pasta`; devolve quantas vieram */
async function restaurarFotos(pasta) {
  if (estado.modo !== 'github') return 0;
  try {
    const r = await fetch(`${CONF.api}/repos/${CONF.repo}/contents/${PASTA_FOTOS}?ref=${encodeURIComponent(CONF.ramo)}`,
      { headers: cabecalho() });
    if (r.status === 404) return 0;                                   // ainda não há fotos
    if (!r.ok) throw new Error(`GitHub respondeu ${r.status} ao listar as fotos`);
    const lista = (await r.json()).filter(x => /^\d+\.jpg$/.test(x.name));
    fs.mkdirSync(pasta, { recursive: true });
    let n = 0;
    for (const item of lista) {
      const d = await fetch(`${alvoFoto(item.name.slice(0, -4))}?ref=${encodeURIComponent(CONF.ramo)}`,
        { headers: cabecalho() });
      if (!d.ok) continue;
      const meta = await d.json();
      let buf = meta.content ? Buffer.from(meta.content, 'base64') : null;
      if (!buf && meta.download_url) {
        const cru = await fetch(meta.download_url, { headers: cabecalho() });
        if (cru.ok) buf = Buffer.from(await cru.arrayBuffer());
      }
      if (!buf) continue;
      fs.writeFileSync(path.join(pasta, item.name), buf);
      n++;
    }
    return n;
  } catch (e) { estado.erro = e.message; return 0; }
}

const parar = () => { if (relogio) clearInterval(relogio); if (atraso) clearTimeout(atraso); };

module.exports = { CONF, estado: () => ({ ...estado, pendente: sujo }), restaurar, enviar, marcar, iniciar, parar,
  retrato, gravarFoto, apagarFoto, restaurarFotos };
