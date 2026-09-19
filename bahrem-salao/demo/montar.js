'use strict';
/* Monta o protótipo de arquivo único a partir dos MESMOS arquivos que o servidor
   usa — assim a demonstração não vira um segundo código que diverge do primeiro.
   node demo/montar.js [destino.html] */

const fs = require('node:fs');
const path = require('node:path');
const raiz = path.join(__dirname, '..');

const ler = p => fs.readFileSync(path.join(raiz, p), 'utf8');

/* transforma um módulo CommonJS em atribuição global, sem reescrever o código */
const paraNavegador = (arquivo, nome, prefixo = '') =>
  `/* ${arquivo} — mesmo código do servidor */\n(function(){var module={exports:{}};var exports=module.exports;\n${prefixo}\n` +
  ler(arquivo).replace(/^'use strict';\n/, '').replace(/^const \{[^}]*\} = require\([^)]*\);$/gm, '') +
  `\nwindow.${nome} = module.exports;})();`;

let html = ler('demo/casca.html');
/* substituição por função: sem isso, um $$ no código vira $ na saída */
const poe = (alvo, texto) => { html = html.replace(alvo, () => texto); };
poe('/*{{CSS}}*/', ler('public/bahrem.css'));
poe('/*{{NUCLEO}}*/', ler('public/nucleo.js'));
poe('/*{{MODULOS}}*/',
  [paraNavegador('urb1.js', 'URB1'),
    paraNavegador('afericao.js', 'Afericao'),
    /* pix.js importa o CRC do urb1; no navegador ele vem do global */
    paraNavegador('pix.js', 'PIX', 'const { crc16, hex } = window.URB1;')
  ].join('\n\n'));
poe('/*{{DEMO}}*/', ler('demo/demo.js'));

const destino = process.argv[2] || path.join(raiz, 'bahrem-prototipo.html');
fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.writeFileSync(destino, html);
console.log(`${destino} — ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
