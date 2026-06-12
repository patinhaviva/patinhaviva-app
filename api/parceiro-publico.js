// /api/parceiro-publico — endpoint PÚBLICO usado pela landing.
//
// GET /api/parceiro-publico?ref=PV001
//   → { ok:true, nome_fantasia:"Clínica Amigo Fiel", tipo:"clinica" }   (parceiro ativo)
//   → { ok:false }                                                       (não existe/ inativo)
//
// Faz DUAS coisas numa chamada só:
//   1) devolve dados NÃO-sensíveis do parceiro (nome + tipo) p/ a mensagem
//      personalizada "Você veio por indicação de ...";
//   2) registra o CLIQUE (ip_hash + user agent + utm) para o rastreamento.
//
// A landing roda em patinhaviva.com.br e chama este endpoint em
// patinhaviva-app.vercel.app → CROSS-ORIGIN. Por isso devolvemos CORS aberto
// (o conteúdo é público e não sensível) e tratamos o preflight OPTIONS.
//
// Env (Vercel): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Degrada honesto sem elas.

const crypto = require('crypto');

module.exports = async (req, res) => {
  // CORS — público.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const SB_URL = process.env.SUPABASE_URL;
  const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const q = req.query || {};
  const ref = String(q.ref || '').trim();
  if (!ref) { res.status(200).json({ ok: false }); return; }
  if (!SB_URL || !SB_SERVICE) { res.status(200).json({ ok: false, note: 'sem config' }); return; }

  const rpc = (fn, payload) => fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  try {
    // 1) dados públicos do parceiro
    const r = await rpc('pv_parceiro_publico', { p_ref: ref });
    const info = r.ok ? await r.json() : null;

    // 2) registra o clique (best-effort — nunca derruba a resposta)
    try {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const ip  = xff || req.socket?.remoteAddress || '';
      const ipHash = ip ? crypto.createHash('sha256').update(ip + '|pv-ref').digest('hex').slice(0, 32) : null;
      const ua = String(req.headers['user-agent'] || '').slice(0, 400);
      await rpc('pv_registrar_clique', {
        p_ref: ref, p_ip_hash: ipHash, p_ua: ua,
        p_utm_source: q.utm_source || null, p_utm_medium: q.utm_medium || null, p_utm_campaign: q.utm_campaign || null
      });
    } catch (e) { /* clique é best-effort */ }

    if (info && info.ok) {
      res.status(200).json({ ok: true, nome_fantasia: info.nome_fantasia, tipo: info.tipo });
    } else {
      res.status(200).json({ ok: false });
    }
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};
