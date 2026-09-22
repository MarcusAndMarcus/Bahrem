'use strict';
/* NFC-e — Nota Fiscal de Consumidor Eletrônica — pela Focus NFe.

   "Cupom fiscal eletrônico", em Goiás e na maior parte do país, é a NFC-e
   (modelo 65). A Focus NFe assina o XML, fala com a SEFAZ e devolve o
   resultado; este módulo monta o pedido, envia e interpreta a resposta.

   Contrato conferido na documentação da Focus (abril de 2026):
   - POST /v2/nfce?ref=REF, síncrono: volta "autorizado" ou "erro_autorizacao"
   - GET  /v2/nfce/REF para consultar
   - DELETE /v2/nfce/REF com justificativa de 15 a 255 caracteres,
     em até 30 minutos depois da emissão
   - autenticação HTTP Basic: usuário = token, senha em branco
   - data_emissao com fuso, no máximo 5 minutos de diferença do relógio

   Três modos, e o sistema diz qual está valendo:
   - "nao-fiscal": sem FOCUS_NFE_TOKEN ou sem FOCUS_NFE_CNPJ. Gera um
     comprovante SEM VALOR FISCAL e não envia nada a ninguém.
   - "homologacao": ambiente de teste da SEFAZ. Nota de verdade no formato,
     sem valor fiscal. É o padrão.
   - "producao": nota com valor fiscal. Só emite se TODOS os itens da nota
     tiverem o cadastro fiscal marcado como revisado.

   O que é decisão do contador e não minha, e por isso é configurável ou
   editável: NCM, CFOP e CSOSN de cada item (os que vêm na carga inicial são
   exemplo e saem marcados como não revisados), como tratar os 10% de serviço
   na nota, e os campos da Reforma Tributária (IBS/CBS) — que entram pelo
   campo "extra" de cada item, sem mexer em código. */

const { distribuir } = require('./conta');

const AMBIENTES = {
  homologacao: 'https://homologacao.focusnfe.com.br',
  producao: 'https://api.focusnfe.com.br'
};

const CONF = {
  token: process.env.FOCUS_NFE_TOKEN || '',
  cnpj: String(process.env.FOCUS_NFE_CNPJ || '').replace(/\D/g, ''),
  ambiente: process.env.FOCUS_NFE_AMBIENTE === 'producao' ? 'producao' : 'homologacao',
  base: process.env.FOCUS_NFE_URL || '',            // só para apontar para um dublê em teste
  fuso: process.env.NFCE_FUSO || '-03:00',
  timeout: Number(process.env.NFCE_TIMEOUT || 30000),
  natureza: process.env.NFCE_NATUREZA || 'VENDA AO CONSUMIDOR'
};

const host = () => CONF.base || AMBIENTES[CONF.ambiente];
const modo = () => (CONF.token && CONF.cnpj.length === 14 ? CONF.ambiente : 'nao-fiscal');

/* forma de pagamento (tPag), tabela da Focus. O Pix deste sistema é o QR
   estático gerado a partir da chave — por isso 20 (Pix estático), e não 17,
   que é o Pix dinâmico, gerado por um PSP. Voucher entra como vale-refeição. */
const TPAG = { dinheiro: '01', credito: '03', debito: '04', voucher: '11', pix: '20' };
const CARTAO = new Set(['03', '04']);

/* cadastro fiscal de exemplo por tipo de item — sempre marcado como NÃO
   revisado. Serve para a homologação funcionar sem configurar nada. */
const EXEMPLOS = {
  cozinha: { ncm: '21069090', cfop: '5101', csosn: '102', origem: '0', unidade: 'UN' },
  preparado: { ncm: '22089000', cfop: '5101', csosn: '102', origem: '0', unidade: 'UN' },
  cerveja: { ncm: '22030000', cfop: '5405', csosn: '500', origem: '0', unidade: 'UN' },
  refrigerante: { ncm: '22021000', cfop: '5405', csosn: '500', origem: '0', unidade: 'UN' },
  agua: { ncm: '22011000', cfop: '5405', csosn: '500', origem: '0', unidade: 'UN' },
  vinho: { ncm: '22042100', cfop: '5102', csosn: '102', origem: '0', unidade: 'UN' }
};
function exemploPara(item) {
  const n = String(item.nome || '').toLowerCase();
  if (item.estacao !== 'bar') return EXEMPLOS.cozinha;
  if (/chopp|long neck|cerveja/.test(n)) return EXEMPLOS.cerveja;
  if (/refrigerante/.test(n)) return EXEMPLOS.refrigerante;
  if (/água|agua/.test(n)) return EXEMPLOS.agua;
  if (/vinho/.test(n)) return EXEMPLOS.vinho;
  return EXEMPLOS.preparado;
}

