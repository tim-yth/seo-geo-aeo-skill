export async function onRequest(ctx) {
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=G-TEST12345&api_secret=${ctx.env.GA4_SECRET}`;
  return fetch(url, { method: 'POST', body: '{}' });
}
