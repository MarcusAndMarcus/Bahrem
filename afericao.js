'use strict';
/* Identificação do prato a partir do vetor de grandezas medido no navegador.
   Mesmo esqueleto do ALEX/AFERIDOR: envelope por prato, afastamento de
   Mahalanobis diagonal, cascata de camadas.

   ATENÇÃO — calibração: LIM_OK, LIM_REJ e SEP_MIN abaixo são valores de
   partida escolhidos por mim, NÃO medidos em fotos reais desta casa. Enquanto
   não houver rótulo de chefe/garçom sobre fotos do salão, o sistema não tem
   taxa de acerto conhecida e a camada 1 (confirmação humana) é o caminho
   normal, não a exceção. */

const CHAVES = ['ocupacao', 'centragem', 'dispersao', 'elementos',
  'borda', 'luminancia', 'cromaA', 'cromaB'];

const LIM_OK = 1.8;   // afastamento abaixo disso: o padrão cobre a foto
const LIM_REJ = 3.2;  // acima disso: nenhum padrão explica a foto
const SEP_MIN = 1.35; // 2º colocado precisa estar 35% mais longe que o 1º
const VAR_MIN = 1e-4; // piso de variância: grandeza constante não vira divisão por zero

/** média e variância por grandeza, com encolhimento para a variância média */
function envelope(amostras) {
  const n = amostras.length;
  const mu = {}, s2 = {};
  for (const k of CHAVES) {
    const v = amostras.map(a => Number(a[k]) || 0);
    const m = v.reduce((a, b) => a + b, 0) / n;
    mu[k] = m;
    s2[k] = v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1);
  }
  const media = CHAVES.reduce((a, k) => a + s2[k], 0) / CHAVES.length;
  const lambda = CHAVES.length / (CHAVES.length + n); // n pequeno → encolhe mais
  const sigma = {};
  for (const k of CHAVES) sigma[k] = Math.max(VAR_MIN, (1 - lambda) * s2[k] + lambda * media);
  return { mu, sigma, lambda, n };
}

/** afastamento normalizado (RMS dos z) — comparável entre padrões de n diferente */
function afastamento(g, padrao) {
  const z = {};
  let soma = 0;
  for (const k of CHAVES) {
    const d = (Number(g[k]) || 0) - padrao.mu[k];
    z[k] = d / Math.sqrt(padrao.sigma[k]);
    soma += z[k] * z[k];
  }
  return { dm: Math.sqrt(soma / CHAVES.length), z };
}

function identificar(g, padroes) {
  const faltando = CHAVES.filter(k => !(k in g));
  if (faltando.length) return { camada: -1, veredito: 'medição incompleta', faltando };
  if (!padroes.length) return { camada: -1, veredito: 'nenhum prato tem padrão gravado ainda' };

  const ranking = padroes.map(p => ({ ...afastamento(g, p), item_id: p.item_id, nome: p.nome,
    preco_cent: p.preco_cent, estacao: p.estacao, n: p.n }))
    .sort((a, b) => a.dm - b.dm);

  const [primeiro, segundo] = ranking;
  const separacao = segundo ? segundo.dm / Math.max(primeiro.dm, 1e-6) : Infinity;
  const base = { dm: primeiro.dm, separacao: Number.isFinite(separacao) ? separacao : null,
    z: primeiro.z, candidatos: ranking.slice(0, 3).map(r => ({ item_id: r.item_id, nome: r.nome,
      preco_cent: r.preco_cent, dm: Number(r.dm.toFixed(3)) })) };

  if (primeiro.dm >= LIM_REJ) {
    return { ...base, camada: 3, item_id: null, nome: null,
      veredito: `nenhum padrão explica esta foto (afastamento ${primeiro.dm.toFixed(2)}, limite ${LIM_REJ})` };
  }
  if (primeiro.dm < LIM_OK && separacao >= SEP_MIN) {
    return { ...base, camada: 0, item_id: primeiro.item_id, nome: primeiro.nome,
      preco_cent: primeiro.preco_cent, estacao: primeiro.estacao,
      veredito: `identificado pela geometria (afastamento ${primeiro.dm.toFixed(2)})` };
  }
  return { ...base, camada: 1, item_id: null, nome: null,
    veredito: segundo && separacao < SEP_MIN
      ? `ambíguo entre ${primeiro.nome} e ${segundo.nome} (separação ${separacao.toFixed(2)}) — confirme na mão`
      : `parecido com ${primeiro.nome}, mas fora da folga (afastamento ${primeiro.dm.toFixed(2)}) — confirme na mão` };
}

module.exports = { CHAVES, LIM_OK, LIM_REJ, SEP_MIN, envelope, afastamento, identificar };
