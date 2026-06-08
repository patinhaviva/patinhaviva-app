// /api/criar-conta-e-assinar — cria a conta do PAGANTE já confirmada (via
// service_role) e a assinatura recorrente, num passo só. Usado pelo fluxo
// "Criar conta e assinar" vindo da landing.
//
// Por que a conta nasce confirmada SEM afetar os cadastros gratuitos:
//  - o cartão (pagamento) é prova de identidade muito mais forte que um clique
//    no e-mail; e o e-mail é validado por DUPLA DIGITAÇÃO no cliente.
//  - a confirmação de e-mail do Supabase continua LIGADA globalmente, então o
//    cadastro gratuito (tela normal) segue exigindo confirmação. Aqui usamos a
//    API admin para marcar email_confirm=true só nesta conta de pagante.
//
// Env (Vercel): MP_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_BASE_URL.

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

  if (!MP_TOKEN || !SB_URL || !SB_SERVICE) {
    res.status(503).json({ error: 'config', message: 'Pagamentos em configuração.' });
    return;
  }

  try {
    const b = req.body || {};
    const plano = String(b.plano || '').toLowerCase();
    const email = String(b.email || '').trim().toLowerCase();
    const senha = String(b.password || '');
    if (!PLANOS[plano]) { res.status(400).json({ error: 'plano', message: 'Plano inválido.' }); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: 'email', message: 'E-mail inválido.' }); return; }
    if (senha.length < 6) { res.status(400).json({ error: 'senha', message: 'A senha precisa ter pelo menos 6 caracteres.' }); return; }

    const info = PLANOS[plano];
    const svc = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json' };

    // 1) Cria o usuário JÁ CONFIRMADO (API admin / service_role).
    const userResp = await fetch(`${SB_URL}/auth/v1/admin/users`, {
      method: 'POST', headers: svc,
      body: JSON.stringify({ email, password: senha, email_confirm: true })
    });
    const userOut = await userResp.json().catch(() => ({}));
    if (!userResp.ok) {
      const msg = String(userOut.msg || userOut.error_description || userOut.error || '').toLowerCase();
      if (userResp.status === 422 || msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
        res.status(409).json({ error: 'existe', message: 'Esse e-mail já tem conta. Faça login para assinar.' });
        return;
      }
      res.status(500).json({ error: 'auth', message: 'Não foi possível criar a conta.', detail: userOut });
      return;
    }
    const userId = userOut.id || (userOut.user && userOut.user.id);
    if (!userId) { res.status(500).json({ error: 'auth', message: 'Conta criada sem id.' }); return; }

    // 2) Registra a assinatura como pendente (service_role ignora o RLS).
    const insResp = await fetch(`${SB_URL}/rest/v1/assinaturas`, {
      method: 'POST',
      headers: { ...svc, Prefer: 'return=representation' },
      body: JSON.stringify({ tutor_id: userId, plano, valor_centavos: info.centavos, status: 'pendente' })
    });
    if (!insResp.ok) {
      const detail = await insResp.text();
      res.status(500).json({ error: 'db', message: 'Falha ao registrar a assinatura.', detail });
      return;
    }
    const nova = (await insResp.json())[0];

    // 3) Cria a preapproval (assinatura mensal) no Mercado Pago.
    //    start_date é OBRIGATÓRIO na prática (sem ele o MP responde 500).
    const base = process.env.APP_BASE_URL || `https://${req.headers.host}`;
    const preBody = {
      reason: `Patinha Viva - Plano ${info.nome}`,
      external_reference: `${userId}|${plano}|${nova.id}`,
      payer_email: email,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
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
      headers: { ...svc, Prefer: 'return=minimal' },
      body: JSON.stringify({ mp_preapproval_id: pre.id })
    }).catch(() => {});

    res.status(200).json({
      init_point: pre.init_point,
      sandbox_init_point: pre.sandbox_init_point
    });
  } catch (e) {
    res.status(500).json({ error: 'server', message: String((e && e.message) || e) });
  }
};
