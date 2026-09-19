'use strict';
/* Pix BR Code (EMV MPM) — mesmo algoritmo já validado no Alphaville Flamboyant.
   O CRC16-CCITT vem do módulo URB1: é o mesmo polinômio, não há duas versões. */

const { crc16, hex } = require('./urb1');

const campo = (id, valor) => `${id}${String(valor.length).padStart(2, '0')}${valor}`;

/* remove acentos e o que o EMV não aceita; BACEN limita nome a 25 e cidade a 15 */
function limpo(s, max) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 .\-]/g, '')
    .trim().slice(0, max).toUpperCase();
}

/**
 * @param {object} o
 * @param {string} o.chave    chave Pix do recebedor
 * @param {number} o.valor    em reais; 0 ou ausente = valor livre
 * @param {string} o.nome     nome do recebedor
 * @param {string} o.cidade   cidade do recebedor
 * @param {string} o.txid     identificador (até 25 chars); '***' se vazio
 */
function brcode({ chave, valor, nome, cidade, txid }) {
  if (!chave) throw new Error('pix: chave ausente');
  const mai = campo('00', 'BR.GOV.BCB.PIX') + campo('01', String(chave).slice(0, 77));
  const ref = limpo(txid, 25).replace(/ /g, '') || '***';
  const partes = [
    campo('00', '01'),
    campo('01', '12'),              // 12 = QR estático reutilizável
    campo('26', mai),
    campo('52', '0000'),
    campo('53', '986'),             // BRL
    ...(valor > 0 ? [campo('54', Number(valor).toFixed(2))] : []),
    campo('58', 'BR'),
    campo('59', limpo(nome, 25) || 'RECEBEDOR'),
    campo('60', limpo(cidade, 15) || 'GOIANIA'),
    campo('62', campo('05', ref))
  ].join('');
  const semCrc = partes + '6304';
  return semCrc + hex(crc16(semCrc), 4);
}

module.exports = { brcode, limpo };