/** cadastro fiscal efetivo de um item: o salvo, ou o exemplo */
function fiscalDo(item) {
  const ex = exemploPara(item);
  let extra = {};
  try { extra = item.fiscal_extra ? JSON.parse(item.fiscal_extra) : {}; } catch {}
  return {
    ncm: item.ncm || ex.ncm, cfop: item.cfop || ex.cfop, csosn: item.csosn || ex.csosn,
    origem: item.origem ?? ex.origem, unidade: item.unidade || ex.unidade,
    revisado: Boolean(item.fiscal_revisado), extra: extra && typeof extra === 'object' ? extra : {},
    exemplo: !item.ncm
  };
}

function validarFiscal(f) {
  const erros = [];
  if (!/^\d{8}$/.test(f.ncm)) erros.push('NCM precisa de 8 dígitos');
  if (!/^[1-7]\d{3}$/.test(f.cfop)) erros.push('CFOP precisa de 4 dígitos');
  if (!/^\d{2,3}$/.test(f.csosn)) erros.push('CSOSN/CST precisa de 2 ou 3 dígitos');
  if (!/^[0-8]$/.test(String(f.origem))) erros.push('origem vai de 0 a 8');
  return erros;
}

function cpfValido(cpf) {
  const d = String(cpf || '').replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = n => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

/** data de emissão com fuso explícito: 2026-09-22T21:15:03-03:00 */
function dataEmissao(agora = new Date()) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(CONF.fuso) || ['', '-', '03', '00'];
  const minutos = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const local = new Date(agora.getTime() + minutos * 60000);
  return `${local.toISOString().slice(0, 19)}${m[1]}${m[2]}:${m[3]}`;
}

const reais = c => Math.round(c) / 100;

/* os campos que o contador pode acrescentar por item não podem sobrescrever
   os que o sistema calcula — senão um JSON errado muda preço na nota */
const PROTEGIDOS = new Set(['numero_item', 'codigo_produto', 'descricao', 'quantidade_comercial',
  'quantidade_tributavel', 'valor_unitario_comercial', 'valor_unitario_tributavel', 'valor_bruto',
  'valor_desconto']);

/**
 * Monta o JSON da NFC-e. Função pura: não toca rede nem banco.
 * @param {Array}  itens       [{item_id, nome, qtd, preco_cent}] — só o que está na conta
 * @param {Map}    cardapio    item_id -> linha do cardápio (com o cadastro fiscal)
 * @param {number} desconto_cent
 * @param {Array}  pagamentos  [{forma, valor_cent}] como gravados no fechamento
 * @param {string} cpf         opcional
 */
