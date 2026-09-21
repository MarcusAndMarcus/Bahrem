/* BAHREM · Alertas — som (Web Audio API, zero arquivo) + toasts.
   Carregado em salao.html e passe.html. A câmera e a mesa do cliente não usam. */
(function (w) {
  'use strict';

  let ctx = null;
  function ac() {
    if (!ctx) { try { ctx = new (w.AudioContext || w.webkitAudioContext)(); } catch {} }
    if (ctx?.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tom(freq, dur, tipo = 'sine', vol = 0.26) {
    const c = ac(); if (!c) return;
    try {
      const osc = c.createOscillator(), gain = c.createGain();
      osc.connect(gain); gain.connect(c.destination);
      osc.type = tipo;
      osc.frequency.setValueAtTime(freq, c.currentTime);
      gain.gain.setValueAtTime(vol, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
      osc.start(); osc.stop(c.currentTime + dur);
    } catch {}
  }
  const apos = (fn, ms) => setTimeout(fn, ms);

  /* Cada evento tem um padrão de beeps distinto — num bar barulhento, a
     melodia identifica o tipo antes de ler o texto. */
  const SONS = {
    'chamou-garcom':  () => { tom(880, .14); apos(() => tom(880, .14), 210); apos(() => tom(1047, .32), 420); },
    'pediu-conta':    () => { tom(659, .1); apos(() => tom(784, .1), 130); apos(() => tom(1047, .1), 260); apos(() => tom(1319, .38), 390); },
    'pedido-cliente': () => { tom(523, .08); apos(() => tom(659, .28), 130); },
    'passe-pronto':   () => { tom(1047, .06); apos(() => tom(1319, .06), 90); apos(() => tom(1568, .24), 180); },
    'item-pronto':    () => { tom(1047, .06); apos(() => tom(1319, .06), 90); apos(() => tom(1568, .24), 180); },
    'mesa-aberta':    () => { tom(523, .22, 'triangle', .18); },
    'mesa-fechada':   () => { tom(392, .18, 'triangle', .18); },
    'padrao-gravado': () => { tom(523, .18); apos(() => tom(784, .3), 220); },
  };

  const URGENTES = new Set(['chamou-garcom', 'pediu-conta', 'pedido-cliente']);

  const MSG = {
    'chamou-garcom':  d => `Mesa ${d.mesa} — garçom chamado`,
    'pediu-conta':    d => `Mesa ${d.mesa} — pediu a conta`,
    'pedido-cliente': d => `Mesa ${d.mesa} — pedido pelo celular (${d.itens || 1} item${d.itens > 1 ? 's' : ''})`,
    'passe-pronto':   d => `${d.nome || 'Item'} — pronto para levar`,
    'item-pronto':    d => `${d.nome || 'Item'} na mesa ${d.mesa || ''} — pronto`,
    'mesa-aberta':    d => `Mesa ${d.mesa} aberta`,
    'mesa-fechada':   d => `Mesa ${d.mesa} fechada`,
    'transferencia':  d => `Comanda: mesa ${d.de} → mesa ${d.mesa}`,
    'desconto':       d => `Desconto na mesa ${d.mesa} — ${d.motivo || ''}`,
    'padrao-gravado': d => `Padrão de ${d.item || 'prato'} gravado`,
    'reabertura':     d => `Mesa ${d.mesa} reaberta`,
    'estorno':        d => `Estorno na mesa ${d.mesa}`,
  };

  let area = null;
  function ensureArea() {
    if (!area || !area.isConnected) {
      area = document.createElement('div');
      area.id = 'toast-area';
      document.body.appendChild(area);
    }
    return area;
  }

  let ultimoTipo = null, ultimaMsg = null, repetidos = 0;

  function toast(tipo, dado = {}) {
    const msg = MSG[tipo] ? MSG[tipo](dado) : null;
    if (!msg) return;

    /* colapsa repetições muito rápidas (ex.: vários itens prontos seguidos) */
    if (tipo === ultimoTipo && msg === ultimaMsg) {
      repetidos++;
      const ant = ensureArea().querySelector('.toast:last-child');
      if (ant) { ant.dataset.n = `×${repetidos + 1}`; return; }
    } else { ultimoTipo = tipo; ultimaMsg = msg; repetidos = 0; }

    const div = document.createElement('div');
    div.className = 'toast' + (URGENTES.has(tipo) ? ' urgente' : '');
    div.textContent = msg;
    div.setAttribute('role', 'alert');
    div.onclick = () => { div.classList.remove('visivel'); setTimeout(() => div.remove(), 320); };
    ensureArea().appendChild(div);
    requestAnimationFrame(() => requestAnimationFrame(() => div.classList.add('visivel')));
    const t = setTimeout(() => {
      div.classList.remove('visivel');
      setTimeout(() => div.remove(), 320);
    }, tipo === 'pediu-conta' || tipo === 'chamou-garcom' ? 8000 : 4500);
    div.addEventListener('click', () => clearTimeout(t), { once: true });

    if (SONS[tipo]) SONS[tipo]();
  }

  /* desbloqueia o AudioContext no primeiro gesto */
  ['click', 'touchstart', 'keydown'].forEach(ev =>
    document.addEventListener(ev, ac, { once: true, passive: true }));

  /* toast com um botão — usado no "desfazer" do estorno */
  function acao(texto, rotulo, fn, ms = 10000) {
    const div = document.createElement('div');
    div.className = 'toast com-acao';
    div.setAttribute('role', 'status');
    const span = document.createElement('span');
    span.textContent = texto;
    const btn = document.createElement('button');
    btn.className = 'btn miudo';
    btn.textContent = rotulo;
    div.append(span, btn);
    ensureArea().appendChild(div);
    requestAnimationFrame(() => requestAnimationFrame(() => div.classList.add('visivel')));
    const sai = () => { div.classList.remove('visivel'); setTimeout(() => div.remove(), 320); };
    const t = setTimeout(sai, ms);
    btn.onclick = ev => { ev.stopPropagation(); clearTimeout(t); btn.disabled = true; sai(); fn(); };
  }

  /* aviso de erro sem som, para falha de ação */
  function aviso(texto) {
    const div = document.createElement('div');
    div.className = 'toast urgente';
    div.setAttribute('role', 'alert');
    div.textContent = texto;
    ensureArea().appendChild(div);
    requestAnimationFrame(() => requestAnimationFrame(() => div.classList.add('visivel')));
    setTimeout(() => { div.classList.remove('visivel'); setTimeout(() => div.remove(), 320); }, 5000);
  }

  w.Alerta = { toast, tom, acao, aviso };
})(window);
