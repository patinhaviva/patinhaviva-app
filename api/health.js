// Endpoint de saúde do backend Patinha Viva (Vercel Functions).
// Prova que funções serverless rodam neste projeto. Não usa segredos.
// Removível a qualquer momento.
module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'patinhaviva-api',
    time: new Date().toISOString()
  });
};