function montarNota({ itens, cardapio, desconto_cent = 0, pagamentos = [], cpf = '', agora = new Date() }) {
  const avisos = [];
  if (!itens.length) throw erroFiscal('a comanda não tem item para a nota');

  /* uma linha por produto e preço: 4 chopps viram uma linha de quantidade 4 */
  const grupos = new Map();
  for (const i of itens) {
    const chave = `${i.item_id ?? 'x' + i.nome}|${i.preco_cent}`;
    const g = grupos.get(chave) || { ...i, qtd: 0 };
    g.qtd += i.qtd;
    grupos.set(chave, g);
  }
  const linhas = [...grupos.values()];

  const brutos = linhas.map(l => l.qtd * l.preco_cent);
  const soma = brutos.reduce((a, b) => a + b, 0);
  const desc = Math.max(0, Math.min(soma, Math.round(desconto_cent) || 0));
  const descs = distribuir(desc, brutos);                   // desconto rateado, centavo exato
  const total = soma - desc;
  if (total <= 0) throw erroFiscal('o total da nota é zero — cortesia total não gera NFC-e de venda');

  const naoRevisados = [];
  const items = linhas.map((l, k) => {
    const cad = cardapio.get(l.item_id) || { nome: l.nome, estacao: l.estacao };
    const f = fiscalDo({ ...cad, nome: cad.nome || l.nome });
    const erros = validarFiscal(f);
    if (erros.length) throw erroFiscal(`${l.nome}: ${erros.join('; ')}`);
    if (!f.revisado) naoRevisados.push(l.nome);
    const extra = Object.fromEntries(Object.entries(f.extra).filter(([c]) => !PROTEGIDOS.has(c)));
    return {
      numero_item: String(k + 1),
      codigo_produto: String(l.item_id ?? k + 1),
      descricao: String(l.nome).slice(0, 120),
      codigo_ncm: f.ncm,
      cfop: f.cfop,
      unidade_comercial: f.unidade,
      unidade_tributavel: f.unidade,
      quantidade_comercial: l.qtd,
      quantidade_tributavel: l.qtd,
      valor_unitario_comercial: reais(l.preco_cent),
      valor_unitario_tributavel: reais(l.preco_cent),
      valor_bruto: reais(brutos[k]),
      ...(descs[k] ? { valor_desconto: reais(descs[k]) } : {}),
      icms_origem: String(f.origem),
      icms_situacao_tributaria: f.csosn,
      ...extra
    };
  });

  /* Pagamento. Os 10% de serviço não são mercadoria e ficam fora da nota
     (padrão: é o que o contador costuma pedir, e a alternativa é decisão
     dele). Então o cliente pagou mais do que a nota soma — e a SEFAZ lê o que
     passa do total como troco. Por isso cada forma entra na nota com a sua
     proporção do total da nota, e a soma bate no centavo. */
  const validos = pagamentos.filter(p => p.valor_cent > 0);
  if (!validos.length) throw erroFiscal('a comanda fechou sem forma de pagamento');
  const semForma = validos.filter(p => !TPAG[p.forma]);
  if (semForma.length)
    throw erroFiscal(`forma de pagamento sem código fiscal: ${semForma.map(p => p.forma).join(', ')} — ` +
      'reabra a comanda e informe como o cliente pagou');
  const partes = distribuir(total, validos.map(p => p.valor_cent));
  const formas_pagamento = validos.map((p, k) => ({
    forma_pagamento: TPAG[p.forma],
    valor_pagamento: reais(partes[k]),
    ...(CARTAO.has(TPAG[p.forma]) ? { tipo_integracao: '2' } : {})   // maquininha avulsa (POS)
  })).filter(f => f.valor_pagamento > 0);

  const doc = String(cpf || '').replace(/\D/g, '');
  if (doc && !cpfValido(doc)) throw erroFiscal('CPF inválido');
  if (naoRevisados.length)
    avisos.push(`cadastro fiscal de exemplo, ainda não revisado: ${naoRevisados.join(', ')}`);

  return {
    total_cent: total, naoRevisados, avisos,
    nota: {
      cnpj_emitente: CONF.cnpj,
      data_emissao: dataEmissao(agora),
      natureza_operacao: CONF.natureza,
      presenca_comprador: '1',
      modalidade_frete: '9',
      local_destino: '1',
      ...(doc ? { cpf_destinatario: doc } : {}),
      items,
      formas_pagamento
    }
  };
}

function erroFiscal(msg) { const e = new Error(msg); e.fiscal = true; return e; }

