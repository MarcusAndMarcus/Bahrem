'use strict';
/* Empacotador — junta o sistema inteiro num arquivo só.

   Por que existe: subir 33 arquivos por navegador de tablet é frágil. O
   navegador renomeia duplicata ("index-58.html"), o upload perde arquivo no
   meio, e aí o servidor procura um nome que não existe. Um arquivo só não tem
   como quebrar desse jeito.

   O que ele NÃO é: uma segunda versão do sistema. O código-fonte continua
   sendo os módulos separados; isto aqui é o resultado, montado a partir deles.
   Mexeu num módulo, roda `node empacotar.js` de novo.

   Como funciona: cada módulo entra dentro de uma função com a mesma assinatura
   que o Node dá a um arquivo CommonJS (module, exports, require), e um
   registro minúsculo resolve `require('./urb1')` para dentro do pacote.
   `require('node:http')` não casa com nada no registro e cai no require de
   verdade. A interface (HTML, CSS, JS de navegador, as duas imagens) vira um
   objeto que o servidor serve da memória. */

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = __dirname;
const ler = a => fs.readFileSync(path.join(RAIZ, a), 'utf8');

/* ordem não importa para o registro (é preguiçoso), mas manter a de
   dependência ajuda quem for ler o pacote */
const MODULOS = ['urb1.js', 'pix.js', 'afericao.js', 'conta.js', 'fiscal.js', 'db.js',
  'seed.js', 'persistencia.js', 'assistente.js', 'server.js'];

const INTERFACE = {
  'index.html': 'text/html; charset=utf-8',
  'salao.html': 'text/html; charset=utf-8',
  'mesa.html': 'text/html; charset=utf-8',
  'passe.html': 'text/html; charset=utf-8',
  'camera.html': 'text/html; charset=utf-8',
  'noite.html': 'text/html; charset=utf-8',
  'qr.html': 'text/html; charset=utf-8',
  'cardapio.html': 'text/html; charset=utf-8',
  'cupom.html': 'text/html; charset=utf-8',
  'sistema.html': 'text/html; charset=utf-8',
  'burguer.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'nucleo.js': 'text/javascript; charset=utf-8',
  'alerta.js': 'text/javascript; charset=utf-8',
  'caixinha.js': 'text/javascript; charset=utf-8'
};
const IMAGENS = { 'casa.jpg': 'image/jpeg' };

/* JSON.stringify não escapa </script> nem U+2028/2029; num arquivo .js isso é
   inofensivo, mas escapo mesmo assim para o pacote poder ser colado em
   qualquer lugar sem surpresa */
const texto = s => JSON.stringify(s)
  .replace(/<\/script/gi, '<\\/script')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function montar() {
  const arquivos = [];
  for (const [nome, tipo] of Object.entries(INTERFACE)) {
    arquivos.push(`  ${texto(nome)}: { tipo: ${texto(tipo)}, texto: ${texto(ler(nome))} }`);
  }
  for (const [nome, tipo] of Object.entries(IMAGENS)) {
    const b64 = fs.readFileSync(path.join(RAIZ, nome)).toString('base64');
    arquivos.push(`  ${texto(nome)}: { tipo: ${texto(tipo)}, base64: ${texto(b64)} }`);
  }

  const modulos = MODULOS.map(nome => {
    const fonte = ler(nome);
    const chave = './' + nome.replace(/\.js$/, '');
    return `__def(${texto(chave)}, function (module, exports, require) {\n${fonte}\n});`;
  });

  return `#!/usr/bin/env node
'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   BURGUER · Salão — pacote de arquivo único.

   GERADO por empacotar.js a partir dos módulos separados. Não edite aqui:
   a próxima geração apaga a mudança. O código-fonte são os arquivos soltos.

   Gerado em ${new Date().toISOString()}
   Módulos: ${MODULOS.join(', ')}
   Interface embutida: ${Object.keys(INTERFACE).concat(Object.keys(IMAGENS)).join(', ')}

   Para rodar:  node server.js
   ══════════════════════════════════════════════════════════════════════════ */

/* a interface, servida da memória */
globalThis.__BURGUER_ARQUIVOS = {
${arquivos.join(',\n')}
};

/* registro de módulos: require('./urb1') resolve aqui dentro;
   require('node:http') não casa e cai no require de verdade */
const __nativo = require;
const __M = Object.create(null);
const __def = (nome, fn) => { __M[nome] = { fn, mod: null }; };
function __req(nome) {
  const alvo = __M[nome] || __M['./' + String(nome).replace(/^\\.\\//, '')];
  if (!alvo) return __nativo(nome);
  if (!alvo.mod) {
    alvo.mod = { exports: {} };
    alvo.fn(alvo.mod, alvo.mod.exports, __req);
  }
  return alvo.mod.exports;
}

${modulos.join('\n\n')}

/* Partida explícita: dentro do pacote nenhum módulo é o principal do Node, e
   por isso o \`if (require.main === module)\` do server.js nunca dispara.
   Só sobe se ESTE arquivo for o que o Node executou — carregado por outro
   arquivo, ele só exporta, sem ocupar porta nenhuma. */
const servidor = __req('./server');

if (require.main === module) {
  servidor.preparar().then(() => {
    const porta = Number(process.env.PORT) || 3000;
    servidor.servidor.listen(porta, () => {
      console.log(\`BURGUER · Salão (pacote único) em http://localhost:\${porta}\`);
    });
  }).catch(e => { console.error('não subiu:', e.message); process.exit(1); });
}

module.exports = servidor;
`;
}

if (require.main === module) {
  const destino = process.argv[2] || path.join(RAIZ, 'burguer-pacote.js');
  const saida = montar();
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, saida);
  console.log(`${destino} — ${(Buffer.byteLength(saida) / 1024).toFixed(0)} KB, ` +
    `${MODULOS.length} módulos, ${Object.keys(INTERFACE).length + Object.keys(IMAGENS).length} arquivos de interface`);
}

module.exports = { montar, MODULOS, INTERFACE, IMAGENS };
