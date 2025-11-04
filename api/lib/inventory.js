// Fetch inventory JSON from your Apps Script endpoint.
// Expect: array of rows with headers you gave (SKU, brand, model, year, ... image_1..10, srp, all_in, 2yrs/3yrs/4yrs, price_status, city, province, ...)
const INV_URL = process.env.INVENTORY_API_URL;

let _cache = { ts: 0, data: [] };
const CACHE_MS = 60 * 1000;

export async function fetchInventory() {
  const now = Date.now();
  if (now - _cache.ts < CACHE_MS && _cache.data.length) return _cache.data;

  const r = await fetch(INV_URL, { method: 'GET' });
  if (!r.ok) throw new Error(`Inventory fetch failed ${r.status}`);
  const data = await r.json();
  _cache = { ts: now, data: Array.isArray(data) ? data : [] };
  return _cache.data;
}
