/* núcleo de medição, versão 2 — roda inteiro no aparelho, sem rede.
   Entrada: <img>, <video>, <canvas> ou ImageData, em qualquer resolução.
   Saída: 8 grandezas em [0,1], a forma encontrada e o que deu para confiar.

   O que mudou da versão 1, e por quê (medido em cenas controladas):
   - a v1 achava "a maior mancha clara" e exigia o prato inteiro no quadro.
     Recusava prato com 25% fora, mesa clara e tábua. A v2 acha a BORDA: ajusta
     uma elipse direto aos pontos do contorno que aparecem (Halir & Flusser,
     com amostragem robusta que ignora comida por cima da aba e objeto
     encostado), e reconstrói o que ficou fora do quadro;
   - a v1 media em pixels da foto, e o ângulo deformava as grandezas (0,074 na
     borda a ~53°). A v2 mede em coordenadas da própria elipse: o prato
     inclinado vira círculo antes da medição;
   - a v1 não corrigia a luz (0,063 de desvio de cor sob luz quente). A v2 usa
     a aba do prato, quando é branca, como referência de branco;
   - a v2 também reconhece tábua e travessa retangular (ajuste de retângulo
     competindo com a elipse), e separa o objeto do fundo pela cor da borda da
     foto, e não por supor que a mesa é escura.

   Determinismo: a redução para o tamanho de trabalho usa filtro de caixa
   próprio (o reescalonador do Canvas muda entre navegadores), e a amostragem
   robusta usa semente fixa. Mesma foto, mesmas grandezas, em qualquer aparelho. */
