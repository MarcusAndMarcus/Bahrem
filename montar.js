'use strict';
/* Monta o protótipo de arquivo único a partir dos MESMOS arquivos que o servidor
   usa — assim a demonstração não vira um segundo código que diverge do primeiro.
   node montar.js [destino.html] */

const fs = require('node:fs');
const path = require('node:path');
const raiz = __dirname;

const ler = p => fs.readFileSync(path.join(raiz, p), 'utf8');

/* transforma um módulo CommonJS em atribuição global, sem reescrever o código */
const paraNavegador = (arquivo, nome, prefixo = '') =>
  `/* ${arquivo} — mesmo código do servidor */\n(function(){var module={exports:{}};var exports=module.exports;\n${prefixo}\n` +
  ler(arquivo).replace(/^'use strict';\n/, '').replace(/^const \{[^}]*\} = require\([^)]*\);$/gm, '') +
  `\nwindow.${nome} = module.exports;})();`;

let html = ler('casca.html');
/* substituição por função: sem isso, um $$ no código vira $ na saída */
const poe = (alvo, texto) => { html = html.replace(alvo, () => texto); };
poe('/*{{CSS}}*/', ler('bahrem.css'));
poe('/*{{NUCLEO}}*/', ler('nucleo.js'));
poe('/*{{MODULOS}}*/',
  [paraNavegador('urb1.js', 'URB1'),
    paraNavegador('afericao.js', 'Afericao'),
    /* pix.js importa o CRC do urb1; no navegador ele vem do global */
    paraNavegador('pix.js', 'PIX', 'const { crc16, hex } = window.URB1;'),
    paraNavegador('conta.js', 'Conta')
  ].join('\n\n'));
poe('/*{{DEMO}}*/', ler('demo.js'));

/* o protótipo é um arquivo só: as imagens entram como data URI */
const embutir = (arquivo, tipo) =>
  `data:${tipo};base64,${fs.readFileSync(path.join(raiz, arquivo)).toString('base64')}`;
html = html.split('url(/casa.jpg)').join(`url(${embutir('casa.jpg', 'image/jpeg')})`);
html = html.split('src="/marca.png"').join(`src="${embutir('marca.png', 'image/png')}"`);

const destino = process.argv[2] || path.join(raiz, 'bahrem-prototipo.html');
fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.writeFileSync(destino, html);
console.log(`${destino} — ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
