'use strict';
/* Persistência em node:sqlite (embutido no Node 22+). Zero dependência npm.
   Dinheiro é sempre inteiro em centavos — nenhuma conta passa por float. */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const ARQUIVO = process.env.DB_PATH || path.join(__dirname, 'dados', 'salao.db');

function abrir(arquivo = ARQUIVO) {
  require('node:fs').mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  esquema(db);
  migrar(db);
  return db;
}

function esquema(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS funcionarios (
    id INTEGER PRIMARY KEY, nome TEXT NOT NULL, papel TEXT NOT NULL DEFAULT 'garcom',
    pin_hash TEXT NOT NULL, sal TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1);

  CREATE TABLE IF NOT EXISTS mesas (
    id INTEGER PRIMARY KEY, numero INTEGER NOT NULL UNIQUE, lugares INTEGER NOT NULL DEFAULT 4,
    area TEXT NOT NULL DEFAULT 'salao', status TEXT NOT NULL DEFAULT 'livre');

  CREATE TABLE IF NOT EXISTS cardapio (
    id INTEGER PRIMARY KEY, nome TEXT NOT NULL, categoria TEXT NOT NULL,
    preco_cent INTEGER NOT NULL, estacao TEXT NOT NULL DEFAULT 'cozinha',
    afericao INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1);

  CREATE TABLE IF NOT EXISTS padroes (
    id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES cardapio(id) ON DELETE CASCADE,
    n INTEGER NOT NULL, mu TEXT NOT NULL, sigma TEXT NOT NULL, atualizado_em TEXT NOT NULL,
    UNIQUE(item_id));

  CREATE TABLE IF NOT EXISTS comandas (
    id INTEGER PRIMARY KEY, mesa_id INTEGER NOT NULL REFERENCES mesas(id),
    codigo TEXT NOT NULL UNIQUE, pessoas INTEGER NOT NULL DEFAULT 1,
    servico_pct INTEGER NOT NULL DEFAULT 10, status TEXT NOT NULL DEFAULT 'aberta',
    aberta_em TEXT NOT NULL, fechada_em TEXT, aberta_por INTEGER,
    desconto_cent INTEGER NOT NULL DEFAULT 0, desconto_motivo TEXT, nomes TEXT);

  CREATE TABLE IF NOT EXISTS lancamentos (
    id INTEGER PRIMARY KEY, comanda_id INTEGER NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
    item_id INTEGER, nome TEXT NOT NULL, qtd INTEGER NOT NULL DEFAULT 1,
    preco_cent INTEGER NOT NULL, origem TEXT NOT NULL DEFAULT 'garcom',
    estacao TEXT NOT NULL DEFAULT 'cozinha', estado TEXT NOT NULL DEFAULT 'pendente',
    medicao_id INTEGER, criado_em TEXT NOT NULL, por INTEGER,
    observacao TEXT, pronto_em TEXT, entregue_em TEXT);

  /* rateio por item: quem divide o quê. Sem linha aqui, o item é da mesa
     inteira e entra na divisão igual para todos. */
  CREATE TABLE IF NOT EXISTS divisao (
    lancamento_id INTEGER NOT NULL REFERENCES lancamentos(id) ON DELETE CASCADE,
    pessoa INTEGER NOT NULL,
    PRIMARY KEY (lancamento_id, pessoa));

  CREATE TABLE IF NOT EXISTS medicoes (
    id INTEGER PRIMARY KEY, comanda_id INTEGER, item_id INTEGER,
    grandezas TEXT NOT NULL, dm REAL, confianca REAL, camada INTEGER NOT NULL DEFAULT 0,
    veredito TEXT, criado_em TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY, tipo TEXT NOT NULL, mesa INTEGER, carga TEXT,
    urb1 TEXT NOT NULL, criado_em TEXT NOT NULL);

  CREATE INDEX IF NOT EXISTS ix_lanc_comanda ON lancamentos(comanda_id);
  CREATE INDEX IF NOT EXISTS ix_lanc_estado ON lancamentos(estado);
  CREATE INDEX IF NOT EXISTS ix_comanda_mesa ON comandas(mesa_id, status);
  `);
}

/* Bancos criados antes destas colunas continuam abrindo: cada coluna nova é
   conferida e acrescentada na hora, sem apagar nada. */
function migrar(db) {
  const tem = (tabela, coluna) =>
    db.prepare(`SELECT COUNT(*) c FROM pragma_table_info(?) WHERE name = ?`).get(tabela, coluna).c > 0;
  const novas = [
    ['lancamentos', 'observacao', 'TEXT'],
    ['lancamentos', 'pronto_em', 'TEXT'],
    ['lancamentos', 'entregue_em', 'TEXT'],
    ['comandas', 'desconto_cent', 'INTEGER NOT NULL DEFAULT 0'],
    ['comandas', 'desconto_motivo', 'TEXT'],
    ['comandas', 'nomes', 'TEXT']
  ];
  for (const [tabela, coluna, tipo] of novas) {
    if (!tem(tabela, coluna)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
  }
}

/* ---- PIN ---- */
function hashPin(pin, sal = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(String(pin), sal, 32).toString('hex');
  return { pin_hash: h, sal };
}
function confirmaPin(pin, sal, esperado) {
  const h = crypto.scryptSync(String(pin), sal, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(esperado, 'hex'));
}

const agora = () => new Date().toISOString();
const codigoMesa = () => crypto.randomBytes(4).toString('hex').toUpperCase();

module.exports = { abrir, esquema, migrar, hashPin, confirmaPin, agora, codigoMesa, ARQUIVO };
