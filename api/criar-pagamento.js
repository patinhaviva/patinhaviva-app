// /api/criar-pagamento — cria o pedido da plaquinha e a preferência de pagamento
// (Mercado Pago Checkout Pro). O PREÇO é definido AQUI no servidor — nunca confiar
// no valor vindo do navegador.
//
// Variáveis de ambiente (configurar no painel do Vercel, nunca no código público):
//   MP_ACCESS_TOKEN            -> Access Token do Mercado Pago (TESTE e depois PRODUÇÃO)
//   SUPABASE_URL               -> https://lpddtwgqjtbpjvpslwtu.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  -> service_role (secret) do Supabase
//   SUPABASE_ANON_KEY          -> chave publishable/anon (para validar o token do usuário)
//   APP_BASE_URL (opcional)    -> ex.: https://patinhaviva-app.vercel.app

const PLAQUINHA_VALOR_CENTAVOS = 4990; // R$ 49,90
const FRETE_CENTAVOS = 2500;           // R$ 25,00

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method', message: 'Use POST.' }); return; }

  const MP_TOKEN  = process.env.MP_ACCESS_TOKEN;
  const SB_URL    = process.env.SUPABASE_URL;
  const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SB_ANON   = process.env.SUPABASE_ANON_KEY;

  // Enquanto os segredos não estiverem configurados, degrada de forma honesta.
  if (!MP_TOKEN || !SB_URL || !SB_SERVICE || !SB_ANON) {
    res.status(503).json({ error: 'config', message: 'Pagamentos em configuração.' });
    return;
  }

  try {
    const b = req.body || {};
    if (!b.access_token) { res.status(401).json({ error: 'auth', message: 'Sessão ausente.' }); return; }

    // 1) Identifica o tutor pelo token do Supabase (não confiar em id vindo do cliente).
    const userResp = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_ANON, Authorization: `Bearer ${b.access_token}` }
    });
    if (!userResp.ok) { res.status(401).json({ error: 'auth', message: 'Sessão inválida.' }); return; }
    const user = await userResp.json();
    if (!user.id) { res.status(401).json({ error: 'auth', message: 'Sessão inválida.' }); return; }

    // 2) Sanitiza o endereço.
    const s = v => (typeof v === 'string' ? v.trim() : '').slice(0, 200);
    const pedido = {
      tutor_id: user.id,
      tipo: 'plaquinha',
      descricao: 'Plaquinha QR Patinha Viva',
      valor_centavos: PLAQUINHA_VALOR_CENTAVOS,
      frete_centavos: FRETE_CENTAVOS,
      status: 'pendente',
      destinatario: s(b.destinatario), telefone: s(b.telefone),
      cep: s(b.cep), endereco: s(b.endereco), numero: s(b.numero),
      complemento: s(b.complemento), bairro: s(b.bairro),
      cidade: s(b.cidade), uf: s(b.uf).toUpperCase().slice(0, 2)
    };

    // 3) Registra o pedido (service_role ignora o RLS).
    const insResp = await fetch(`${SB_URL}/rest/v1/pedidos`, {
      method: 'POST',
      headers: {
        apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`,
        'Content-Type': 'application/json', Prefer: 'return=representation'
      },
      body: JSON.stringify(pedido)
    });
    if (!insResp.ok) {
      const detail = await insResp.text();
      res.status(500).json({ error: 'db', message: 'Falha ao registrar o pedido.', detail });
      return;
    }
    const novoPedido = (await insResp.json())[0];

    // 4) Cria a preferência de pagamento no Mercado Pago (Checkout Pro).
    const base = process.env.APP_BASE_URL || `https://${req.headers.host}`;
    const prefBody = {
      items: [{
        title: 'Plaquinha QR Patinha Viva', quantity: 1,
        currency_id: 'BRL', unit_price: PLAQUINHA_VALOR_CENTAVOS / 100
      }],
      shipments: { cost: FRETE_CENTAVOS / 100, mode: 'not_specified' },
      payer: { name: pedido.destinatario, email: user.email },
      external_reference: novoPedido.id,
      notification_url: `${base}/api/webhook-mp`,
      back_urls: {
        success: `${base}/?pedido=sucesso`,
        pending: `${base}/?pedido=pendente`,
        failure: `${base}/?pedido=falha`
      },
      auto_return: 'approved'
    };
    const mpResp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(prefBody)
    });
    const pref = await mpResp.json();
    if (!mpResp.ok || !(pref.init_point || pref.sandbox_init_point)) {
      res.status(502).json({ error: 'mp', message: 'Falha ao criar o pagamento.', detail: pref });
      return;
    }

    // 5) Guarda o preference_id no pedido (best-effort, não bloqueia a resposta).
    fetch(`${SB_URL}/rest/v1/pedidos?id=eq.${novoPedido.id}`, {
      method: 'PATCH',
      headers: {
        apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal'
      },
      body: JSON.stringify({ mp_preference_id: pref.id })
    }).catch(() => {});

    res.status(200).json({
      init_point: pref.init_point,
      sandbox_init_point: pref.sandbox_init_point,
      pedido_id: novoPedido.id
    });
  } catch (e) {
    res.status(500).json({ error: 'server', message: String((e && e.message) || e) });
  }
};
