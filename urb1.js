'use strict';
/* URB1 — barramento hexadecimal de telemetria.
   Mesmo vocabulário do ALEX/AFERIDOR e do UROBOROS: quadro de tamanho fixo,
   campos em hex maiúsculo, CRC16-CCITT (poly 0x1021, init 0xFFFF) no fim.

   Quadro:  URB1 <ORIG> <VERBO> <MESA> <CARGA…> *<CRC4>
   Exemplo: URB1 C01 AFER 0007 1F4A 00C8 *A3D2
*/

function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

const hex = (n, largura) => (n >>> 0).toString(16).toUpperCase().padStart(largura, '0');

/* inteiro -> palavra de 16 bits, saturando (não estoura, não mente) */
function palavra(v) {
  const n = Math.round(Number(v) || 0);
  return hex(Math.max(0, Math.min(0xffff, n)), 4);
}

function telegrama(orig, verbo, mesa, carga = []) {
  const corpo = [
    'URB1',
    String(orig).toUpperCase().slice(0, 3).padStart(3, '0'),
    String(verbo).toUpperCase().slice(0, 4).padEnd(4, ' ').trimEnd(),
    palavra(mesa),
    ...carga.map(palavra)
  ].join(' ');
  return `${corpo} *${hex(crc16(corpo), 4)}`;
}

function confere(quadro) {
  const i = quadro.lastIndexOf(' *');
  if (i < 0) return false;
  return hex(crc16(quadro.slice(0, i)), 4) === quadro.slice(i + 2);
}

module.exports = { crc16, hex, telegrama, confere };
