// /api/webhook-mp — recebe a notificação do Mercado Pago, CONFERE o recurso na
// API do MP (fonte da verdade — nunca confiar no corpo do webhook) e atualiza o
// banco de forma IDEMPOTENTE.
//
// Trata 4 fluxos:
//   1) preapproval ............ mudança de estado da ASSINATURA (ativa/cancelada/pausada)
//   2) authorized_payment ..... COBRANÇA recorrente da assinatura (renovação mensal)
//   3) payment (com '|') ...... pagamento avulso vinculado à assinatura (fallback)
//   4) payment (uuid) ......... pagamento da PLAQUINHA (pedido)
//
// Os fluxos 2/3 registram cada cobrança na tabela `pagamentos` (ledger p/ receita
// faturada real) e ajustam a assinatura: aprovado -> 'ativa' (recupera de falha),
// recusado -> 'inadimplente' (visível no Admin p/ cobrança manual).
//
// Variáveis de ambiente (Vercel): MP_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

module.exports = async (req, res) => {
  const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Sem config ainda: responde 200 pra não acumular retentativas do MP.
  if (!MP_TOKEN || !SB_URL || !SB_SERVICE) { res.status(200).json({ ok: true, note: 'sem config' }); return; }

  try {
    const q = req.query || {};
    const body = req.body || {};
    const tipo = q.type || q.topic || body.type || (body.action ? String(body.action).split('.')[0] : null);
    const resourceId = q['data.id'] || (q.data && q.data.id) || (body.data && body.data.id) || q.id;
    const tstr = String(tipo || '');
    if (!resourceId) { res.status(200).json({ ok: true, note: 'sem id' }); return; }

    const sbHeaders = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json' };
    const svc = (path, payload) => fetch(`${SB_URL}/rest/v1/${path}`, {
      method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(payload)
    });
    const svcGet = async (path) => {
      const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders });
      if (!r.ok) return null;
      return r.json();
    };
    // Insere uma cobrança no ledger; duplicatas (mesmo mp_payment_id) são ignoradas
    // pelo índice único -> idempotente mesmo se o MP reenviar a notificação.
    const svcInsertPagamento = (row) => fetch(`${SB_URL}/rest/v1/pagamentos?on_conflict=mp_payment_id`, {
      method: 'POST',
      headers: { ...sbHeaders, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(row)
    });

    // Registra a cobrança e ajusta o status da assinatura.
    async function registrarCobranca({ assinaturaId, tutorId, plano, valorCentavos, mpStatus, mpPayId, pagoEm }) {
      if (!mpPayId) return; // ainda não há pagamento concreto (agendado) — nada a registrar
      const aprovado = mpStatus === 'approved';
      const recusado = mpStatus === 'rejected' || mpStatus === 'cancelled';
      await svcInsertPagamento({
        tutor_id: tutorId || null,
        assinatura_id: assinaturaId || null,
        tipo: 'assinatura',
        plano: plano || null,
        valor_centavos: valorCentavos || 0,
        status: aprovado ? 'aprovado' : (recusado ? 'recusado' : 'outro'),
        mp_payment_id: String(mpPayId),
        pago_em: pagoEm || new Date().toISOString()
      });
      // Recuperação/inadimplência — só faz sentido p/ uma assinatura conhecida.
      if (assinaturaId && (aprovado || recusado)) {
        await svc(`assinaturas?id=eq.${assinaturaId}`, {
          status: aprovado ? 'ativa' : 'inadimplente',
          atualizado_em: new Date().toISOString()
        });
      }
    }

    // === 1) ASSINATURA — mudança de estado (preapproval) ===
    if (/preapproval/i.test(tstr) && !/payment/i.test(tstr)) {
      const r = await fetch(`https://api.mercadopago.com/preapproval/${resourceId}`, {
        headers: { Authorization: `Bearer ${MP_TOKEN}` }
      });
      if (!r.ok) { res.status(200).json({ ok: true, note: 'preapproval nao encontrada' }); return; }
      const pre = await r.json();
      const ext = pre.external_reference; // tutorId|plano|assinaturaId
      if (!ext) { res.status(200).json({ ok: true, note: 'sem external_reference' }); return; }
      const [tutorId, plano, assinaturaId] = String(ext).split('|');

      let aStatus = null, novoPlano = null;
      if (pre.status === 'authorized')      { aStatus = 'ativa';     novoPlano = plano; }
      else if (pre.status === 'cancelled')  { aStatus = 'cancelada'; novoPlano = 'livre'; }
      else if (pre.status === 'paused')     { aStatus = 'pausada'; }

      if (aStatus && assinaturaId) {
        await svc(`assinaturas?id=eq.${assinaturaId}`, {
          status: aStatus, mp_preapproval_id: String(pre.id), atualizado_em: new Date().toISOString()
        });
      }
      if (novoPlano && tutorId && ['livre','premium','duo','familia'].indexOf(novoPlano) !== -1) {
        // BLINDAGEM DA CORTESIA: nunca sobrescrever o plano de uma conta de cortesia.
        await svc(`profiles?id=eq.${tutorId}&cortesia=eq.false`, { plano: novoPlano, atualizado_em: new Date().toISOString() });
      }
      res.status(200).json({ ok: true, kind: 'preapproval' });
      return;
    }

    // === 2) ASSINATURA — cobrança recorrente (authorized_payment) ===
    if (/authorized_payment/i.test(tstr)) {
      const r = await fetch(`https://api.mercadopago.com/authorized_payments/${resourceId}`, {
        headers: { Authorization: `Bearer ${MP_TOKEN}` }
      });
      if (!r.ok) { res.status(200).json({ ok: true, note: 'authorized_payment nao encontrado' }); return; }
      const ap = await r.json();
      const preId = ap.preapproval_id;
      const payStatus = (ap.payment && ap.payment.status) || ap.status;        // approved/rejected/...
      const mpPayId = (ap.payment && ap.payment.id) ? ap.payment.id : null;    // id do pagamento real
      const valorCentavos = Math.round((ap.transaction_amount || 0) * 100);
      const pagoEm = ap.date_created || null;

      // mapeia a preapproval -> assinatura/tutor (gravados quando a assinatura foi autorizada)
      let assinaturaId = null, tutorId = null, plano = null;
      if (preId) {
        const rows = await svcGet(`assinaturas?mp_preapproval_id=eq.${encodeURIComponent(preId)}&select=id,tutor_id,plano&limit=1`);
        if (rows && rows[0]) { assinaturaId = rows[0].id; tutorId = rows[0].tutor_id; plano = rows[0].plano; }
      }
      await registrarCobranca({ assinaturaId, tutorId, plano, valorCentavos, mpStatus: payStatus, mpPayId, pagoEm });
      res.status(200).json({ ok: true, kind: 'authorized_payment' });
      return;
    }

    // === PAGAMENTO (payment) ===
    if (tipo && tstr.indexOf('payment') === -1) { res.status(200).json({ ok: true, ignored: tipo }); return; }

    // Busca o pagamento no MP (fonte da verdade).
    const payResp = await fetch(`https://api.mercadopago.com/v1/payments/${resourceId}`, {
      headers: { Authorization: `Bearer ${MP_TOKEN}` }
    });
    if (!payResp.ok) { res.status(200).json({ ok: true, note: 'payment nao encontrado' }); return; }
    const pay = await payResp.json();

    const ext = pay.external_reference;
    if (!ext) { res.status(200).json({ ok: true, note: 'sem external_reference' }); return; }

    // === 3) PAGAMENTO de ASSINATURA (fallback) === external_reference = tutorId|plano|assinaturaId
    if (String(ext).indexOf('|') !== -1) {
      const [tutorId, plano, assinaturaId] = String(ext).split('|');
      const valorCentavos = Math.round((pay.transaction_amount || 0) * 100);
      const pagoEm = pay.date_approved || pay.date_created || null;
      await registrarCobranca({ assinaturaId, tutorId, plano, valorCentavos, mpStatus: pay.status, mpPayId: pay.id, pagoEm });
      res.status(200).json({ ok: true, kind: 'payment-assinatura' });
      return;
    }

    // === 4) PAGAMENTO AVULSO (plaquinha) === external_reference = id do pedido (uuid)
    const pedidoId = ext;
    let novo = null;
    if (pay.status === 'approved') novo = 'pago';
    else if (pay.status === 'cancelled' || pay.status === 'rejected') novo = 'cancelado';

    if (novo) {
      // Idempotente: só atualiza se ainda não estiver nesse estado.
      await fetch(`${SB_URL}/rest/v1/pedidos?id=eq.${pedidoId}&status=neq.${novo}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: novo, mp_payment_id: String(pay.id), atualizado_em: new Date().toISOString() })
      });
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    // Erro -> devolve 500 para o MP reenviar a notificação mais tarde.
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
