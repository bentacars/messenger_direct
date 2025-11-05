// /server/flows/qualifier.js
// Exports named functions: absorb(), summary()

/** Parse freeform Taglish text into qualifier fields. */
export function absorb(current = {}, text = '') {
  const q = { ...current };
  const t = String(text || '').toLowerCase();

  // payment: cash | financing
  if (/(^|\b)(cash|spot cash|full cash|full payment|lump sum|straight)\b/.test(t)) {
    q.payment = 'cash';
  }
  if (/(^|\b)(loan|financ(ing|e)|installment|hulugan|amort)/.test(t)) {
    q.payment = 'financing';
  }

  // transmission: automatic | manual | any
  if (/\b(auto|at|automatic)\b/.test(t)) q.transmission = 'automatic';
  if (/\b(manual|mt)\b/.test(t)) q.transmission = 'manual';
  if (/\b(any|kahit ano)\b/.test(t) && !q.transmission) q.transmission = 'any';

  // body type
  const bodyMap = {
    sedan: /\bsedan\b/,
    suv: /\bsuv\b/,
    mpv: /\bmpv\b/,
    van: /\bvan\b/,
    pickup: /\bpick[\s-]?up\b/,
    hatchback: /\bhatch(back)?\b/,
    crossover: /\bcross(over)?\b/,
    any: /\b(any|kahit ano)\b/
  };
  for (const [key, rx] of Object.entries(bodyMap)) {
    if (rx.test(t)) { q.bodyType = key; break; }
  }

  // budget (accepts formats like 500k, 750,000, ₱1.2m, 1.2m)
  const money = t.match(/(?:₱|\b)(\d{1,3}(?:[.,]\d{3})+|\d+(?:\.\d+)?)(\s*m\b)?/i);
  if (money) {
    let num = money[1].replace(/[.,]/g, '');
    let val = Number(num);
    if (money[2]) val = val * 1_000_000;        // “1.2m”
    // Heuristic: if small (<= 2,000,000) but written like 500k (no 'm'), keep as is
    q.budget = val;
  }

  // location (very loose; grab phrase after 'sa' or 'taga' or 'location')
  const locMatch =
    t.match(/\bsa\s+([a-z\s\-]+)$/i) ||
    t.match(/\btaga\s+([a-z\s\-]+)\b/i) ||
    t.match(/\blocation[:\s-]+([a-z\s\-]+)\b/i);
  if (locMatch) q.location = capitalize(locMatch[1].trim());

  return q;
}

export function summary(q = {}) {
  const parts = [];
  if (q.payment) parts.push(q.payment === 'cash' ? 'Cash buyer' : 'Financing');
  if (q.budget) parts.push(`Budget ~ ₱${formatMoney(q.budget)}`);
  if (q.location) parts.push(`Location: ${q.location}`);
  if (q.transmission) parts.push(`Trans: ${cap(q.transmission)}`);
  if (q.bodyType) parts.push(`Body: ${cap(q.bodyType)}`);
  return parts.join(' • ') || 'no qualifiers yet';
}

/* ---------------- utils ---------------- */
function cap(s=''){ return s.charAt(0).toUpperCase() + s.slice(1); }
function capitalize(s=''){ return s.split(/\s+/).map(cap).join(' '); }
function formatMoney(n=0){
  const x = Math.round(Number(n) || 0);
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
