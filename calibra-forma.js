/* Diagnóstico do núcleo de visão — rode com `node calibra-forma.js`.

   Mede o núcleo em cenas controladas, variando uma coisa por vez, e compara
   cada medição com a mesma cena bem enquadrada. É daqui que saem os números
   do README. Rode de novo depois de mexer em qualquer limiar do nucleo.js.

   São cenas sintéticas: dizem se o método está certo, não quanto ele acerta
   nas fotos da sua casa. Isso quem diz é o painel 05 de /sistema. */
global.window = global;
require('./nucleo.js');

function cena({ L = 480, A = 360, cx = .5, cy = .5, R = .36, tilt = 1, rot = 0, fundo = [26, 24, 22],
  prato = [238, 236, 231], forma = 'circulo', cast = [1, 1, 1], guarn = 5, extras = [] } = {}) {
  const d = new Uint8ClampedArray(L * A * 4), m = Math.min(L, A), X = cx * L, Y = cy * A, r = R * m;
  const co = Math.cos(rot), si = Math.sin(rot);
  const loc = (x, y) => { const dx = x - X, dy = y - Y; return [dx * co + dy * si, (-dx * si + dy * co) / tilt]; };
  const cor = (x, y) => {
    for (const e of extras) { const c = e(x, y, L, A); if (c) return c; }
    const [u, v] = loc(x, y);
    if (forma === 'quadrado' ? Math.max(Math.abs(u), Math.abs(v)) > r : Math.hypot(u, v) > r) return fundo;
    if (Math.hypot(u, v) < r * .42) return [150, 82, 46];
    for (let k = 0; k < guarn; k++) if (Math.hypot(u - Math.cos(k * 2.4) * r * .62, v - Math.sin(k * 2.4) * r * .62) < r * .09) return [60, 120, 52];
    return prato;
  };
  for (let y = 0; y < A; y++) for (let x = 0; x < L; x++) {
    let R0 = 0, G0 = 0, B0 = 0;
    for (const [ox, oy] of [[.25, .25], [.75, .25], [.25, .75], [.75, .75]]) { const c = cor(x + ox, y + oy); R0 += c[0]; G0 += c[1]; B0 += c[2]; }
    const i = (y * L + x) * 4;
    d[i] = R0 / 4 * cast[0]; d[i + 1] = G0 / 4 * cast[1]; d[i + 2] = B0 / 4 * cast[2]; d[i + 3] = 255;
  }
  return { width: L, height: A, data: d };
}

const disco = (cx, cy, R, c) => (x, y, L, A) => Math.hypot(x - cx * L, y - cy * A) < R * Math.min(L, A) ? c : null;
const casos = [
  ['resolução 1280×960', { L: 1280, A: 960 }, null], ['retrato 360×640', { L: 360, A: 640 }, null],
  ['prato pequeno no canto', { cx: .28, cy: .3, R: .16 }, null],
  ['prato encostado na borda da foto', { cx: .2, guarn: 0 }, { guarn: 0 }],
  ['prato bem para fora da borda', { cx: .05, guarn: 0 }, { guarn: 0 }],
  ['metade do prato para fora', { cx: -.01, guarn: 0 }, { guarn: 0 }],
  ['dois terços para fora (canto)', { cx: .08, cy: .12, guarn: 0 }, { guarn: 0 }],
  ['resolução de webcam 320×240', { L: 320, A: 240 }, null],
  ['resolução de celular 4032×3024', { L: 4032, A: 3024 }, null],
  ['prato ocupando quase todo o quadro', { R: .48 }, null],
  ['prato pequeno e no canto, foto grande', { L: 1600, A: 1200, cx: .2, cy: .78, R: .12 }, null],
  ['inclinado ~53°', { tilt: .6 }, null],
  ['luz fria', { cast: [.86, .97, 1.05] }, null], ['luz quente', { cast: [1.06, 1, .84] }, null],
  ['luz verde (fluorescente)', { cast: [.92, 1.04, .9] }, null],
  ['mesa clara', { fundo: [205, 188, 160] }, null],
  /* louça diferente não se compara com a referência de louça branca: muda a
     cor contra a qual a comida é lida. Cada prato é gravado na louça dele. */
  ['prato escuro em mesa clara (outra louça)', { prato: [48, 50, 54], fundo: [210, 200, 185] }, 'outra-louca'],
  ['dois pratos encostados', { cx: .34, R: .26, extras: [disco(.74, .5, .26, [236, 234, 229])] }, { cx: .34, R: .26 }],
  ['tábua girada (outra louça)', { forma: 'quadrado', prato: [205, 170, 120], rot: .3, R: .3 }, 'outra-louca']
];

/* ── o que as grandezas novas acrescentam ──────────────────────────────────
   Dois pratos do mesmo tamanho e quase da mesma cor, um liso (purê) e outro
   granulado (fritas picadas). Com as 8 grandezas da v2 eles quase se
   sobrepõem; com textura, contraste e matiz, separam. */
