'use strict';
/* Toda a aritmética da conta em um lugar, em centavos inteiros.

   Duas invariantes que os testes cobram a cada mudança:
   1. a soma das partes é exatamente o total — nenhum centavo aparece ou some;
   2. item que ninguém marcou é da mesa: divide igual entre todos.

   O rateio por item existe porque a divisão igual é injusta na prática: quem
   bebeu água não quer pagar por quatro chopps. Quem marcou o item paga por ele;
   serviço e desconto seguem proporcionais ao que cada um consumiu. */

/** reparte `total` entre `pesos` mantendo a soma exata (maior resto) */
function distribuir(total, pesos) {
  const soma = pesos.reduce((a, b) => a + b, 0);
  if (!pesos.length) return [];
  if (soma <= 0) {                                  // sem peso: parte igual
    const base = Math.floor(total / pesos.length), resto = total - base * pesos.length;
    return pesos.map((_, i) => base + (i < resto ? 1 : 0));
  }
  const cru = pesos.map(p => total * p / soma);
  const piso = cru.map(Math.floor);
  let falta = total - piso.reduce((a, b) => a + b, 0);
  /* ordem por maior resto; empate resolve pelo índice, para ser determinístico */
  const ordem = cru.map((v, i) => [v - piso[i], i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < ordem.length && falta > 0; k++, falta--) piso[ordem[k][1]]++;
  return piso;
}

/** desconto: valor fixo em centavos ou percentual do subtotal, nunca maior que ele */
function desconto({ tipo, valor }, subtotal) {
  if (!valor || valor <= 0) return 0;
  const bruto = tipo === 'percentual'
    ? Math.round(subtotal * Math.min(100, valor) / 100)
    : Math.round(valor);
  return Math.max(0, Math.min(subtotal, bruto));
}

/**
 * @param {Array}  itens        [{id, qtd, preco_cent, estado}]
 * @param {number} pessoas      quantas pessoas na mesa
 * @param {Map}    divisao      id do lançamento -> [índices de pessoa, base 1]
 * @param {number} servicoPct
 * @param {number} descontoCent já resolvido
 */
function calcular({ itens, pessoas, divisao = new Map(), servicoPct = 10, descontoCent = 0 }) {
  const n = Math.max(1, Number(pessoas) || 1);
  /* itens sugeridos pelo cliente ainda não são conta: só entram depois de aceitos */
  const valendo = itens.filter(i => i.estado !== 'sugerido' && i.estado !== 'recusado');

  const subtotal = valendo.reduce((s, i) => s + i.qtd * i.preco_cent, 0);
  const desc = Math.max(0, Math.min(subtotal, Math.round(descontoCent) || 0));
  const servico = Math.round((subtotal - desc) * servicoPct / 100);
  const total = subtotal - desc + servico;

  /* quanto cada pessoa consumiu, item a item */
  const consumo = Array.from({ length: n }, () => 0);
  for (const i of valendo) {
    const marcados = (divisao.get(i.id) || [])
      .map(Number).filter(p => p >= 1 && p <= n);
    const donos = marcados.length ? [...new Set(marcados)].sort((a, b) => a - b)
      : Array.from({ length: n }, (_, k) => k + 1);           // sem marca: é da mesa
    const partes = distribuir(i.qtd * i.preco_cent, donos.map(() => 1));
    donos.forEach((p, k) => { consumo[p - 1] += partes[k]; });
  }

  const descPessoa = distribuir(desc, consumo);
  const servPessoa = distribuir(servico, consumo);
  const porPessoa = consumo.map((c, i) => c - descPessoa[i] + servPessoa[i]);

  return { subtotal_cent: subtotal, desconto_cent: desc, servico_cent: servico,
    servico_pct: servicoPct, total_cent: total, pessoas: n,
    consumo_cent: consumo, porPessoa_cent: porPessoa,
    rateado: [...divisao.keys()].length > 0 };
}

module.exports = { distribuir, desconto, calcular };
