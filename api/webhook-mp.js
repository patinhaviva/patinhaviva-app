// /api/webhook-mp — recebe a notificação do Mercado Pago, CONFERE o pagamento
// na API do MP (fonte da verdade — nunca confiar no corpo do webhook) e marca
// o pedido como pago de forma IDEMPOTENTE.
//
// Variáveis de ambiente (Vercel): MP_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Configure a notification_url no painel do Mercado Pago apontando para:
//   https://patinhaviva-app.vercel.app/api/webhook-mp

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

    const svc = (path, payload) => fetch(`${SB_URL}/rest/v1/${path}`, {
      method: 'PATCH',
      headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(payload)
    });

    // === ASSINATURA (preapproval) ===
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
        // BLINDAGEM DA CORTESIA: nunca sobrescrever o plano de uma conta de cortesia
        // (cortesia=true). O filtro cortesia=eq.false faz o PATCH só atingir contas pagas.
        await svc(`profiles?id=eq.${tutorId}&cortesia=eq.false`, { plano: novoPlano, atualizado_em: new Date().toISOString() });
      }
      res.status(200).json({ ok: true, kind: 'preapproval' });
      return;
    }

    // === PAGAMENTO AVULSO (plaquinha) ===
    if (tipo && tstr.indexOf('payment') === -1) { res.status(200).json({ ok: true, ignored: tipo }); return; }
    const paymentId = resourceId;

    // 1) Busca o pagamento no MP (fonte da verdade).
    const payResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_TOKEN}` }
    });
    if (!payResp.ok) { res.status(200).json({ ok: true, note: 'payment nao encontrado' }); return; }
    const pay = await payResp.json();

    const pedidoId = pay.external_reference;
    if (!pedidoId) { res.status(200).json({ ok: true, note: 'sem external_reference' }); return; }

    // 2) Mapeia o status do MP para o status do pedido.
    let novo = null;
    if (pay.status === 'approved') novo = 'pago';
    else if (pay.status === 'cancelled' || pay.status === 'rejected') novo = 'cancelado';

    if (novo) {
      // Idempotente: só atualiza se ainda não estiver nesse estado.
      // (O índice único em mp_payment_id também impede um pagamento marcar 2 pedidos.)
      await fetch(`${SB_URL}/rest/v1/pedidos?id=eq.${pedidoId}&status=neq.${novo}`, {
        method: 'PATCH',
        headers: {
          apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`,
          'Content-Type': 'application/json', Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          status: novo, mp_payment_id: String(pay.id),
          atualizado_em: new Date().toISOString()
        })
      });
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    // Erro -> devolve 500 para o MP reenviar a notificação mais tarde.
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
