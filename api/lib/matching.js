import fetch from 'node-fetch';

/* ================== Inventory fetch ================== */
export async function fetchInventory() {
  const url = process.env.INVENTORY_ENDPOINT;
  if (!url) throw new Error('INVENTORY_ENDPOINT not set');
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Inventory fetch failed: ${r.status}`);
  if (Array.isArray(j.items)) return j.items;
  if (Array.isArray(j.data))  return j.data;
  if (Array.isArray(j))       return j;
  return [];
}

/* ================== Utils ================== */
const STATIC_TOKENS = [
  'suv','sedan','mpv','hatchback','pickup','van','vios','fortuner','innova','terra','xpander','stargazer',
  'l300','hiace','grandia','commuter','urvan','nv350','avanza','altis','wigo','brv','br-v','brio',
  'civic','city','accent','elantra','everest','ranger','traviz','carry','k2500'
];

const asNum = v => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.]/g,''));
  return isFinite(n) ? n : null;
};

/* ---------- Image helpers (use your already-converted links) ---------- */
export function imageList(row, start = 1, end = 10) {
  const list = [];
  for (let i = start; i <= end; i++) {
    const k = `image_${i}`;
    const v = row?.[k];
    if (v && String(v).trim()) list.push(String(v).trim());
  }
  return list;
}

export function firstFiveImages(row) {
  return imageList(row, 1, 5);   // send on offer
}

export function extraImages(row) {
  return imageList(row, 6, 10);  // send when buyer asks for more
}

function tokensFromInventory(inv) {
  const set = new Set(STATIC_TOKENS);
  for (const r of inv) {
    const s = [r?.brand, r?.model, r?.variant, r?.brand_model]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    s.split(/[^a-z0-9\-]+/i).forEach(t => { if (t && t.length >= 3) set.add(t); });
  }
  return Array.from(set);
}

/* ================== Wants extraction ================== */
export function extractWants(history, inventory) {
  const text = history.map(m => m.content).join(' ').toLowerCase();
  const wants = {
    payment: /financ/i.test(text) ? 'financing' : (/cash/i.test(text) ? 'cash' : null),
    cash_budget_min: null, cash_budget_max: null,
    dp_min: null, dp_max: null,
    city: null, province: null,
    preferred_type_or_model: null
  };

  // cash range: "400k-500k"
  const range = text.match(/(\d[\d,\.]*)\s*[-–]\s*(\d[\d,\.]*)/);
  if (range && wants.payment === 'cash') {
    const a = asNum(range[1]), b = asNum(range[2]);
    if (a && b) { wants.cash_budget_min = Math.min(a,b); wants.cash_budget_max = Math.max(a,b); }
  } else if (wants.payment === 'cash') {
    const one = text.match(/(?:budget|cash)\D{0,8}(\d[\d,\.]*)/);
    const v = one && asNum(one[1]);
    if (v) { wants.cash_budget_min = v*0.9; wants.cash_budget_max = v*1.1; }
  }

  // financing DP: "dp 120k"
  const dp = text.match(/(?:dp|down ?payment)[^\d]{0,8}(\d[\d,\.]*)/);
  const dv = dp && asNum(dp[1]);
  if (dv && wants.payment === 'financing') { wants.dp_min = dv*0.9; wants.dp_max = dv*1.1; }

  // simple city detect
  const cityHit = text.match(/\b(quezon city|qc|manila|makati|pasig|pasay|taguig|mandaluyong|marikina|caloocan|antipolo|cebu|davao|cavite|parañaque|las piñas|muntinlupa)\b/);
  if (cityHit) wants.city = cityHit[0];

  // model/type detection (static + dynamic)
  const dyn = tokensFromInventory(inventory);
  wants.preferred_type_or_model = dyn.find(t => text.includes(t)) || null;

  return wants;
}

export function relaxWants(w) {
  const c = { ...w };
  if (c.cash_budget_min != null) c.cash_budget_min *= 0.85;
  if (c.cash_budget_max != null) c.cash_budget_max *= 1.25;
  if (c.dp_min != null)          c.dp_min          *= 0.85;
  if (c.dp_max != null)          c.dp_max          *= 1.25;
  c.city = null; // relax city constraint
  return c;
}

/* ================== Scoring & ranking ================== */
function scoreRow(r, w) {
  const n = s => (s ?? '').toString().trim().toLowerCase();
  const srp   = asNum(r.srp ?? r.price);
  const allIn = asNum(r.all_in);
  let score = 0;

  if (w.payment === 'cash' && srp != null && w.cash_budget_min != null && w.cash_budget_max != null) {
    score += (srp >= w.cash_budget_min && srp <= w.cash_budget_max) ? 60
          :  (srp >= w.cash_budget_min*0.9 && srp <= w.cash_budget_max*1.1) ? 40 : 0;
  }
  if (w.payment === 'financing' && allIn != null && w.dp_min != null && w.dp_max != null) {
    score += (allIn >= w.dp_min && allIn <= w.dp_max) ? 60
          :  (allIn >= w.dp_min*0.9 && allIn <= w.dp_max*1.1) ? 40 : 0;
  }

  const city = n(r.city), prov = n(r.province);
  if (w.city && city && city === n(w.city)) score += 20;
  else if (w.province && prov && prov === n(w.province)) score += 12;

  const blob = [r.brand, r.model, r.variant, r.body_type].map(x => n(x)).join(' ');
  if (w.preferred_type_or_model && blob.includes(n(w.preferred_type_or_model))) score += 15;

  const yr = Number(r.year) || 0;
  score += Math.min(Math.max(yr - 2000, 0), 5) * 0.5;

  return score;
}

export function rankMatches(rows, wants) {
  return rows.map(r => ({ score: scoreRow(r, wants), row: r }))
             .sort((a,b) => b.score - a.score)
             .map(x => x.row);
}

export function cardText(row, wants) {
  const brand = row.brand || '';
  const model = row.model || '';
  const variant = row.variant || '';
  const year = row.year || '';
  const city = row.city || '';
  const mileage = row.mileage ? `${row.mileage} km` : '';
  const priceLabel = wants.payment === 'financing' ? 'All-in' : 'Price';
  const priceVal   = wants.payment === 'financing' ? (row.all_in ?? row.srp ?? '') : (row.srp ?? row.price ?? '');
  return `${year} ${brand} ${model} ${variant}\n${priceLabel}: ₱${priceVal}\n${city}${mileage ? ' — ' + mileage : ''}`;
}
