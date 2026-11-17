// scripts/dtone-preprod-probe.js
require('dotenv').config();
const axios = require('axios');

const BASE = 'https://preprod-dvs-api.dtone.com/v1';
const AUTH = Buffer.from(
  `${process.env.DTONE_API_KEY}:${process.env.DTONE_API_SECRET}`
).toString('base64');

const client = axios.create({
  baseURL: BASE,
  headers: { Authorization: `Basic ${AUTH}`, Accept: 'application/json' },
  timeout: 15000,
});

async function fetchAll(path, params = {}) {
  let page = 1;
  const perPage = 100;
  const all = [];
  let total = null;

  while (true) {
    const res = await client.get(path, {
      params: { ...params, page, per_page: perPage },
    });
    const data = res.data;
    const items = Array.isArray(data) ? data : (data.items || data.data || []);
    total = res.headers['x-total'] ? Number(res.headers['x-total']) : total;
    all.push(...items);
    console.log(`  page ${page}: got ${items.length}, total so far ${all.length}`);
    if (items.length < perPage) break;
    page++;
    if (page > 50) { console.warn('  stopped at 50 pages'); break; }
  }
  return { items: all, total };
}

(async () => {
  console.log('=== DT One Preprod Probe ===\n');

  // 1. All services
  try {
    const svc = await client.get('/services', { params: { per_page: 100 } });
    const list = Array.isArray(svc.data) ? svc.data : (svc.data.items || []);
    console.log(`Services: ${list.length}`);
    list.forEach(s => console.log(`  id=${s.id}  ${s.name}`));
  } catch (e) {
    console.error('Services failed:', e.response?.status, e.response?.data || e.message);
  }

  // 2. Gift cards (service_id=4)
  console.log('\n--- Gift Cards (service_id=4) ---');
  try {
    const { items, total } = await fetchAll('/products', {
      service_id: '4',
      type: 'FIXED_VALUE_PIN_PURCHASE',
    });
    console.log(`Gift card products: ${items.length} fetched, header total=${total}`);
    const countries = [...new Set(items.map(p => p.operator?.country?.iso_code).filter(Boolean))];
    console.log(`Distinct countries: ${countries.length}`, countries.slice(0, 20));
    items.slice(0, 10).forEach(p => {
      console.log(`  id=${p.id}  ${p.name}  country=${p.operator?.country?.iso_code || '?'}`);
    });
  } catch (e) {
    console.error('Gift cards failed:', e.response?.status, e.response?.data || e.message);
  }

  // 3. eSIM (service_id=13)
  console.log('\n--- eSIM (service_id=13) ---');
  try {
    const { items, total } = await fetchAll('/products', { service_id: '13' });
    console.log(`eSIM products: ${items.length} fetched, header total=${total}`);
    const countries = [...new Set(
      items.flatMap(p => (p.regions || []).map(r => r.code))
    )];
    console.log(`Distinct region/country codes: ${countries.length}`, countries.slice(0, 20));
  } catch (e) {
    console.error('eSIM failed:', e.response?.status, e.response?.data || e.message);
  }

  // 4. Countries endpoint for gift cards
  console.log('\n--- Countries (service_id=4) ---');
  try {
    const { items } = await fetchAll('/countries', { service_id: '4' });
    console.log(`Countries with gift card coverage: ${items.length}`);
    console.log(items.slice(0, 20).map(c => c.iso_code || c.code));
  } catch (e) {
    console.error('Countries failed:', e.response?.status, e.response?.data || e.message);
  }
})();