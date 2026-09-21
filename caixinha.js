/* Caixinha de perguntas — no molde do Sommelier do Paim.

   Seção no fluxo da página, centralizada, e não um botão flutuante: rótulo
   pequeno em cima, a pergunta grande em itálico como título, um subtítulo
   curto, a conversa em balões, sugestões arredondadas que somem depois da
   primeira pergunta, e campo + Enviar numa linha só.

   Cliente e equipe usam a mesma peça; muda o texto, as sugestões e para onde
   a pergunta vai.

   Uso:
     const cx = Caixinha.montar({
       alvo: '#caixinhaSalao',               // onde a seção entra
       rotulo: 'Assistente do salão',
       titulo: 'O que está pegando agora?',
       subtitulo: 'texto curto embaixo do título',
       placeholder: 'Ex.: quem pediu a conta?',
       sugestoes: ['…'] ou () => ['…'],      // função = sugestões que mudam com o salão
       aviso: 'texto miúdo de rodapé',
       recolhivel: true, chave: 'bahrem.cx.salao',   // lembra se estava recolhida
       enviar: async (pergunta, historico) => ({ texto, extras: [{ rotulo, acao }] })
     });
*/
(function (w) {
  'use strict';

  const esc = s => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function lerPref(chave) { try { return localStorage.getItem(chave); } catch { return null; } }
  function gravarPref(chave, v) { try { localStorage.setItem(chave, v); } catch {} }

  function montar(op) {
    const cfg = { rotulo: 'Pergunte', titulo: 'Posso ajudar?', subtitulo: '',
      placeholder: 'Digite sua pergunta', sugestoes: [], aviso: '',
      recolhivel: false, chave: null, ...op };
    const alvo = typeof cfg.alvo === 'string' ? document.querySelector(cfg.alvo) : cfg.alvo;
    if (!alvo) throw new Error('caixinha: alvo não encontrado');

    let historico = [];          // [{ pergunta, texto }]
    let ocupado = false;
    let recolhida = cfg.recolhivel && cfg.chave ? lerPref(cfg.chave) === '1' : false;

    const sec = document.createElement('section');
    sec.className = 'sommelier';
    sec.setAttribute('aria-label', cfg.rotulo);
    sec.innerHTML = `
      <div class="sommelier-dentro">
        <div class="sommelier-cabeca">
          <span class="sommelier-rotulo">${esc(cfg.rotulo)}</span>
          <h3>${esc(cfg.titulo)}</h3>
        </div>
        ${cfg.subtitulo ? `<p class="sommelier-sub">${esc(cfg.subtitulo)}</p>` : ''}
        <div class="sommelier-conversa" aria-live="polite"></div>
        <div class="sommelier-chips"></div>
        <form class="sommelier-form" autocomplete="off">
          <input type="text" maxlength="300" placeholder="${esc(cfg.placeholder)}"
            aria-label="${esc(cfg.titulo)}">
          <button type="submit">Enviar</button>
        </form>
        ${cfg.aviso ? `<p class="sommelier-aviso">${esc(cfg.aviso)}</p>` : ''}
      </div>
      ${cfg.recolhivel ? '<button type="button" class="sommelier-recolher"></button>' : ''}`;
    alvo.appendChild(sec);

    const conversa = sec.querySelector('.sommelier-conversa');
    const chips = sec.querySelector('.sommelier-chips');
    const campo = sec.querySelector('input');
    const botao = sec.querySelector('.sommelier-form button');
    const recolher = sec.querySelector('.sommelier-recolher');

    function aplicarRecolhida() {
      sec.classList.toggle('recolhida', recolhida);
      if (recolher) {
        recolher.textContent = recolhida ? 'abrir' : 'recolher';
        recolher.setAttribute('aria-expanded', String(!recolhida));
      }
    }

    function desenharChips() {
      const lista = typeof cfg.sugestoes === 'function' ? cfg.sugestoes() : cfg.sugestoes;
      /* como no Paim: as sugestões são para começar; depois da primeira
         pergunta elas somem e a conversa ocupa o lugar */
      chips.hidden = historico.length > 0 || !lista.length;
      chips.innerHTML = lista.map(t => `<button type="button" class="sommelier-chip">${esc(t)}</button>`).join('');
      chips.querySelectorAll('button').forEach(b => b.onclick = () => perguntar(b.textContent));
    }

    function balao(tipo, texto) {
      const d = document.createElement('div');
      d.className = `sommelier-balao ${tipo}`;
      d.textContent = texto;
      conversa.appendChild(d);
      conversa.scrollTop = conversa.scrollHeight;
      return d;
    }

    async function perguntar(texto) {
      const pergunta = String(texto || '').trim();
      if (!pergunta || ocupado) return;
      if (recolhida) { recolhida = false; aplicarRecolhida(); }
      ocupado = true; botao.disabled = true; campo.value = '';
      chips.hidden = true;
      balao('eu', pergunta);
      const pensando = balao('pensando', 'Pensando…');
      try {
        const r = await cfg.enviar(pergunta, historico.slice(-6));
        pensando.remove();
        const b = balao('ela', r.texto || '(sem resposta)');
        historico.push({ pergunta, texto: r.texto });
        if (r.extras?.length) {
          const box = document.createElement('div');
          box.className = 'sommelier-extras';
          for (const x of r.extras) {
            const e = document.createElement('button');
            e.type = 'button'; e.className = 'sommelier-chip';
            e.textContent = x.rotulo;
            e.onclick = async () => {
              e.disabled = true;
              try { const novo = await x.acao(); if (novo) e.textContent = novo; }
              catch { e.disabled = false; }
            };
            box.appendChild(e);
          }
          b.appendChild(box);
        }
      } catch (err) {
        pensando.remove();
        balao('erro', err?.message || 'Não consegui responder agora. Tente de novo em instantes.');
      } finally {
        ocupado = false; botao.disabled = false; campo.focus();
      }
    }

    sec.querySelector('form').onsubmit = e => { e.preventDefault(); perguntar(campo.value); };
    if (recolher) recolher.onclick = () => {
      recolhida = !recolhida;
      if (cfg.chave) gravarPref(cfg.chave, recolhida ? '1' : '0');
      aplicarRecolhida();
    };

    aplicarRecolhida();
    desenharChips();

    return {
      perguntar,
      focar: () => { if (recolhida) { recolhida = false; aplicarRecolhida(); } campo.focus(); },
      atualizarSugestoes: desenharChips,
      mostrar(sim) { sec.hidden = !sim; },
      limpar() { historico = []; conversa.innerHTML = ''; desenharChips(); }
    };
  }

  w.Caixinha = { montar };
})(window);
