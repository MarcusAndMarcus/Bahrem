'use strict';
/* Carga inicial. Os preços abaixo são de DEMONSTRAÇÃO — só a croqueta de costela
   (R$ 64,00 / 8 un.) veio de um relato público de cliente; o resto é placeholder
   para o sistema ter o que mostrar. Trocar pelo cardápio real antes de operar. */

const { abrir, hashPin, agora } = require('./db');

const MESAS = [
  // [numero, lugares, area]
  [1, 4, 'salao'], [2, 4, 'salao'], [3, 6, 'salao'], [4, 2, 'salao'],
  [5, 4, 'salao'], [6, 8, 'salao'], [7, 4, 'salao'], [8, 4, 'salao'],
  [11, 4, 'deck'], [12, 4, 'deck'], [13, 6, 'deck'], [14, 2, 'deck'],
  [15, 4, 'deck'], [16, 10, 'deck'],
  [21, 4, 'mezanino'], [22, 6, 'mezanino'], [23, 4, 'mezanino'], [24, 4, 'mezanino']
];

const CARDAPIO = [
  // nome, categoria, preco_cent, estacao, aferido pela câmera
  ['Croqueta de costela (8 un.)', 'petisco', 6400, 'cozinha', 1],
  ['Chapa de camarão', 'petisco', 12900, 'cozinha', 1],
  ['Kiev de frango com palmito', 'petisco', 7900, 'cozinha', 1],
  ['Costelinha de porco', 'petisco', 8900, 'cozinha', 1],
  ['Batata rústica com alecrim', 'petisco', 4900, 'cozinha', 1],
  ['Filé ao molho de cerveja', 'prato', 14900, 'cozinha', 1],
  ['Picanha na chapa (2 pessoas)', 'prato', 18900, 'cozinha', 1],
  ['Executivo do dia', 'prato', 5900, 'cozinha', 1],
  ['Chopp Pilsen 300ml', 'chopp', 1500, 'bar', 0],
  ['Chopp Pilsen 500ml', 'chopp', 2200, 'bar', 0],
  ['Chopp escuro 300ml', 'chopp', 1700, 'bar', 0],
  ['Long neck', 'cerveja', 1400, 'bar', 0],
  ['Caipirinha de limão', 'drink', 2900, 'bar', 0],
  ['Drink autoral da casa', 'drink', 3900, 'bar', 1],
  ['Abacaxi com cachaça', 'drink', 4900, 'bar', 1],
  ['Taça de vinho tinto', 'vinho', 3200, 'bar', 0],
  ['Refrigerante lata', 'sem álcool', 900, 'bar', 0],
  ['Água com gás', 'sem álcool', 700, 'bar', 0]
];

const EQUIPE = [
  ['Cafú', 'garcom', '1986'],
  ['Rodrigus', 'gerente', '2468'],
  ['Passe da cozinha', 'passe', '1357']
];

function semear(db = abrir()) {
  const jaTem = db.prepare('SELECT COUNT(*) c FROM mesas').get().c;
  if (jaTem > 0) return { db, novo: false };

  const m = db.prepare('INSERT INTO mesas (numero, lugares, area) VALUES (?, ?, ?)');
  for (const [n, l, a] of MESAS) m.run(n, l, a);

  const c = db.prepare(
    'INSERT INTO cardapio (nome, categoria, preco_cent, estacao, afericao) VALUES (?, ?, ?, ?, ?)');
  for (const linha of CARDAPIO) c.run(...linha);

  const f = db.prepare(
    'INSERT INTO funcionarios (nome, papel, pin_hash, sal) VALUES (?, ?, ?, ?)');
  for (const [nome, papel, pin] of EQUIPE) {
    const { pin_hash, sal } = hashPin(pin);
    f.run(nome, papel, pin_hash, sal);
  }

  db.prepare('INSERT INTO eventos (tipo, mesa, carga, urb1, criado_em) VALUES (?,?,?,?,?)')
    .run('carga-inicial', null, JSON.stringify({ mesas: MESAS.length, itens: CARDAPIO.length }),
      'URB1 000 SEED 0000 *0000', agora());

  return { db, novo: true };
}

if (require.main === module) {
  const { novo } = semear();
  console.log(novo ? 'carga inicial gravada' : 'banco já tinha dados — nada mudou');
}

module.exports = { semear, MESAS, CARDAPIO, EQUIPE };