/* ---------- conversa com a Focus ---------- */
async function pedir(metodo, caminho, corpo) {
  const r = await fetch(`${host()}${caminho}`, {
    method: metodo,
    signal: AbortSignal.timeout ? AbortSignal.timeout(CONF.timeout) : undefined,
    headers: { authorization: `Basic ${Buffer.from(`${CONF.token}:`).toString('base64')}`,
      'content-type': 'application/json', accept: 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const texto = await r.text();
  let json = null;
  try { json = JSON.parse(texto); } catch {}
  return { http: r.status, json, texto };
}

const absoluto = c => (c ? (/^https?:/.test(c) ? c : `${host()}${c}`) : null);

/** traduz qualquer resposta da Focus para um status só do sistema */
function interpretar({ http, json, texto }) {
  if (http === 401) return { status: 'erro', mensagem: 'a Focus NFe recusou o token (HTTP Basic: Access denied)' };
  const j = json || {};
  if (j.status === 'autorizado') {
    return { status: 'autorizado', chave: String(j.chave_nfe || '').replace(/^NFe/, ''),
      numero: j.numero || null, serie: j.serie || null,
      mensagem: `${j.status_sefaz || ''} ${j.mensagem_sefaz || ''}`.trim(),
      danfe: absoluto(j.caminho_danfe), xml: absoluto(j.caminho_xml_nota_fiscal),
      qrcode: j.qrcode_url || null, consulta: j.url_consulta_nf || null,
      contingencia: Boolean(j.contingencia_offline) };
  }
  if (j.status === 'erro_autorizacao' || j.status === 'denegado')
    return { status: 'erro', mensagem: `SEFAZ ${j.status_sefaz || ''}: ${j.mensagem_sefaz || 'rejeitada'}`.trim() };
  if (j.status === 'cancelado') return { status: 'cancelado', mensagem: j.mensagem_sefaz || 'cancelada' };
  if (j.codigo === 'pending_operation' || j.status === 'processando_autorizacao')
    return { status: 'pendente', mensagem: 'a nota ainda está em processamento' };
  if (j.codigo === 'already_processed') return { status: 'ja_processada', mensagem: j.mensagem };
  if (http === 404) return { status: 'nao_encontrada', mensagem: j.mensagem || 'NFC-e não encontrada' };
  const msg = j.mensagem || (j.erros || []).map(e => e.mensagem).join('; ') || String(texto || '').slice(0, 200);
  return { status: 'erro', mensagem: `${j.codigo ? j.codigo + ': ' : ''}${msg || 'erro ' + http}` };
}

async function emitir(ref, nota) {
  try {
    const r = interpretar(await pedir('POST', `/v2/nfce?ref=${encodeURIComponent(ref)}`, nota));
    /* mesma ref já autorizada: a Focus é idempotente pela ref — busca o que vale */
    if (r.status === 'ja_processada') return consultar(ref);
    return r;
  } catch (e) {
    /* Queda de rede no meio de uma emissão síncrona é o caso perigoso: a nota
       pode ter sido autorizada e a resposta se perdido. Nunca tratar como
       erro e emitir de novo com outra ref — fica "pendente", e a próxima
       tentativa usa a MESMA ref, que a Focus reconhece. */
    return { status: 'pendente', mensagem: `sem resposta da Focus NFe (${e.name === 'TimeoutError' ? 'tempo esgotado' : e.message}) — consulte antes de tentar de novo` };
  }
}

async function consultar(ref) {
  try { return interpretar(await pedir('GET', `/v2/nfce/${encodeURIComponent(ref)}`)); }
  catch (e) { return { status: 'pendente', mensagem: `sem resposta da Focus NFe (${e.message})` }; }
}

async function cancelar(ref, justificativa) {
  const j = String(justificativa || '').trim();
  if (j.length < 15 || j.length > 255)
    return { status: 'erro', mensagem: 'a justificativa precisa ter entre 15 e 255 caracteres' };
  try {
    const r = await pedir('DELETE', `/v2/nfce/${encodeURIComponent(ref)}`, { justificativa: j });
    const jj = r.json || {};
    if (jj.status === 'cancelado')
      return { status: 'cancelado', mensagem: `${jj.status_sefaz || ''} ${jj.mensagem_sefaz || ''}`.trim(),
        protocolo: jj.numero_protocolo || null, xml: absoluto(jj.caminho_xml_cancelamento) };
    if (jj.status === 'erro_cancelamento')
      return { status: 'erro', mensagem: `SEFAZ ${jj.status_sefaz || ''}: ${jj.mensagem_sefaz || 'cancelamento recusado'}` };
    if (jj.codigo === 'already_processed') return { status: 'cancelado', mensagem: jj.mensagem };
    return interpretar(r);
  } catch (e) { return { status: 'erro', mensagem: `sem resposta da Focus NFe (${e.message})` }; }
}

/** confere o token sem emitir nada: consulta uma ref que não existe.
    404 = o token entrou; 401 = token errado. */
async function testar() {
  if (modo() === 'nao-fiscal') return { ok: false, mensagem: 'sem FOCUS_NFE_TOKEN e FOCUS_NFE_CNPJ configurados' };
  try {
    const r = await pedir('GET', `/v2/nfce/teste-conexao-${Date.now()}`);
    if (r.http === 404) return { ok: true, mensagem: `token aceito pela Focus NFe (${CONF.ambiente})` };
    return { ok: false, mensagem: interpretar(r).mensagem };
  } catch (e) { return { ok: false, mensagem: `sem resposta da Focus NFe (${e.message})` }; }
}

module.exports = { CONF, TPAG, EXEMPLOS, modo, host, fiscalDo, validarFiscal, cpfValido,
  dataEmissao, montarNota, emitir, consultar, cancelar, testar, interpretar };
