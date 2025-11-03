// api/lib/matching.js

export async function fetchInventory(url) {
  const r = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
  const j = await r.json();
  if (!j || j.ok === false) {
    console.error('Inventory fetch error', j);
  }
  return j || { items: [] };
}

export function parseInventoryItem(raw) {
  // coerce fields defensively
  const it = { ...raw };
  it.year = num(it.year);
  it.brand = str(it.brand);
  it.model = str(it.model);
  it.variant = str(it.variant);
  it.city = str(it.city);
  it.province = str(it.province);
  it.body_type = str(it.body_type);
  it.transmission = str(it.transmission);
  it.price_status = str(it.price_status); // expect "Priority" or something else
  it.all_in = num(it.price_all_in || it.all_in || it['all-in'] || it.allin);
  it.mileage = num(it.mileage);
  // images already pre-converted by your Apps Script
  for (let i = 1; i <= 10; i++) it[`image_${i}`] = str(it[`image_${i}`]);
  return it;
}

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { const n = parseFloat((v ?? '').toString().replace(/[^\d.]/g,'')); return isFinite(n) ? n : null; }

function scoreItem(it, query) {
  let sc = 0;

  // Body type
  if (query.body && query.body !== 'any') {
    if (it.body_type && it.body_type.toLowerCase().includes(query.body)) sc += 5;
    else sc -= 3;
  }

  // Transmission
  if (query.trans && query.trans !== 'any') {
    const t = (it.transmission || '').toLowerCase();
    if (t.includes(query.trans)) sc += 4;
    else sc -= 2;
  }

  // Model hint
  if (query.modelHint) {
    const h = query.modelHint.toLowerCase();
    if ((it.model || '').toLowerCase().includes(h) || (it.brand || '').toLowerCase().includes(h)) sc += 6;
  }

  // Location soft boost
  if (query.location) {
    const loc = query.location.toLowerCase();
    const where = `${(it.city||'').toLowerCase()} ${ (it.province||'').toLowerCase() }`;
    if (where.includes(loc)) sc += 3;
  }

  // Budget soft check (works for either cash SRP or all-in)
  if (query.plan === 'cash') {
    const srp = num(it.srp);
    const inRange = approxInRange(query.budget, srp);
    if (inRange) sc += 4; else sc -= 1;
  } else {
    const allIn = num(it.price_all_in) ?? num(it.all_in);
    const inRange = approxInRange(query.budget, allIn);
    if (inRange) sc += 4; else sc -= 1;
  }

  // Mileage and recency tiny boosts
  if (isFinite(it.mileage)) sc += (it.mileage < 60000 ? 1 : 0);

  return sc;
}

function approxInRange(userBudgetText, value) {
  if (!value || !userBudgetText) return true; // do not exclude if unknown
  const s = userBudgetText.toString().toLowerCase();
  // accept "below 600k", "450k-600k", "150k to 220k", "around 500k"
  const nums = s.match(/\d[\d,\.]*/g);
  if (!nums || nums.length === 0) return true;
  const vals = nums.map(n => parseFloat(n.replace(/[^\d.]/g,'')));
  if (vals.length === 1) {
    const cap = vals[0];
    if (/below|under|max|hanggang|<=|less/i.test(s)) return value <= cap * 1.02;
    if (/above|over|>=/i.test(s)) return value >= cap * 0.98;
    // around
    return Math.abs(value - cap) <= cap * 0.15;
  } else {
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return value >= lo * 0.97 && value <= hi * 1.03;
  }
}

export function matchTopTwo(rows, query) {
  const items = rows.map(parseInventoryItem);

  const priority = items
    .filter(it => it.price_status.toLowerCase().includes('priority'))
    .map(it => ({ it, sc: scoreItem(it, query) }))
    .sort((a,b) => b.sc - a.sc)
    .slice(0, 2)
    .map(x => x.it);

  if (priority.length === 2) return { items: priority, usedPriority: true };
  if (priority.length === 1) {
    // fill one from non-priority
    const rest = items
      .filter(it => !it.price_status.toLowerCase().includes('priority'))
      .map(it => ({ it, sc: scoreItem(it, query) }))
      .sort((a,b) => b.sc - a.sc)
      .filter(x => x.it.model !== priority[0].model || x.it.sku !== priority[0].sku)
      .slice(0, 1)
      .map(x => x.it);
    return { items: [...priority, ...rest], usedPriority: true };
  }

  // No priority → take best 2 overall
  const best = items
    .map(it => ({ it, sc: scoreItem(it, query) }))
    .sort((a,b) => b.sc - a.sc)
    .slice(0, 2)
    .map(x => x.it);

  return { items: best, usedPriority: false };
}