const { envelope, afastamento } = require('./afericao.js');
const granulado = (semente) => (x, y, L, A) => {
  const m = Math.min(L, A), dx = x - .5 * L, dy = y - .5 * A;
  if (Math.hypot(dx, dy) > .30 * m) return null;
  const h = Math.sin((x * 12.9898 + y * 78.233 + semente) * 43758.5453) * 43758.5453;
  return (h - Math.floor(h)) > .5 ? [196, 148, 74] : [148, 104, 44];
};
const liso = () => (x, y, L, A) => {
  const m = Math.min(L, A), dx = x - .5 * L, dy = y - .5 * A;
  return Math.hypot(dx, dy) > .30 * m ? null : [172, 126, 59];
};
/* as amostras variam como variariam no salão: ângulo, tamanho e cor da luz.
   A prova é uma variação que não entrou em nenhum padrão. */
const jeito = k => ({ guarn: 0, rot: k * .21, R: .34 + k * .012, tilt: 1 - k * .04,
  cast: [1 + k * .012, 1, 1 - k * .01] });
const medeSerie = (extra, n) => Array.from({ length: n }, (_, k) =>
  window.Nucleo.medir(cena({ ...jeito(k), extras: [extra(k)] })).m);
const amostrasLiso = medeSerie(() => liso(), 5);
const amostrasGran = medeSerie(k => granulado(k * 7 + 1), 5);
const provaLiso = window.Nucleo.medir(cena({ ...jeito(7), extras: [liso()] }));
const V2 = ['ocupacao', 'centragem', 'dispersao', 'elementos', 'borda', 'luminancia', 'cromaA', 'cromaB'];
const so = (o, ks) => Object.fromEntries(ks.map(k => [k, o[k]]));
function separacao(chaves) {
  const envL = envelope(amostrasLiso.map(a => so(a, chaves)));
  const envG = envelope(amostrasGran.map(a => so(a, chaves)));
  const g = so(provaLiso.m, chaves);
  /* recorta o afastamento às chaves pedidas */
  const dm = (env) => {
    let soma = 0;
    for (const k of chaves) soma += ((g[k] - env.mu[k]) / Math.sqrt(env.sigma[k])) ** 2;
    return Math.sqrt(soma / chaves.length);
  };
  return { certo: dm(envL), errado: dm(envG) };
}
const sepV2 = separacao(V2), sepV3 = separacao(window.Nucleo.CHAVES);
console.log('\nprato liso × prato granulado (mesma cor, mesmo tamanho)');
console.log('grandezas          │ afastamento do certo │ do errado │ separação');
for (const [rot, r] of [['8 da versão 2', sepV2], ['11 da versão 3', sepV3]])
  console.log(`${rot.padEnd(18)} │ ${r.certo.toFixed(3).padStart(20)} │ ${r.errado.toFixed(3).padStart(9)} │ ` +
    `${(r.errado / Math.max(r.certo, 1e-6)).toFixed(2)}×`);

/* ── o efeito dos pesos no prato mal enquadrado ───────────────────────────── */
const amostrasRef = Array.from({ length: 5 }, (_, k) => window.Nucleo.medir(cena({ rot: k * .3 })).m);
const envRef = envelope(amostrasRef);
console.log('\nmesmo prato, mal enquadrado, contra o padrão bem enquadrado');
console.log('enquadramento                 │ visível │ sem pesos │ com pesos');
for (const [rot, op] of [['centralizado', {}], ['encostado na borda', { cx: .2 }],
  ['bem para fora', { cx: .05 }], ['dois terços para fora', { cx: .08, cy: .12 }]]) {
  const r = window.Nucleo.medir(cena(op));
  if (r.falha) { console.log(`${rot.padEnd(29)} │ recusado: ${r.falha}`); continue; }
  const semPeso = afastamento(r.m, envRef).dm, comPeso = afastamento(r.m, envRef, { pesos: r.pesos }).dm;
  console.log(`${rot.padEnd(29)} │ ${String(Math.round(r.visivel * 100) + '%').padStart(7)} │ ` +
    `${semPeso.toFixed(3).padStart(9)} │ ${comPeso.toFixed(3).padStart(9)}`);
}

const refs = new Map();
const ref = op => { const k = JSON.stringify(op || {}); if (!refs.has(k)) refs.set(k, Nucleo.medir(cena(op || {}))); return refs.get(k); };
console.log('caso                                     │ lê? │ forma     │ visível │ maior desvio │ qualidade');
for (const [nome, op, refOp] of casos) {
  const r = Nucleo.medir(cena(op));
  if (r.falha) { console.log(`${nome.padEnd(41)}│ não │ ${r.falha}`); continue; }
  const semRef = refOp === 'outra-louca';
  const d = semRef ? null : Math.max(...Nucleo.CHAVES.map(k => Math.abs(r.m[k] - ref(refOp).m[k])));
  console.log(`${nome.padEnd(41)}│ sim │ ${r.forma.padEnd(9)} │ ${String(Math.round(r.visivel * 100)).padStart(5)}%  │ ${semRef ? '    —     ' : d.toFixed(3).padStart(8) + '  '}   │ ${r.qualidade}`);
}
