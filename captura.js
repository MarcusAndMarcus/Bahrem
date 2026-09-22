/* Captura automática — decide QUANDO fotografar, sem tela e sem câmera.

   Fica separada da página de propósito: é a parte que, errando, lança o
   mesmo prato duas vezes na conta de alguém. Aqui ela é uma função pura de
   "o que o guia viu agora" para "o que fazer", e os testes percorrem as
   sequências uma a uma.

   Regras:
   - fotografa quando o prato fica PARADO e bem lido por um tempo (estável);
   - depois de fotografar, TRAVA: só volta a fotografar quando o prato sai do
     quadro, ou quando o que está no quadro claramente mudou (outro prato);
   - no modo ensinar, a trava é mais curta: basta mexer um pouco o prato e
     esperar um instante — o padrão precisa de fotos levemente diferentes. */
(function (raiz) {
  'use strict';

  const PADRAO = {
    quadrosEstaveis: 4,       // leituras seguidas boas e paradas
    movimentoMax: 0.03,       // deslocamento do centro entre leituras (fração do quadro)
    escalaMax: 0.08,          // variação relativa do tamanho entre leituras
    qualidadeMin: 0.5,
    ausenciaParaSoltar: 1200, // ms sem prato para destravar
    trocaCentro: 0.25,        // centro andou isso: é outro prato
    trocaEscala: 0.35,        // tamanho mudou isso: é outro prato
    ensinarIntervalo: 1500,   // no modo ensinar: tempo mínimo entre fotos
    ensinarMexida: 0.02       // e o quanto o prato precisa ter mexido
  };

  function nova(op = {}) {
    const cfg = { ...PADRAO, ...op };
    let historico = [];         // leituras boas recentes
    let travadoEm = null;       // contorno da última foto
    let ultimaFotoEm = -Infinity;
    let semPratoDesde = null;
    let ensinar = false;

    const bom = r => r && !r.falha && r.contorno && (r.qualidade ?? 1) >= cfg.qualidadeMin;
    const dist = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
    const escala = (a, b) => Math.abs(a.ea - b.ea) / Math.max(a.ea, b.ea, 1e-6);

    function estavel() {
      if (historico.length < cfg.quadrosEstaveis) return false;
      const ult = historico.slice(-cfg.quadrosEstaveis);
      for (let i = 1; i < ult.length; i++) {
        if (ult[i].forma !== ult[0].forma) return false;
        if (dist(ult[i], ult[i - 1]) > cfg.movimentoMax) return false;
        if (escala(ult[i], ult[i - 1]) > cfg.escalaMax) return false;
      }
      return true;
    }

    /** o guia leu um quadro; devolve 'capturar' ou o estado para a tela */
    function observar(r, agora) {
      if (!bom(r)) {
        historico = [];
        if (semPratoDesde == null) semPratoDesde = agora;
        /* prato saiu do quadro por tempo suficiente: destrava */
        if (travadoEm && agora - semPratoDesde >= cfg.ausenciaParaSoltar) travadoEm = null;
        return { acao: 'nada', estado: r && r.falha ? 'recusa' : 'procurando', progresso: 0 };
      }
      semPratoDesde = null;
      const c = { ...r.contorno, forma: r.forma };
      historico.push(c);
      if (historico.length > 12) historico.shift();

      if (travadoEm) {
        if (ensinar) {
          const mexeu = dist(c, travadoEm) > cfg.ensinarMexida || escala(c, travadoEm) > cfg.ensinarMexida;
          if (!(mexeu && agora - ultimaFotoEm >= cfg.ensinarIntervalo))
            return { acao: 'nada', estado: 'mexa', progresso: 0 };
          travadoEm = null;
        } else if (dist(c, travadoEm) > cfg.trocaCentro || escala(c, travadoEm) > cfg.trocaEscala) {
          travadoEm = null; historico = [c];           // outro prato: recomeça a contar
        } else {
          return { acao: 'nada', estado: 'travado', progresso: 0 };
        }
      }

      const progresso = Math.min(1, historico.length / cfg.quadrosEstaveis);
      if (!estavel()) return { acao: 'nada', estado: 'firmando', progresso: estavelParcial(progresso) };
      return { acao: 'capturar', estado: 'capturando', progresso: 1 };
    }

    /* progresso mostrado na tela: só conta a sequência parada atual */
    function estavelParcial(p) {
      let k = 1;
      for (let i = historico.length - 1; i > 0; i--) {
        const a = historico[i], b = historico[i - 1];
        if (a.forma !== b.forma || dist(a, b) > cfg.movimentoMax || escala(a, b) > cfg.escalaMax) break;
        k++;
      }
      return Math.min(p, k / cfg.quadrosEstaveis);
    }

    /** a página fotografou: trava até o prato mudar */
    function capturou(contorno, agora) {
      travadoEm = contorno ? { ...contorno } : null;
      ultimaFotoEm = agora;
      historico = [];
    }

    return {
      observar, capturou,
      soltar() { travadoEm = null; historico = []; },
      modoEnsinar(sim) { ensinar = Boolean(sim); travadoEm = null; historico = []; },
      get travado() { return Boolean(travadoEm); },
      cfg
    };
  }

  raiz.Captura = { nova, PADRAO };
})(typeof window !== 'undefined' ? window : globalThis);
