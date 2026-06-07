// /api/criar-assinatura — cria a assinatura recorrente de um plano (Mercado Pago
// Assinaturas / preapproval). O PREÇO e o PLANO válido são definidos AQUI no
// servidor — nunca confiar no valor vindo do navegador.
//
// Variáveis de ambiente (Vercel): MP_ACCESS_TOKEN, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, APP_BASE_URL.

const PLANOS = {
  premium: { nome: 'Premium', centavos: 2990 }, // R$ 29,90/mês
  duo:     { nome: 'Duo',     centavos: 4990 }, // R$ 49,90/mês
  familia: { nome: 'Família', centavos: 7990 }  // R$ 79,90/mês
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method', message: 'Use POST.' }); return; }

  const MP_TOKEN   = process.env.MP_ACCESS_TOKEN;
  const SB_URL     = process.env.SUPABASE_URL;
  const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SB_ANON    = process.env.SUPABASE_ANON_KEY;

  // Sem segredos configurados -> degrada de forma honesta.
  if (!MP_TOKEN || !SB_URL || !SB_SERVICE || !SB_ANON) {
    res.status(503).json({ error: 'config', message: 'Pagamentos em configuração.' });
    return;
  }

  try {
    const b = req.body || {};
    const plano = String(b.plano || '').toLowerCase();
    if (!PLANOS[plano]) { res.status(400).json({ error: 'plano', message: 'Plano inválido.' }); return; }
    if (!b.access_token) { res.status(401).json({ error: 'auth', message: 'Sessão ausente.' }); return; }

    // 1) Identifica o tutor pelo token do Supabase.
    const userResp = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_ANON, Authorization: `Bearer ${b.access_token}` }
    });
    if (!userResp.ok) { res.status(401).json({ error: 'auth', message: 'Sessão inválida.' }); return; }
    const user = await userResp.json();
    if (!user.id) { res.status(401).json({ error: 'auth', message: 'Sessão inválida.' }); return; }

    const info = PLANOS[plano];

    // 2) Registra a assinatura como pendente (service_role ignora o RLS).
    const insResp = await fetch(`${SB_URL}/rest/v1/assinaturas`, {
      method: 'POST',
      headers: {
        apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`,
        'Content-Type': 'application/json', Prefer: 'return=representation'
      },
      body: JSON.stringify({
        tutor_id: user.id, plano, valor_centavos: info.centavos, status: 'pendente'
      })
    });
    if (!insResp.ok) {
      const detail = await insResp.text();
      res.status(500).json({ error: 'db', message: 'Falha ao registrar a assinatura.', detail });
      return;
    }
    const nova = (await insResp.json())[0];

    // 3) Cria a preapproval (assinatura recorrente mensal) no Mercado Pago.
    const base = process.env.APP_BASE_URL || `https://${req.headers.host}`;
    const preBody = {
      reason: `Patinha Viva - Plano ${info.nome}`,
      // external_reference carrega o que o webhook precisa sem consultar o banco.
      external_reference: `${user.id}|${plano}|${nova.id}`,
      payer_email: user.email,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        // start_date é OBRIGATÓRIO na prática: sem ele o Mercado Pago responde
        // 500 "Internal server error" ao criar a preapproval (em vez de um erro
        // de validação claro). Um pequeno buffer no futuro evita rejeição por
        // "start_date in the past" devido a diferença de relógio.
        start_date: new Date(Date.now() + 3 * 60 * 1000).toISOString(),
        transaction_amount: info.centavos / 100,
        currency_id: 'BRL'
      },
      back_url: `${base}/?assinatura=sucesso`,
      notification_url: `${base}/api/webhook-mp`,
      status: 'pending'
    };
    const mpResp = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(preBody)
    });
    const pre = await mpResp.json();
    if (!mpResp.ok || !(pre.init_point || pre.sandbox_init_point)) {
      res.status(502).json({ error: 'mp', message: 'Falha ao criar a assinatura.', detail: pre });
      return;
    }

    // 4) Guarda o preapproval_id na assinatura (best-effort).
    fetch(`${SB_URL}/rest/v1/assinaturas?id=eq.${nova.id}`, {
      method: 'PATCH',
      headers: {
        apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal'
      },
      body: JSON.stringify({ mp_preapproval_id: pre.id })
    }).catch(() => {});

    res.status(200).json({
      init_point: pre.init_point,
      sandbox_init_point: pre.sandbox_init_point,
      assinatura_id: nova.id
    });
  } catch (e) {
    res.status(500).json({ error: 'server', message: String((e && e.message) || e) });
  }
};
