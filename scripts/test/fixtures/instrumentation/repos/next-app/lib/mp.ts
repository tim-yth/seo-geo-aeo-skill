export async function sendServerEvent() {
  await fetch('https://www.google-analytics.com/mp/collect?measurement_id=G-TEST12345&api_secret=SuperSecretValue123', { method: 'POST' });
}
