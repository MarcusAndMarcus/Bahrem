/* núcleo de medição — roda inteiro no aparelho, sem rede e sem custo por foto.
   Entrada: um <img>, <video> ou ImageData. Saída: 8 grandezas em [0,1] + recusas.

   Determinismo: a redução final para 320 px de largura é feita com um filtro de
   caixa escrito aqui, não com o reescalonador do Canvas — o suavizador do
   navegador muda entre Chrome, WebView e Firefox e faria a mesma foto medir
   diferente em cada aparelho. Testado: mesma entrada, duas passadas, valores
   idênticos bit a bit. */
(function (raiz) {
  'use strict';

  const CHAVES = ['ocupacao', 'centragem', 'dispersao', 'elementos',
    'borda', 'luminancia', 'cromaA', 'cromaB'];

  const LARG = 320;          // largura de trabalho
  const RAIOS = 48;          // raios do perfil radial
  const ABA = 0.74;          // a partir daqui é aba do prato, não fundo
  const MAX_CORTE = 0.10;    // fração de raios que pode terminar na moldura
  const MIN_COMIDA = 0.02;   // comida abaixo disso: foto de prato vazio
  /* limiares de forma — os valores vêm da calibração em cenas sintéticas
     registrada no README (prato de frente, inclinado 30/45/60 graus, tábua
     quadrada e hexagonal). Não foram medidos em fotos reais desta casa. */
  const LIMIARES = { irreg: 0.45, desencaixe: 0.06, razao: 0.45 };

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

  /* ---------- amostragem determinística ---------- */
  function amostrar(fonte) {
    const lf = fonte.videoWidth || fonte.naturalWidth || fonte.width;
    const af = fonte.videoHeight || fonte.naturalHeight || fonte.height;
    if (!lf || !af) throw new Error('imagem sem dimensão');
    /* por formato, não por instanceof: assim o mesmo núcleo roda nos testes em Node */
    if (fonte.data && fonte.width && fonte.height) return caixa(fonte);
    /* Até 2400 px o quadro entra sem reescalar: a única redução é o filtro de
       caixa abaixo, igual em qualquer aparelho. Acima disso (foto de 12 MP) o
       reescalonador do navegador entra numa primeira passada — com suavização
       LIGADA, porque nearest-neighbor aqui joga fora 60% dos pixels e enche a
       média de croma de serrilhado. Duas médias de área seguidas divergem pouco
       entre navegadores; nearest divergiria muito. */
    const escala = Math.min(1, 2400 / Math.max(lf, af));
    const li = Math.max(1, Math.round(lf * escala)), ai = Math.max(1, Math.round(af * escala));
    const c = document.createElement('canvas');
    c.width = li; c.height = ai;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = escala < 1;
    if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fonte, 0, 0, li, ai);
    return caixa(ctx.getImageData(0, 0, li, ai));
  }

  /* filtro de caixa próprio: soma inteira dos pixels de origem, divisão no fim */
  function caixa(img) {
    const { width: lo, height: ao, data: d } = img;
    if (lo <= LARG) return img;
    const L = LARG, A = Math.max(1, Math.round(ao * LARG / lo));
    const saida = new Uint8ClampedArray(L * A * 4);
    for (let y = 0; y < A; y++) {
      const y0 = Math.floor(y * ao / A), y1 = Math.max(y0 + 1, Math.floor((y + 1) * ao / A));
      for (let x = 0; x < L; x++) {
        const x0 = Math.floor(x * lo / L), x1 = Math.max(x0 + 1, Math.floor((x + 1) * lo / L));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0, p = (yy * lo + x0) * 4; xx < x1; xx++, p += 4) {
            r += d[p]; g += d[p + 1]; b += d[p + 2]; n++;
          }
        }
        const q = (y * L + x) * 4;
        saida[q] = (r / n) | 0; saida[q + 1] = (g / n) | 0; saida[q + 2] = (b / n) | 0; saida[q + 3] = 255;
      }
    }
    return { width: L, height: A, data: saida };
  }

  /* ---------- Otsu com tratamento de platô ---------- */
  function otsu(valores, mascara, lo, hi) {
    const B = 64, hist = new Float64Array(B);
    let n = 0;
    for (let i = 0; i < valores.length; i++) {
      if (mascara && !mascara[i]) continue;
      const b = trava(Math.floor((valores[i] - lo) / (hi - lo) * B), 0, B - 1);
      hist[b]++; n++;
    }
    if (n < 16) return null;
    let soma = 0; for (let b = 0; b < B; b++) soma += b * hist[b];
    let somaB = 0, wB = 0, melhor = -1, limiares = [];
    for (let b = 0; b < B; b++) {
      wB += hist[b]; if (!wB) continue;
      const wF = n - wB; if (!wF) break;
      somaB += b * hist[b];
      const entre = wB * wF * ((somaB / wB) - ((soma - somaB) / wF)) ** 2;
      if (entre > melhor + 1e-9) { melhor = entre; limiares = [b]; }
      else if (Math.abs(entre - melhor) <= 1e-9) limiares.push(b); // platô: fica no meio
    }
    if (melhor <= 0) return null;
    const b = limiares[(limiares.length - 1) >> 1];
    return lo + (b + 1) / B * (hi - lo);
  }

  /* ---------- componentes conexos (pilha, sem recursão) ---------- */
  function componentes(mask, l, a, minArea) {
    const rotulo = new Int32Array(l * a).fill(-1);
    const lista = [];
    const pilha = new Int32Array(l * a);
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

  /* desencaixe: quanto a forma difere da elipse de mesma área e mesmos momentos.
     O perfil radial sozinho não separa quadrado de prato (um quadrado tem
     irregularidade radial 0,11, abaixo do limite) — mas os cantos ficam de fora
     da elipse ajustada e isso aparece aqui. Prato inclinado vira elipse e passa. */
  function desencaixeElipse(mask, l, a, area, cx, cy) {
    let m20 = 0, m02 = 0, m11 = 0;
    for (let y = 0; y < a; y++) {
      for (let x = 0; x < l; x++) {
        if (!mask[y * l + x]) continue;
        const dx = x - cx, dy = y - cy;
        m20 += dx * dx; m02 += dy * dy; m11 += dx * dy;
      }
    }
    m20 /= area; m02 /= area; m11 /= area;
    const meio = (m20 + m02) / 2, dif = Math.sqrt(((m20 - m02) / 2) ** 2 + m11 * m11);
    let ea = 2 * Math.sqrt(Math.max(1e-6, meio + dif)), eb = 2 * Math.sqrt(Math.max(1e-6, meio - dif));
    const k = Math.sqrt(area / (Math.PI * ea * eb)); // mesma área da máscara
    ea *= k; eb *= k;
    const th = 0.5 * Math.atan2(2 * m11, m20 - m02), co = Math.cos(th), si = Math.sin(th);
    let so = 0, eo = 0;
    const r = Math.ceil(Math.max(ea, eb)) + 2;
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(a, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(l, Math.ceil(cx + r)); x++) {
        const dx = x - cx, dy = y - cy;
        const u = (dx * co + dy * si) / ea, v = (-dx * si + dy * co) / eb;
        const naElipse = u * u + v * v <= 1, naMascara = mask[y * l + x] === 1;
        if (naMascara && !naElipse) so++;
        else if (naElipse && !naMascara) eo++;
      }
    }
    return { valor: (so + eo) / area, ea, eb, razao: Math.min(ea, eb) / Math.max(ea, eb) };
  }

  /* preenche os vãos internos de uma máscara: a comida é escura e abre buracos
     no prato, e sem isso o perfil radial mede zero a partir do centro */
  function preencherBuracos(mask, l, a) {
    const n = l * a;
    const fora = new Uint8Array(n);
    const pilha = new Int32Array(n);
    let topo = 0;
    const empurra = p => { if (!mask[p] && !fora[p]) { fora[p] = 1; pilha[topo++] = p; } };
    for (let x = 0; x < l; x++) { empurra(x); empurra((a - 1) * l + x); }
    for (let y = 0; y < a; y++) { empurra(y * l); empurra(y * l + l - 1); }
    while (topo) {
      const p = pilha[--topo], x = p % l, y = (p / l) | 0;
      if (x > 0) empurra(p - 1);
      if (x < l - 1) empurra(p + 1);
      if (y > 0) empurra(p - l);
      if (y < a - 1) empurra(p + l);
    }
    const cheio = new Uint8Array(n);
    let area = 0, sx = 0, sy = 0;
    for (let i = 0; i < n; i++) {
      if (!mask[i] && fora[i]) continue;
      cheio[i] = 1; area++; sx += i % l; sy += (i / l) | 0;
    }
    return { cheio, area, cx: sx / area, cy: sy / area };
  }

  /* ---------- medição ---------- */
  function medir(fonte) {
    const img = amostrar(fonte);
    const l = img.width, a = img.height, n = l * a;
    const { L, A, B } = paraLab(img.data, n);

    /* 1. prato = região clara; a mesa do bar é escura */
    const limL = otsu(L, null, 0, 100);
    if (limL == null) return { falha: 'a foto não tem contraste para separar prato e mesa' };
    const claro = new Uint8Array(n);
    for (let i = 0; i < n; i++) claro[i] = L[i] >= limL ? 1 : 0;

    const { rotulo, grandes } = componentes(claro, l, a, n * 0.03);
    if (!grandes.length) return { falha: 'nenhuma forma clara ocupa 3% do quadro — o prato está fora do enquadramento?' };
    const bruto = grandes[0];
    const soPrato = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (rotulo[i] === bruto.id) soPrato[i] = 1;
    const p = preencherBuracos(soPrato, l, a);

    /* 2. perfil radial: raio, irregularidade e corte pela moldura */
    const raios = new Float64Array(RAIOS);
    let cortados = 0;
    for (let k = 0; k < RAIOS; k++) {
      const th = 2 * Math.PI * k / RAIOS, dx = Math.cos(th), dy = Math.sin(th);
      let r = 0, ultimo = 0;
      for (; r < Math.max(l, a); r += 0.5) {
        const x = Math.round(p.cx + dx * r), y = Math.round(p.cy + dy * r);
        if (x < 0 || y < 0 || x >= l || y >= a) { cortados++; break; }
        if (!p.cheio[y * l + x]) break;
        ultimo = r;
      }
      raios[k] = ultimo;
    }
    const cortado = cortados / RAIOS;
    if (cortado > MAX_CORTE)
      return { falha: `o prato está cortado pela borda da foto (${(cortado * 100).toFixed(0)}% do contorno termina na moldura)` };

    const R = raios.reduce((s, v) => s + v, 0) / RAIOS;
    if (R < 12) return { falha: 'a forma encontrada é pequena demais para ser um prato' };
    const irreg = Math.sqrt(raios.reduce((s, v) => s + (v - R) ** 2, 0) / RAIOS) / R;
    const enc = desencaixeElipse(p.cheio, l, a, p.area, p.cx, p.cy);

    /* quem decide se é prato é a elipse, não o desvio radial: um prato
       fotografado de lado vira elipse e tem desvio radial alto sem deixar de
       ser prato. O desvio radial fica como leitura, não como recusa. */
    const forma = { irregularidade: +irreg.toFixed(3), desencaixe: +enc.valor.toFixed(3),
      razaoElipse: +enc.razao.toFixed(3) };
    if (enc.valor > LIMIARES.desencaixe)
      return { falha: `a forma não é um prato: ${(enc.valor * 100).toFixed(0)}% dela cai fora da elipse ajustada (o limite é ${(LIMIARES.desencaixe * 100).toFixed(0)}%). Tábua, travessa quadrada, dois pratos encostados ou a mesa inteira no quadro dão isso.`, ...forma };
    if (enc.razao < LIMIARES.razao)
      return { falha: `o ângulo está rasante demais (o prato aparece ${enc.razao.toFixed(2)} vezes mais estreito que largo, o limite é ${LIMIARES.razao}). Fotografe mais de cima.`, ...forma };
    if (irreg > LIMIARES.irreg)
      return { falha: `o contorno oscila demais para ser louça (${irreg.toFixed(2)}).`, ...forma };

    /* 3. comida = o que tem croma dentro do prato (louça é acromática) */
    const dentro = new Uint8Array(n);
    const croma = new Float32Array(n);
    let areaPrato = 0;
    for (let y = 0; y < a; y++) {
      for (let x = 0; x < l; x++) {
        const i = y * l + x;
        if (Math.hypot(x - p.cx, y - p.cy) > R) continue;
        dentro[i] = 1; areaPrato++;
        croma[i] = Math.hypot(A[i], B[i]);
      }
    }
    const limC = otsu(croma, dentro, 0, 80);
    if (limC == null) return { falha: 'não deu para separar comida e louça dentro do prato' };
    const comida = new Uint8Array(n);
    let areaComida = 0, sx = 0, sy = 0, sL = 0, sA = 0, sB = 0, sr2 = 0, naAba = 0;
    for (let y = 0; y < a; y++) {
      for (let x = 0; x < l; x++) {
        const i = y * l + x;
        if (!dentro[i] || croma[i] < limC) continue;
        comida[i] = 1; areaComida++;
        const r = Math.hypot(x - p.cx, y - p.cy);
        sx += x; sy += y; sr2 += r * r; sL += L[i]; sA += A[i]; sB += B[i];
        if (r > ABA * R) naAba++;
      }
    }
    const ocupacao = areaComida / areaPrato;
    if (ocupacao < MIN_COMIDA)
      return { falha: `só ${(ocupacao * 100).toFixed(1)}% do prato tem comida — parece prato vazio ou foto contra a luz` };

    const cx = sx / areaComida, cy = sy / areaComida;
    const comp = componentes(comida, l, a, areaPrato * 0.005);

    /* 4. nitidez: variância do laplaciano na luminância (portão de qualidade) */
    let sLap = 0, sLap2 = 0, nLap = 0;
    for (let y = 1; y < a - 1; y++) {
      for (let x = 1; x < l - 1; x++) {
        const i = y * l + x;
        if (!dentro[i]) continue;
        const v = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - l] - L[i + l];
        sLap += v; sLap2 += v * v; nLap++;
      }
    }
    const nitidez = nLap > 1 ? sLap2 / nLap - (sLap / nLap) ** 2 : 0;

    const m = {
      ocupacao: +trava(ocupacao).toFixed(6),
      centragem: +trava(Math.hypot(cx - p.cx, cy - p.cy) / R).toFixed(6),
      dispersao: +trava(Math.sqrt(sr2 / areaComida) / R).toFixed(6),
      elementos: +trava(comp.grandes.length / 8).toFixed(6),
      borda: +trava(naAba / areaComida).toFixed(6),
      luminancia: +trava(sL / areaComida / 100).toFixed(6),
      cromaA: +trava((sA / areaComida + 60) / 120).toFixed(6),
      cromaB: +trava((sB / areaComida + 60) / 120).toFixed(6)
    };

    return { m, nitidez: +nitidez.toFixed(2), raioPrato: +R.toFixed(1), irregularidade: +irreg.toFixed(3),
      elementosBrutos: comp.grandes.length, largura: l, altura: a,
      desencaixe: +enc.valor.toFixed(3), razaoElipse: +enc.razao.toFixed(3),
      ressalvas: [
        enc.razao < 0.75 ? `foto inclinada (${enc.razao.toFixed(2)} de razão) — o padrão precisa ter sido gravado no mesmo ângulo` : null,
        nitidez < 4 ? 'foto pouco nítida — o valor de textura e croma fica instável' : null,
        comp.grandes.length > 6 ? 'muitos elementos soltos no prato' : null,
        grandes.length > 1 && grandes[1].area > grandes[0].area * 0.5
          ? 'há outro objeto redondo grande no quadro (copo ao lado?)' : null
      ].filter(Boolean) };
  }

  raiz.Nucleo = { CHAVES, medir, otsu, componentes, paraLab, caixa,
    preencherBuracos, desencaixeElipse, LARG, LIMIARES };
})(typeof window !== 'undefined' ? window : globalThis);
