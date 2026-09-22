/* helpers comuns às três telas */
(function (w) {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* todo campo controlado por gente passa por aqui antes de virar HTML */
  const esc = s => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const real = cent => (Number(cent || 0) / 100).toLocaleString('pt-BR',
    { style: 'currency', currency: 'BRL' });

  function decorrido(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
  }

  const guarda = {
    get token() { return localStorage.getItem('burguer.token') || ''; },
    set token(v) { v ? localStorage.setItem('burguer.token', v) : localStorage.removeItem('burguer.token'); },
    get eu() { try { return JSON.parse(localStorage.getItem('burguer.eu') || 'null'); } catch { return null; } },
    set eu(v) { localStorage.setItem('burguer.eu', JSON.stringify(v)); }
  };

  async function api(rota, opcoes = {}) {
    const r = await fetch(rota, {
      ...opcoes,
      headers: { 'content-type': 'application/json',
        ...(guarda.token ? { authorization: `Bearer ${guarda.token}` } : {}),
        ...(opcoes.headers || {}) },
      body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : opcoes.body
    });
    if (r.status === 401 && !rota.startsWith('/api/conta')) {
      guarda.token = ''; location.href = '/'; throw new Error('sessão expirada');
    }
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(dados.erro || `erro ${r.status}`), { status: r.status, dados });
    return dados;
  }

  /* SSE com religação automática — o tablet do salão perde wi-fi o tempo todo */
  function escutar(aoReceber, aoMudarLigacao) {
    let fonte = null, tentativa = 0;
    const ligar = () => {
      /* sem token na URL: o cookie HttpOnly da sessão já vai junto no EventSource */
      fonte = new EventSource('/api/eventos', { withCredentials: true });
      fonte.onopen = () => { tentativa = 0; aoMudarLigacao && aoMudarLigacao(true); };
      fonte.onerror = () => {
        aoMudarLigacao && aoMudarLigacao(false);
        fonte.close();
        setTimeout(ligar, Math.min(15000, 800 * 2 ** tentativa++));
      };
      /* canal único: o tipo vem dentro do dado. Uma lista de nomes aqui
         sempre fica para trás do servidor — foi o que aconteceu, e 8 dos 17
         tipos de evento nunca chegavam às telas. */
      fonte.onmessage = e => {
        let d; try { d = JSON.parse(e.data); } catch { return; }
        if (d && d.tipo) aoReceber(d.tipo, d);
      };
    };
    ligar();
    return () => fonte && fonte.close();
  }

  /* junta rajadas: dez eventos em sequência viram uma recarga só */
  function adiar(fn, ms = 250) {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  w.B = { $, $$, esc, real, decorrido, api, guarda, escutar, adiar };
})(window);