(function (raiz) {
  'use strict';

  const VERSAO = 3;
  const CHAVES = ['ocupacao', 'centragem', 'dispersao', 'elementos',
    'borda', 'luminancia', 'cromaA', 'cromaB',
    /* v3: três grandezas que não dependem de a comida estar inteira no quadro,
       e que separam pratos que cor e área confundem — fritas e purê do mesmo
       tom, risoto e carne desfiada, croquete e almôndega */
    'textura', 'contraste', 'matiz'];

  const LONGO = 480;           // lado maior de trabalho — qualquer resolução vira isto
  const LONGO_RAPIDO = 256;    // no guia ao vivo
  const LARG = LONGO;          // compatibilidade
  const LIMIARES = {
    visivel: 0.35,             // fração da forma dentro do quadro (v3: era 0,55)
    razao: 0.35,               // eixo menor ÷ maior; abaixo, ângulo rasante demais
    aderencia: 0.40,           // fração do contorno que casa com a forma
    cobertura: 0.88,           // fração da forma ajustada que o objeto preenche
    tolBorda: 0.05,            // resíduo relativo para um ponto contar como "na borda"
    comidaMin: 0.02            // abaixo disso, prato vazio
  };

  const trava = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;

  /* ---------- sRGB → CIE Lab (D65) ---------- */
  const inv = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    inv[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const f = t => t > 0.008856451679 ? Math.cbrt(t) : (903.2962962 * t + 16) / 116;
  function paraLab(dados, n) {
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = inv[dados[p]], g = inv[dados[p + 1]], b = inv[dados[p + 2]];
      const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
      const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
      const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
      const fx = f(x), fy = f(y), fz = f(z);
      L[i] = 116 * fy - 16; A[i] = 500 * (fx - fy); B[i] = 200 * (fy - fz);
    }
    return { L, A, B };
  }

  /* ---------- redimensionamento determinístico ---------- */
  function caixaPara(img, L, A) {
    const { width: lo, height: ao, data: d } = img;
    const saida = new Uint8ClampedArray(L * A * 4);
    for (let y = 0; y < A; y++) {
      const y0 = Math.floor(y * ao / A), y1 = Math.max(y0 + 1, Math.floor((y + 1) * ao / A));
      for (let x = 0; x < L; x++) {
        const x0 = Math.floor(x * lo / L), x1 = Math.max(x0 + 1, Math.floor((x + 1) * lo / L));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0, p = (yy * lo + x0) * 4; xx < x1; xx++, p += 4) { r += d[p]; g += d[p + 1]; b += d[p + 2]; n++; }
        }
        const q = (y * L + x) * 4;
        saida[q] = (r / n) | 0; saida[q + 1] = (g / n) | 0; saida[q + 2] = (b / n) | 0; saida[q + 3] = 255;
      }
    }
    return { width: L, height: A, data: saida };
  }
  function bilinear(img, L, A) {
    const { width: lo, height: ao, data: d } = img;
    const saida = new Uint8ClampedArray(L * A * 4);
    for (let y = 0; y < A; y++) {
      const fy = Math.max(0, Math.min(ao - 1, (y + 0.5) * ao / A - 0.5)), y0 = Math.floor(fy), y1 = Math.min(ao - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < L; x++) {
        const fx = Math.max(0, Math.min(lo - 1, (x + 0.5) * lo / L - 0.5)), x0 = Math.floor(fx), x1 = Math.min(lo - 1, x0 + 1), tx = fx - x0;
        const q = (y * L + x) * 4;
        for (let c = 0; c < 3; c++) {
          const v = (d[(y0 * lo + x0) * 4 + c] * (1 - tx) + d[(y0 * lo + x1) * 4 + c] * tx) * (1 - ty)
            + (d[(y1 * lo + x0) * 4 + c] * (1 - tx) + d[(y1 * lo + x1) * 4 + c] * tx) * ty;
          saida[q + c] = v;
        }
        saida[q + 3] = 255;
      }
    }
    return { width: L, height: A, data: saida };
  }
  /** leva qualquer imagem ao tamanho de trabalho: reduz com caixa, amplia com bilinear */
  function redimensionar(img, longo = LONGO) {
    const e = longo / Math.max(img.width, img.height);
    const L = Math.max(1, Math.round(img.width * e)), A = Math.max(1, Math.round(img.height * e));
    if (L === img.width && A === img.height) return img;
    return e < 1 ? caixaPara(img, L, A) : bilinear(img, L, A);
  }
  /** compatibilidade: reduz só a largura para LARG */
  function caixa(img) {
    if (img.width <= LARG) return img;
    return caixaPara(img, LARG, Math.max(1, Math.round(img.height * LARG / img.width)));
  }

  function amostrar(fonte, longo) {
    if (fonte.data && fonte.width && fonte.height) return redimensionar(fonte, longo);
    const lf = fonte.videoWidth || fonte.naturalWidth || fonte.width;
    const af = fonte.videoHeight || fonte.naturalHeight || fonte.height;
    if (!lf || !af) throw new Error('imagem sem dimensão');
    /* foto gigante: primeira passada pelo reescalonador do navegador, com
       suavização; o filtro de caixa próprio faz a redução final */
    const e = Math.min(1, 2400 / Math.max(lf, af));
    const li = Math.max(1, Math.round(lf * e)), ai = Math.max(1, Math.round(af * e));
    const c = document.createElement('canvas');
    c.width = li; c.height = ai;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = e < 1;
    if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fonte, 0, 0, li, ai);
    return redimensionar(ctx.getImageData(0, 0, li, ai), longo);
  }

  /* ---------- Otsu com tratamento de platô ---------- */
  function otsu(valores, mascara, lo, hi) {
    const Bn = 64, hist = new Float64Array(Bn);
    let n = 0;
    for (let i = 0; i < valores.length; i++) {
      if (mascara && !mascara[i]) continue;
      hist[trava(Math.floor((valores[i] - lo) / (hi - lo) * Bn), 0, Bn - 1)]++; n++;
    }
    if (n < 16) return null;
    let soma = 0; for (let b = 0; b < Bn; b++) soma += b * hist[b];
    let somaB = 0, wB = 0, melhor = -1, lim = [];
    for (let b = 0; b < Bn; b++) {
      wB += hist[b]; if (!wB) continue;
      const wF = n - wB; if (!wF) break;
      somaB += b * hist[b];
      const entre = wB * wF * ((somaB / wB) - ((soma - somaB) / wF)) ** 2;
      if (entre > melhor + 1e-9) { melhor = entre; lim = [b]; } else if (Math.abs(entre - melhor) <= 1e-9) lim.push(b);
    }
    if (melhor <= 0) return null;
    return lo + (lim[(lim.length - 1) >> 1] + 1) / Bn * (hi - lo);
  }

  /* ---------- componentes conexos e vãos ---------- */
  function componentes(mask, l, a, minArea) {
    const rotulo = new Int32Array(l * a).fill(-1), lista = [], pilha = new Int32Array(l * a);
    for (let s = 0; s < l * a; s++) {
      if (!mask[s] || rotulo[s] >= 0) continue;
      const id = lista.length;
      let topo = 0, area = 0, sx = 0, sy = 0;
      pilha[topo++] = s; rotulo[s] = id;
      while (topo) {
        const p = pilha[--topo], x = p % l, y = (p / l) | 0;
        area++; sx += x; sy += y;
        if (x > 0 && mask[p - 1] && rotulo[p - 1] < 0) { rotulo[p - 1] = id; pilha[topo++] = p - 1; }
        if (x < l - 1 && mask[p + 1] && rotulo[p + 1] < 0) { rotulo[p + 1] = id; pilha[topo++] = p + 1; }
        if (y > 0 && mask[p - l] && rotulo[p - l] < 0) { rotulo[p - l] = id; pilha[topo++] = p - l; }
        if (y < a - 1 && mask[p + l] && rotulo[p + l] < 0) { rotulo[p + l] = id; pilha[topo++] = p + l; }
      }
      lista.push({ id, area, cx: sx / area, cy: sy / area });
    }
    return { rotulo, lista, grandes: lista.filter(c => c.area >= minArea).sort((x, y) => y.area - x.area) };
  }
  function preencherBuracos(mask, l, a) {
    const n = l * a, fora = new Uint8Array(n), pilha = new Int32Array(n);
    let topo = 0;
    const empurra = p => { if (!mask[p] && !fora[p]) { fora[p] = 1; pilha[topo++] = p; } };
    for (let x = 0; x < l; x++) { empurra(x); empurra((a - 1) * l + x); }
    for (let y = 0; y < a; y++) { empurra(y * l); empurra(y * l + l - 1); }
    while (topo) {
      const p = pilha[--topo], x = p % l, y = (p / l) | 0;
      if (x > 0) empurra(p - 1); if (x < l - 1) empurra(p + 1);
      if (y > 0) empurra(p - l); if (y < a - 1) empurra(p + l);
    }
    const cheio = new Uint8Array(n);
    let area = 0, sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { if (!mask[i] && fora[i]) continue; cheio[i] = 1; area++; sx += i % l; sy += (i / l) | 0; }
    return { cheio, area, cx: sx / area, cy: sy / area };
  }

  /* ---------- ajuste direto de elipse (Halir & Flusser) ---------- */
  function inv3(m) {
    const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
    return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
            [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
            [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
  }
  const mul3 = (X, Y) => X.map((r, i) => [0, 1, 2].map(j => r[0] * Y[0][j] + r[1] * Y[1][j] + r[2] * Y[2][j]));
  const tr3 = X => [0, 1, 2].map(i => [X[0][i], X[1][i], X[2][i]]);
  
  function raizesCubica(p2, p1, p0) {               // λ³ + p2 λ² + p1 λ + p0 = 0, só as reais
    const p = p1 - p2 * p2 / 3, q = 2 * p2 ** 3 / 27 - p2 * p1 / 3 + p0, s = -p2 / 3;
    const disc = (q / 2) ** 2 + (p / 3) ** 3;
    if (Math.abs(p) < 1e-18) return [Math.cbrt(-q) + s];
    if (disc > 0) { const r = Math.sqrt(disc); return [Math.cbrt(-q / 2 + r) + Math.cbrt(-q / 2 - r) + s]; }
    const m = 2 * Math.sqrt(-p / 3), fi = Math.acos(Math.max(-1, Math.min(1, (3 * q) / (2 * p) * Math.sqrt(-3 / p)))) / 3;
    return [0, 1, 2].map(k => m * Math.cos(fi - 2 * Math.PI * k / 3) + s);
  }
  
  function vetorNulo(M) {                            // vetor do núcleo de uma 3×3 singular
    const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    let melhor = null, n0 = -1;
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
      const c = cr(M[i], M[j]), n = Math.hypot(...c);
      if (n > n0) { n0 = n; melhor = c; }
    }
    return n0 > 0 ? melhor.map(x => x / n0) : null;
  }
  
  function ajustarElipse(xs, ys, idx = null) {
    const n = idx ? idx.length : xs.length;
    if (n < 6) return null;
    const pega = k => idx ? idx[k] : k;
    let mx = 0, my = 0;
    for (let k = 0; k < n; k++) { mx += xs[pega(k)]; my += ys[pega(k)]; }
    mx /= n; my /= n;
    let sc = 0;
    for (let k = 0; k < n; k++) sc += (xs[pega(k)] - mx) ** 2 + (ys[pega(k)] - my) ** 2;
    sc = Math.sqrt(sc / n / 2) || 1;
    const S1 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], S2 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], S3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let k = 0; k < n; k++) {
      const X = (xs[pega(k)] - mx) / sc, Y = (ys[pega(k)] - my) / sc;
      const d1 = [X * X, X * Y, Y * Y], d2 = [X, Y, 1];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        S1[i][j] += d1[i] * d1[j]; S2[i][j] += d1[i] * d2[j]; S3[i][j] += d2[i] * d2[j];
      }
    }
    const S3i = inv3(S3); if (!S3i) return null;
    const T = mul3(S3i, tr3(S2)).map(r => r.map(v => -v));
    const M = S1.map((r, i) => r.map((v, j) => v + mul3(S2, T)[i][j]));
    const Mp = [M[2].map(v => v / 2), M[1].map(v => -v), M[0].map(v => v / 2)];
    const tr = Mp[0][0] + Mp[1][1] + Mp[2][2];
    const c = Mp[0][0] * Mp[1][1] - Mp[0][1] * Mp[1][0] + Mp[0][0] * Mp[2][2] - Mp[0][2] * Mp[2][0]
      + Mp[1][1] * Mp[2][2] - Mp[1][2] * Mp[2][1];
    const det = Mp[0][0] * (Mp[1][1] * Mp[2][2] - Mp[1][2] * Mp[2][1])
      - Mp[0][1] * (Mp[1][0] * Mp[2][2] - Mp[1][2] * Mp[2][0]) + Mp[0][2] * (Mp[1][0] * Mp[2][1] - Mp[1][1] * Mp[2][0]);
    let a1 = null;
    for (const lam of raizesCubica(-tr, c, -det)) {
      const v = vetorNulo(Mp.map((r, i) => r.map((x, j) => x - (i === j ? lam : 0))));
      if (v && 4 * v[0] * v[2] - v[1] * v[1] > 0) { a1 = v; break; }
    }
    if (!a1) return null;
    const a2 = T.map(r => r[0] * a1[0] + r[1] * a1[1] + r[2] * a1[2]);
    const [A, B, C] = a1, [D, E, F] = a2;
    const den = B * B - 4 * A * C;
    if (den >= 0) return null;
    const x0 = (2 * C * D - B * E) / den, y0 = (2 * A * E - B * D) / den;
    const F0 = F + (D * x0 + E * y0) / 2;
    const fi = 0.5 * Math.atan2(B, A - C), cf = Math.cos(fi), sf = Math.sin(fi);
    const Ap = A * cf * cf + B * sf * cf + C * sf * sf, Cp = A * sf * sf - B * sf * cf + C * cf * cf;
    if (!(-F0 / Ap > 0) || !(-F0 / Cp > 0)) return null;
    let e1 = Math.sqrt(-F0 / Ap), e2 = Math.sqrt(-F0 / Cp), th = fi;
    if (e2 > e1) { [e1, e2] = [e2, e1]; th = fi + Math.PI / 2; }
    return { cx: x0 * sc + mx, cy: y0 * sc + my, ea: e1 * sc, eb: e2 * sc, th };
  }

  /* ---------- forma: elipse robusta ou retângulo ---------- */
  function residuoElipse(e, x, y) {
    const dx = x - e.cx, dy = y - e.cy, c = Math.cos(e.th), s = Math.sin(e.th);
    const u = (dx * c + dy * s) / e.ea, v = (-dx * s + dy * c) / e.eb;
    return Math.abs(Math.sqrt(u * u + v * v) - 1);
  }
  function elipseValida(e, l, a) {
    return e && [e.cx, e.cy, e.ea, e.eb, e.th].every(Number.isFinite) && e.eb > 4 && e.ea < 3 * Math.max(l, a)
      && e.eb / e.ea > 0.2 && e.cx > -l && e.cx < 2 * l && e.cy > -a && e.cy < 2 * a;
  }

  /* Amostragem robusta: sorteia 6 pontos da borda, ajusta, conta quantos
     pontos concordam; fica com o melhor e refina com os que concordam. Comida
     transbordando a aba, guardanapo encostado ou um segundo prato viram pontos
     que discordam — e saem do ajuste. Semente fixa: sempre o mesmo resultado. */
  function elipseRobusta(xs, ys, l, a, iter) {
    const n = xs.length;
    if (n < 24) return null;
    let s = 20260922;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const passo = Math.max(1, Math.floor(n / 360));
    const conta = e => { let k = 0, t = 0; for (let i = 0; i < n; i += passo) { t++; if (residuoElipse(e, xs[i], ys[i]) < LIMIARES.tolBorda) k++; } return k / t; };
    let melhor = ajustarElipse(xs, ys), nota = elipseValida(melhor, l, a) ? conta(melhor) : -1;
    if (nota < 0) melhor = null;
    for (let it = 0; it < iter; it++) {
      const idx = [];
      for (let k = 0; k < 6; k++) idx.push(Math.floor(rnd() * n));
      const e = ajustarElipse(xs, ys, idx);
      if (!elipseValida(e, l, a)) continue;
      const v = conta(e);
      if (v > nota) { nota = v; melhor = e; }
    }
    if (!melhor) return null;
    for (let r = 0; r < 2; r++) {
      const idx = [];
      for (let i = 0; i < n; i++) if (residuoElipse(melhor, xs[i], ys[i]) < LIMIARES.tolBorda * 1.5) idx.push(i);
      if (idx.length < 24) break;
      const e = ajustarElipse(xs, ys, idx);
      if (elipseValida(e, l, a)) melhor = e;
    }
    let k = 0;
    for (let i = 0; i < n; i++) if (residuoElipse(melhor, xs[i], ys[i]) < LIMIARES.tolBorda) k++;
    return { forma: 'elipse', ...melhor, aderencia: k / n };
  }

  /* Retângulo (tábua, travessa): o menor retângulo que abraça a borda —
     varrendo o ângulo, porque um quadrado tem os mesmos momentos em qualquer
     rotação e o eixo principal não diz nada sobre ele. */
  function retangulo(xs, ys) {
    const n = xs.length;
    if (n < 24) return null;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    const passo = Math.max(1, Math.floor(n / 500));
    const extensao = th => {
      const c = Math.cos(th), s = Math.sin(th), P = [], Q = [];
      for (let i = 0; i < n; i += passo) { const dx = xs[i] - mx, dy = ys[i] - my; P.push(dx * c + dy * s); Q.push(-dx * s + dy * c); }
      P.sort((a, b) => a - b); Q.sort((a, b) => a - b);
      const q = (v, f) => v[Math.min(v.length - 1, Math.max(0, Math.round(f * (v.length - 1))))];
      const p0 = q(P, .01), p1 = q(P, .99), q0 = q(Q, .01), q1 = q(Q, .99);
      return { th, w: (p1 - p0) / 2, h: (q1 - q0) / 2, pc: (p0 + p1) / 2, qc: (q0 + q1) / 2 };
    };
    let melhor = null;
    for (let g = 0; g < 90; g += 3) { const r = extensao(g * Math.PI / 180); if (!melhor || r.w * r.h < melhor.w * melhor.h) melhor = r; }
    for (let g = -3; g <= 3; g += 0.5) { const r = extensao(melhor.th + g * Math.PI / 180); if (r.w * r.h < melhor.w * melhor.h) melhor = r; }
    if (!(melhor.w > 4 && melhor.h > 4)) return null;
    const c = Math.cos(melhor.th), s = Math.sin(melhor.th);
    const cx = mx + melhor.pc * c - melhor.qc * s, cy = my + melhor.pc * s + melhor.qc * c;
    const min = Math.min(melhor.w, melhor.h);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - cx, dy = ys[i] - cy, p = dx * c + dy * s, q = -dx * s + dy * c;
      if (Math.abs(Math.max(Math.abs(p) - melhor.w, Math.abs(q) - melhor.h)) / min < LIMIARES.tolBorda * 1.2) k++;
    }
    return { forma: 'retangulo', cx, cy, ea: melhor.w, eb: melhor.h, th: melhor.th, aderencia: k / n };
  }

  /* coordenadas da própria forma: (u,v) com a borda em raio 1 */
  function paraForma(F) {
    const c = Math.cos(F.th), s = Math.sin(F.th);
    return (x, y) => { const dx = x - F.cx, dy = y - F.cy; return [(dx * c + dy * s) / F.ea, (-dx * s + dy * c) / F.eb]; };
  }
  const raio = (F, u, v) => F.forma === 'elipse' ? Math.sqrt(u * u + v * v) : Math.max(Math.abs(u), Math.abs(v));

  /** fração da forma inteira que cai dentro do quadro (amostragem em grade) */
  function fracaoVisivel(F, l, a) {
    const c = Math.cos(F.th), s = Math.sin(F.th);
    let dentro = 0, total = 0;
    for (let i = -19; i <= 19; i += 2) for (let j = -19; j <= 19; j += 2) {
      const u = i / 20, v = j / 20;
      if (F.forma === 'elipse' && u * u + v * v > 1) continue;
      total++;
      const x = F.cx + u * F.ea * c - v * F.eb * s, y = F.cy + u * F.ea * s + v * F.eb * c;
      if (x >= 0 && y >= 0 && x < l && y < a) dentro++;
    }
    return total ? dentro / total : 0;
  }

  /* ---------- onde está o prato ---------- */
  function bordaDe(cheio, l, a) {
    const xs = [], ys = [];
    for (let y = 2; y < a - 2; y++) for (let x = 2; x < l - 2; x++) {
      const i = y * l + x;
      /* o que encosta na moldura da foto não é borda do prato: fica de fora,
         e é isso que deixa medir o prato cortado pelo quadro */
      if (cheio[i] && (!cheio[i - 1] || !cheio[i + 1] || !cheio[i - l] || !cheio[i + l])) { xs.push(x + .5); ys.push(y + .5); }
    }
    if (xs.length > 1600) {
      const p = xs.length / 1600, X = [], Y = [];
      for (let k = 0; k < 1600; k++) { const i = Math.floor(k * p); X.push(xs[i]); Y.push(ys[i]); }
      return { xs: X, ys: Y };
    }
    return { xs, ys };
  }

  function mediana(v) { const s = Array.from(v).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; }

  function candidatos(Lab, l, a, iter) {
    const { L, A, B } = Lab, n = l * a;
    const mascaras = [];
    /* 1: o que é mais claro que o resto (louça clara em mesa escura) */
    const limL = otsu(L, null, 0, 100);
    if (limL != null) { const m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = L[i] >= limL ? 1 : 0; mascaras.push(m); }
    /* 2: o que não é fundo — a cor de referência vem da moldura da foto, que
       quase sempre é mesa. Funciona com mesa clara, escura ou de madeira. */
    const anel = Math.max(2, Math.round(Math.min(l, a) * 0.04)), bL = [], bA = [], bB = [];
    for (let y = 0; y < a; y++) for (let x = 0; x < l; x++) {
      if (x >= anel && y >= anel && x < l - anel && y < a - anel) continue;
      if ((x + y) % 3) continue;
      const i = y * l + x; bL.push(L[i]); bA.push(A[i]); bB.push(B[i]);
    }
    const fL = mediana(bL), fA = mediana(bA), fB = mediana(bB);
    /* limiar pela mediana do desvio (MAD), e não por percentil: quando o
       prato encosta na moldura, parte da moldura é prato, e um percentil alto
       cai em cima dele — o limiar ia às alturas e a máscara vinha vazia. A
       mediana aguenta até metade da moldura tomada. */
    const mad = mediana(bL.map((v, k) => Math.hypot(v - fL, bA[k] - fA, bB[k] - fB)));
    const limF = Math.max(10, 5 * 1.4826 * mad);
    const mF = new Uint8Array(n);
    const lim2 = limF * limF;
    for (let i = 0; i < n; i++) { const d0 = L[i] - fL, d1 = A[i] - fA, d2 = B[i] - fB; mF[i] = d0 * d0 + d1 * d1 + d2 * d2 >= lim2 ? 1 : 0; }
    mascaras.push(mF);

    const achados = [];
    for (const m of mascaras) {
      const { rotulo, grandes } = componentes(m, l, a, n * 0.012);
      for (const g of grandes.slice(0, 3)) {
        const so = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (rotulo[i] === g.id) so[i] = 1;
        const obj = preencherBuracos(so, l, a);
        const { xs, ys } = bordaDe(obj.cheio, l, a);
        const e = elipseRobusta(xs, ys, l, a, iter);
        const r = retangulo(xs, ys);
        let F = e && (!r || e.aderencia >= r.aderencia - 0.03) ? e : r;
        if (!F) continue;
        const para = paraForma(F);
        /* cobertura: da forma ajustada, quanto o objeto de fato preenche —
           uma elipse "achada" dentro de uma mancha qualquer não passa */
        /* conta como coberto o que é do objeto OU não é mesa: comida que
           encosta na moldura fica fora do preenchimento de vãos, mas não é mesa */
        let dentro = 0, cheia = 0;
        for (let y = 0; y < a; y += 2) for (let x = 0; x < l; x += 2) {
          const [u, v] = para(x + .5, y + .5);
          if (raio(F, u, v) > 0.96) continue;
          const i = y * l + x;
          cheia++; if (obj.cheio[i] || mF[i]) dentro++;
        }
        const cobertura = cheia ? dentro / cheia : 0;
        const visivel = fracaoVisivel(F, l, a);
        const area = F.forma === 'elipse' ? Math.PI * F.ea * F.eb : 4 * F.ea * F.eb;
        const fr = area / n;
        const dc = Math.hypot(F.cx / l - .5, F.cy / a - .5) / 0.7071;
        const nota = F.aderencia * cobertura * (visivel >= LIMIARES.visivel ? 1 : 0.2)
          * (fr < 0.02 ? fr / 0.02 : fr > 1.2 ? 0.4 : 1) * (1 - 0.3 * Math.min(1, dc));
        achados.push({ F, cobertura, visivel, area, nota });
      }
    }
    achados.sort((x, y) => y.nota - x.nota);
    return achados;
  }

  /* ---------- medição ---------- */
  function medir(fonte, op = {}) {
    const img = amostrar(fonte, op.rapido ? LONGO_RAPIDO : LONGO);
    const l = img.width, a = img.height, n = l * a;
    const Lab = paraLab(img.data, n);
    const { L, A, B } = Lab;

    /* A forma é procurada em meia resolução: o ajuste usa centenas de pontos
       de borda e chega a fração de pixel mesmo com o contorno mais grosso.
       Corta ~4× o tempo da etapa mais cara; a medição continua em resolução
       cheia. */
    const meia = Math.max(l, a) >= 200 ? caixaPara(img, Math.max(1, l >> 1), Math.max(1, a >> 1)) : img;
    const kx = l / meia.width, ky = a / meia.height;
    const LabM = meia === img ? Lab : paraLab(meia.data, meia.width * meia.height);
    const achados = candidatos(LabM, meia.width, meia.height, op.rapido ? 24 : 60);
    const ok = achados.filter(c => c.F.aderencia >= LIMIARES.aderencia && c.cobertura >= LIMIARES.cobertura);
    if (!ok.length) return { falha: 'não achei a borda de um prato ou tábua — aproxime ou afaste um pouco', versao: VERSAO };
    const esc0 = ok[0];
    const F = { ...esc0.F, cx: esc0.F.cx * kx, cy: esc0.F.cy * ky, ea: esc0.F.ea * kx, eb: esc0.F.eb * ky };
    const { cobertura, visivel } = esc0;
    const area = F.forma === 'elipse' ? Math.PI * F.ea * F.eb : 4 * F.ea * F.eb;
    const contorno = { forma: F.forma, cx: +(F.cx / l).toFixed(4), cy: +(F.cy / a).toFixed(4),
      ea: +(F.ea / l).toFixed(4), eb: +(F.eb / l).toFixed(4), th: +F.th.toFixed(4) };
    if (visivel < LIMIARES.visivel)
      return { falha: `só ${Math.round(visivel * 100)}% do prato aparece — afaste ou centralize um pouco`, versao: VERSAO, contorno };
    const razao = F.forma === 'elipse' ? F.eb / F.ea : 1;
    if (razao < LIMIARES.razao)
      return { falha: `ângulo rasante demais (${razao.toFixed(2)}) — fotografe mais de cima`, versao: VERSAO, contorno };

    const para = paraForma(F);
    const U = new Float32Array(n), V = new Float32Array(n), dentro = new Uint8Array(n);
    let nDentro = 0;
    for (let y = 0; y < a; y++) for (let x = 0; x < l; x++) {
      const i = y * l + x, [u, v] = para(x + .5, y + .5);
      U[i] = u; V[i] = v;
      if (raio(F, u, v) <= 1) { dentro[i] = 1; nDentro++; }
    }

    /* a superfície: a cor da aba (ou da tábua), pelos pixels menos coloridos
       da faixa perto da borda — é contra ela que a comida se destaca */
    const aba = [];
    for (let i = 0; i < n; i++) { if (!dentro[i]) continue; const r = raio(F, U[i], V[i]); if (r >= 0.80 && r <= 0.95) aba.push(i); }
    const cromas = aba.map(i => Math.hypot(A[i], B[i])).sort((x, y) => x - y);
    const corteC = cromas[Math.floor(cromas.length * 0.4)] ?? 0;
    const sup = aba.filter(i => Math.hypot(A[i], B[i]) <= corteC);
    const sL = mediana(sup.map(i => L[i])), sA = mediana(sup.map(i => A[i])), sB = mediana(sup.map(i => B[i]));

    /* comida = o que difere da superfície (antes: só o que tinha croma, o que
       perdia pão, arroz e queijo claro) */
    const dE = new Float32Array(n);
    for (let i = 0; i < n; i++) if (dentro[i]) { const d0 = L[i] - sL, d1 = A[i] - sA, d2 = B[i] - sB; dE[i] = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2); }
    const limE = Math.max(12, otsu(dE, dentro, 0, 80) ?? 12);
    const comida = new Uint8Array(n);
    let nc = 0, su = 0, sv = 0, sr2 = 0, nb = 0, cL = 0, cA = 0, cB = 0, naMoldura = 0, claros = 0;
    let sL2 = 0, sHx = 0, sHy = 0;            // contraste (L²) e matiz (vetor unitário)
    /* Branco da casa: se a aba é neutra, ela vira a referência de branco.
       A correção é a de von Kries — um ganho por canal no RGB LINEAR —,
       porque luz colorida multiplica os canais; deslocar a cor em Lab (o que
       a primeira versão fazia) deixava um erro maior que o da luz. Se a aba
       estourou (canal em 255), a cor real do branco se perdeu e a correção
       mentiria: nesse caso ela não é aplicada, e a medição diz isso. */
    let rW = 0, gW = 0, bW = 0;
    const est = [0, 0, 0];
    for (const i of sup) {
      const p = i * 4, d = img.data;
      for (let c = 0; c < 3; c++) if (d[p + c] >= 254) est[c]++;
      rW += inv[d[p]]; gW += inv[d[p + 1]]; bW += inv[d[p + 2]];
    }
    const nS = Math.max(1, sup.length);
    rW /= nS; gW /= nS; bW /= nS;
    /* um canal estourado ainda corrige na direção certa (o valor lido fica
       abaixo do real, e o ganho sai só um pouco curto); dois ou três
       estourados, o branco se perdeu de vez */
    const canaisEstourados = est.filter(k => k / nS > 0.3).length;
    const abaEstourada = canaisEstourados >= 2;
    const correcaoParcial = canaisEstourados === 1;
    /* até croma 30 a aba conta como branca sob luz colorida; acima, é louça
       colorida de fato e corrigir por ela tingiria a comida */
    const wb = !abaEstourada && Math.hypot(sA, sB) < 30 && sL > 50 && rW > 0 && gW > 0 && bW > 0;
    const yW = 0.2126729 * rW + 0.7151522 * gW + 0.0721750 * bW;
    const esc = wb ? 0.7076 / yW : 1;                       // leva a aba a L* 88
    const gR = wb ? (yW / rW) * esc : 1, gG = wb ? (yW / gW) * esc : 1, gB = wb ? (yW / bW) * esc : 1;
    const labCorrigido = i => {
      const p = i * 4, d = img.data;
      const r = inv[d[p]] * gR, g = inv[d[p + 1]] * gG, bb = inv[d[p + 2]] * gB;
      const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * bb) / 0.95047;
      const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * bb;
      const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * bb) / 1.08883;
      const fx = f(x), fy = f(y), fz = f(z);
      return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
    };
    for (let i = 0; i < n; i++) {
      if (!dentro[i]) continue;
      if (L[i] > 98 || L[i] < 3) claros++;
      if (dE[i] < limE || raio(F, U[i], V[i]) > 0.97) continue;
      comida[i] = 1; nc++;
      const u = U[i], v = V[i];
      su += u; sv += v; sr2 += u * u + v * v;
      if (raio(F, u, v) > (F.forma === 'elipse' ? 0.74 : 0.8)) nb++;
      const cor = wb ? labCorrigido(i) : [L[i], A[i], B[i]];
      cL += cor[0]; cA += cor[1]; cB += cor[2];
      sL2 += cor[0] * cor[0];
      /* matiz como vetor unitário: a média dos vetores tem comprimento 1 se
         toda a comida tem o mesmo tom, e cai para 0 num prato de tons
         misturados. Soma circular, sem o salto de 360° para 0° */
      const cro = Math.hypot(cor[1], cor[2]);
      if (cro > 3) { sHx += cor[1] / cro; sHy += cor[2] / cro; }
      const x = i % l, y = (i / l) | 0;
      if (x === 0 || y === 0 || x === l - 1 || y === a - 1) naMoldura++;
    }
    /* Comida ÷ prato, ambos contados só na parte que aparece no quadro. Antes
       dividia pela área do prato inteiro reconstruído enquanto contava só a
       comida visível: bastava o prato sair um pouco do quadro para a ocupação
       despencar, e o prato deixava de ser reconhecido. */
    const ocupacao = nc / Math.max(1, nDentro);
    if (ocupacao < LIMIARES.comidaMin)
      return { falha: `só ${(ocupacao * 100).toFixed(1)}% do prato tem comida — prato vazio ou contra a luz`, versao: VERSAO, contorno };

    const comp = componentes(comida, l, a, area * 0.005);
    /* Passo da textura: 1/55 do raio do prato — fracionário, com leitura
       interpolada. Arredondar para pixel inteiro fazia a textura mudar em
       degraus quando o prato ficava pequeno na foto (0,014 entre 320 px e
       480 px de largura); com passo fracionário, a escala é a mesma sempre. */
    const passo = Math.max(1, F.ea / 55);
    const passoI = Math.ceil(passo);
    const amostraL = (x, y) => {
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const i00 = y0 * l + x0;
      return (1 - fx) * (1 - fy) * L[i00] + fx * (1 - fy) * L[i00 + 1] +
        (1 - fx) * fy * L[i00 + l] + fx * fy * L[i00 + l + 1];
    };
    let sLap = 0, sLap2 = 0, nLap = 0, sGrad = 0, nGrad = 0, sLc = 0, sLc2 = 0, nLc = 0;
    for (let y = 1; y < a - 1; y++) for (let x = 1; x < l - 1; x++) {
      const i = y * l + x; if (!dentro[i]) continue;
      const v = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - l] - L[i + l];
      sLap += v; sLap2 += v * v; nLap++;
      /* textura: quanto a luz varia DENTRO da comida, medida em escala do
         PRATO e não em pixels da foto — o passo é proporcional ao raio, então
         a mesma comida dá a mesma textura de perto, de longe, em 320 px ou em
         4000 px. Só conta quando os vizinhos também são comida, senão a
         silhueta domina. */
      const j1 = i - passoI, j2 = i + passoI, j3 = i - passoI * l, j4 = i + passoI * l;
      if (x >= passoI + 1 && x < l - passoI - 1 && y >= passoI + 1 && y < a - passoI - 1 &&
          comida[i] && comida[j1] && comida[j2] && comida[j3] && comida[j4]) {
        sGrad += Math.hypot(amostraL(x + passo, y) - amostraL(x - passo, y),
          amostraL(x, y + passo) - amostraL(x, y - passo)) / 2;
        nGrad++;
        if (!((x % passoI) || (y % passoI))) { sLc += L[i]; sLc2 += L[i] * L[i]; nLc++; }
      }
    }
    const nitidez = nLap > 1 ? sLap2 / nLap - (sLap / nLap) ** 2 : 0;
    const comidaCortada = trava(naMoldura / (2 * Math.sqrt(Math.PI * nc)));
    const norm = F.forma === 'elipse' ? 1 : Math.SQRT2;

    const m = {
      ocupacao: +trava(ocupacao).toFixed(6),
      centragem: +trava(Math.hypot(su / nc, sv / nc) / norm).toFixed(6),
      dispersao: +trava(Math.sqrt(sr2 / nc) / norm).toFixed(6),
      elementos: +trava(comp.grandes.length / 8).toFixed(6),
      borda: +trava(nb / nc).toFixed(6),
      luminancia: +trava(cL / nc / 100).toFixed(6),
      cromaA: +trava((cA / nc + 60) / 120).toFixed(6),
      cromaB: +trava((cB / nc + 60) / 120).toFixed(6),
      textura: +trava((nGrad ? sGrad / nGrad : 0) / 25).toFixed(6),
      /* contraste na mesma escala da textura: amostrado de passo em passo, o
         valor deixa de depender de quantos pixels o prato ocupa */
      contraste: +trava(Math.sqrt(Math.max(0, nLc ? sLc2 / nLc - (sLc / nLc) ** 2 : 0)) / 40).toFixed(6),
      matiz: +trava(Math.hypot(sHx, sHy) / nc).toFixed(6)
    };
    /* Peso de cada grandeza nesta foto: o quanto ela merece confiança AQUI.
       Prato cortado pelo quadro derruba as de posição, mas não as de cor; foto
       borrada derruba textura e contraste; louça estourada derruba cor. É isto
       que faz o enquadramento deixar de ser exigência: o que não dá para medir
       direito simplesmente pesa menos, em vez de reprovar a foto inteira. */
    const estouro = Math.min(0.5, claros / Math.max(1, nDentro));
    const wPos = trava(((visivel - 0.3) / 0.7) ** 2 * (1 - trava(comidaCortada * 2)));
    const wCor = trava((wb ? 1 : 0.85) * (1 - 2 * estouro));
    const wTex = trava(Math.min(1, nitidez / 8) * (1 - estouro));
    const pesos = {
      /* ocupação sobrevive ao corte (é razão entre áreas visíveis); contar
         elementos, não: pedaço que ficou fora do quadro não é elemento a menos */
      ocupacao: +(0.15 + 0.85 * wPos).toFixed(3),
      centragem: +wPos.toFixed(3), dispersao: +wPos.toFixed(3),
      elementos: +(wPos * wPos).toFixed(3), borda: +wPos.toFixed(3),
      /* a cor média da comida muda um pouco quando falta um pedaço dela, e o
         matiz muda mais (depende de QUAL parte ficou no quadro) */
      luminancia: +(wCor * (0.55 + 0.45 * wPos)).toFixed(3),
      cromaA: +(wCor * (0.55 + 0.45 * wPos)).toFixed(3),
      cromaB: +(wCor * (0.55 + 0.45 * wPos)).toFixed(3),
      matiz: +(wCor * (0.35 + 0.65 * wPos)).toFixed(3),
      textura: +wTex.toFixed(3), contraste: +wTex.toFixed(3)
    };

    const qualidade = +(F.aderencia * cobertura * Math.min(1, visivel / 0.9)
      * Math.sqrt(nitidez / (nitidez + 4)) * (1 - Math.min(0.5, claros / Math.max(1, nDentro)))).toFixed(3);

    return {
      versao: VERSAO, m, pesos, forma: F.forma, qualidade, contorno,
      aderencia: +F.aderencia.toFixed(3), cobertura: +cobertura.toFixed(3),
      visivel: +visivel.toFixed(3), comidaCortada: +comidaCortada.toFixed(3),
      /* folga extra para o servidor quando parte da comida ficou fora do
         quadro: as grandezas de posição passam a valer menos */
      inflar: +(1 + 3 * comidaCortada).toFixed(3),
      razaoElipse: +razao.toFixed(3), correcaoDeLuz: wb,
      nitidez: +nitidez.toFixed(2), raioPrato: +F.ea.toFixed(1),
      raioRel: contorno.ea, centro: { x: contorno.cx, y: contorno.cy },
      elementosBrutos: comp.grandes.length, largura: l, altura: a,
      ressalvas: [
        visivel < 0.97 ? `${Math.round((1 - visivel) * 100)}% do prato fora do quadro — reconstruído pela borda que aparece` : null,
        comidaCortada > 0.05 ? 'parte da comida saiu do quadro — as medidas de posição valem menos' : null,
        razao < 0.75 ? `foto inclinada (${razao.toFixed(2)}) — corrigida pela elipse do prato` : null,
        abaEstourada ? 'a louça estourou de luz — sem correção de cor; afaste da luz direta' :
          correcaoParcial && wb ? 'louça estourada em um canal — correção de luz parcial' :
          !wb ? (F.forma === 'retangulo' ? 'tábua ou travessa: sem correção de luz pela louça' : 'louça colorida: sem correção de luz') : null,
        nitidez < 4 ? 'foto pouco nítida' : null,
        comp.grandes.length > 6 ? 'muitos elementos soltos' : null
      ].filter(Boolean)
    };
  }

  /* média de vários quadros do mesmo prato */
  function media(lista) {
    const ok = lista.filter(r => r && !r.falha);
    if (!ok.length) return lista.find(r => r && r.falha) || { falha: 'nenhum quadro mediu', versao: VERSAO };
    if (ok.length === 1) return { ...ok[0], quadros: 1, oscilacao: 0 };
    const m = {};
    let osc = 0;
    for (const k of CHAVES) {
      const v = ok.map(r => r.m[k]), med = v.reduce((x, y) => x + y, 0) / v.length;
      m[k] = +med.toFixed(6);
      osc = Math.max(osc, Math.sqrt(v.reduce((x, y) => x + (y - med) ** 2, 0) / v.length));
    }
    const base = ok[ok.length - 1];
    /* peso da média: o menor entre os quadros — se um quadro saiu borrado, a
       textura daquela foto não vale tanto quanto a dos outros */
    const pesos = {};
    for (const k of CHAVES) pesos[k] = Math.min(...ok.map(r => (r.pesos ? r.pesos[k] : 1)));
    return { ...base, m, pesos, quadros: ok.length, oscilacao: +osc.toFixed(4),
      nitidez: Math.min(...ok.map(r => r.nitidez)), qualidade: Math.min(...ok.map(r => r.qualidade)),
      visivel: Math.min(...ok.map(r => r.visivel)), inflar: Math.max(...ok.map(r => r.inflar)),
      ressalvas: [...base.ressalvas, ...(osc > 0.03 ? ['os quadros variaram — a mão ou o prato mexeram'] : [])] };
  }

  raiz.Nucleo = { VERSAO, CHAVES, medir, media, otsu, componentes, paraLab, caixa, redimensionar,
    preencherBuracos, ajustarElipse, LARG, LONGO, LIMIARES };
})(typeof window !== 'undefined' ? window : globalThis);
