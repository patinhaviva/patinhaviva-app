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

// Mensagens amigáveis para cada motivo de cupom inválido (cliente).
const CUPOM_MSG = {
  'nao-encontrado': 'Cupom não encontrado. Confira o código.',
  'inativo':        'Este cupom não está mais ativo.',
  'expirado':       'Este cupom expirou.',
  'esgotado':       'Este cupom atingiu o limite de usos.',
  'ja-usado':       'Você já usou este cupom.',
  'sem-codigo':     'Cupom inválido.',
  'sem-tutor':      'Sessão inválida.'
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
    const cupom = String(b.cupom || '').trim();
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

    // 1.1) CUPOM — pré-checagem READ-ONLY: se o código for inválido, falha já
    // aqui, ANTES de criar a linha de assinatura (sem deixar lixo no banco).
    if (cupom) {
      const v = await fetch(`${SB_URL}/rest/v1/rpc/cupom_validar`, {
        method: 'POST',
        headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_codigo: cupom })
      });
      const vr = await v.json().catch(() => ({}));
      if (!v.ok || !vr || vr.ok !== true) {
        const motivo = (vr && vr.motivo) || 'sem-codigo';
        res.status(400).json({ error: 'cupom', motivo, message: CUPOM_MSG[motivo] || 'Cupom inválido.' });
        return;
      }
    }

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

    // 2.1) CUPOM PROMOCIONAL (opcional): valida e RESERVA server-side. A função
    // cupom_resgatar é atômica (lock + checagem de ativo/validade/limite/uso
    // único) e devolve os MESES grátis. Nunca confiamos no cliente. Em falha do
    // MP mais abaixo, o uso é estornado (cupom_estornar).
    let freeMonths = 0, cupomUsoId = null;
    if (cupom) {
      const rpc = await fetch(`${SB_URL}/rest/v1/rpc/cupom_resgatar`, {
        method: 'POST',
        headers: {
          apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json'
        },
        body: JSON.stringify({ p_codigo: cupom, p_tutor: user.id, p_assinatura: nova.id })
      });
      const cr = await rpc.json().catch(() => ({}));
      if (!rpc.ok || !cr || cr.ok !== true) {
        const motivo = (cr && cr.motivo) || 'sem-codigo';
        res.status(400).json({ error: 'cupom', motivo, message: CUPOM_MSG[motivo] || 'Cupom inválido.' });
        return;
      }
      freeMonths = parseInt(cr.meses, 10) || 0;
      cupomUsoId = cr.uso_id || null;
    }

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
    // Mês(es) grátis do cupom: free_trial nativo do MP adia a 1ª cobrança.
    if (freeMonths > 0) {
      preBody.auto_recurring.free_trial = { frequency: freeMonths, frequency_type: 'months' };
    }
    const mpResp = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(preBody)
    });
    const pre = await mpResp.json();
    if (!mpResp.ok || !(pre.init_point || pre.sandbox_init_point)) {
      // MP falhou: estorna o uso do cupom para não "queimá-lo" à toa.
      if (cupomUsoId) {
        fetch(`${SB_URL}/rest/v1/rpc/cupom_estornar`, {
          method: 'POST',
          headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_uso: cupomUsoId })
        }).catch(() => {});
      }
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
