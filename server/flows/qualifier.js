// /server/flows/qualifier.js
// Conversational qualifier parser (Taglish). Exports: absorb(), summary()

/* ---------------- utils ---------------- */
const norm = (s) => String(s || '').trim();
const lower = (s) => norm(s).toLowerCase();

function parseNumberPeso(txt) {
  // accepts: "550k", "1.2m", "₱485,000", "below 100k", "under 80k", "500-600k"
  const t = lower(txt).replace(/[₱,]/g, '').replace(/\s+/g, ' ').trim();

  // range: choose midpoint
  const range = t.match(/(\d+(\.\d+)?)(k|m)?\s*[-–]\s*(\d+(\.\d+)?)(k|m)?/);
  if (range) {
    const a = toPeso(range[1], range[3]);
    const b = toPeso(range[4], range[6]);
    return Math.round((a + b) / 2);
  }

  // below/under
  const below = t.match(/(below|under|less\s*than|hanggang)\s*(\d+(\.\d+)?)(k|m)?/);
  if (below) return toPeso(below[2], below[4]);

  // plain single number
  const one = t.match(/(\d+(\.\d+)?)(k|m)?/);
  if (one) return toPeso(one[1], one[3]);

  return null;

  function toPeso(numStr, suffix) {
    let n = parseFloat(numStr);
    const s = (suffix || '').toLowerCase();
    if (s === 'k') n *= 1_000;
    else if (s === 'm') n *= 1_000_000;
    return Math.round(n);
  }
}

function normalizeLocation(txt) {
  const t = lower(txt);
  if (!t) return '';
  // very light mapping
  if (/\bqc\b|\bquezon\s*city\b/.test(t)) return 'Quezon City';
  if (/\bmakati\b/.test(t)) return 'Makati';
  if (/\bpasig\b/.test(t)) return 'Pasig';
  if (/\bmandaluyong\b/.test(t)) return 'Mandaluyong';
  if (/\bmanila\b/.test(t)) return 'Manila';
  if (/\bcavite\b/.test(t)) return 'Cavite';
  if (/\blaguna\b/.test(t)) return 'Laguna';
  if (/\bbulacan\b/.test(t)) return 'Bulacan';
  if (/\bpampanga\b/.test(t)) return 'Pampanga';
  if (/\bcebu\b/.test(t)) return 'Cebu';
  if (/\bdavao\b/.test(t)) return 'Davao';
  // first word fallback (city/province-like)
  const m = t.match(/\b([a-zñ\- ]{2,20})\b/);
  return m ? m[1].replace(/\b\w/g, c => c.toUpperCase()) : '';
}

function pickTransmission(t) {
  if (/\b(at|automatic|auto)\b/.test(t)) return 'automatic';
  if (/\b(mt|manual)\b/.test(t)) return 'manual';
  if (/\b(any|kahit\s*ano)\b/.test(t)) return 'any';
  return '';
}

function pickBodyType(t) {
  if (/\bsedan\b/.test(t)) return 'sedan';
  if (/\b(suv|crossover)\b/.test(t)) return 'suv';
  if (/\bmpv\b|\b7\+?\s*seater\b|\bseven\b/.test(t)) return 'mpv';
  if (/\bvan\b/.test(t)) return 'van';
  if (/\bpick[\s-]?up\b/.test(t)) return 'pickup';
  if (/\bhatch(back)?\b/.test(t)) return 'hatchback';
  if (/\b(any|kahit\s*ano)\b/.test(t)) return 'any';
  return '';
}

function pickPayment(t) {
  if (/\b(hulugan|installment|financ(e|ing)|loan|utang)\b/.test(t)) return 'financing';
  if (/\b(spot\s*cash|straight|cash\s*basis|cash)\b/.test(t)) return 'cash';
  return '';
}

function parseBrandModelVariantYear(t) {
  // very light heuristic to capture mentions like "mirage glx 2020", "vios xe", "honda city"
  const brands = [
    'toyota','mitsubishi','honda','nissan','hyundai','kia','suzuki','ford','chevrolet',
    'isuzu','mazda','mg','geely','subaru','bmw','mercedes','audi','porsche','changan','gac'
  ];
  const bt = lower(t);

  let brand = '';
  for (const b of brands) {
    if (new RegExp(`\\b${b}\\b`).test(bt)) { brand = capitalize(b); break; }
  }

  // model: the token after brand, or common PH models
  const commonModels = [
    'vios','mirage','city','civic','altis','innova','fortuner','everest','raize','wigo','brv','br-v',
    'xtrail','almera','terra','expander','xpander','stargazer','safari','yaris','jazz','accent',
    'elantra','picanto','rio','soluto','sportage','seltos','ertiga','jimny','swift'
  ];
  let model = '';
  if (brand) {
    const m = bt.match(new RegExp(`\\b${brand.toLowerCase()}\\s+([a-z0-9\\-]+)\\b`));
    if (m) model = capitalize(m[1]);
  }
  if (!model) {
    for (const m of commonModels) {
      if (new RegExp(`\\b${m}\\b`).test(bt)) { model = capitalize(m); break; }
    }
  }

  // variant
  let variant = '';
  const varMatch = bt.match(/\b(glx|gls|ge|ge-x|xe|e|g|g-at|g-mt|vx|rs|sport|trend|titanium|premium|xlt|hline|highline)\b/);
  if (varMatch) variant = varMatch[1].toUpperCase();

  // year
  const y = bt.match(/\b(20\d{2}|19\d{2})\b/);
  const year = y ? y[1] : '';

  return { brand, model, variant, year };

  function capitalize(s) { return s ? s.replace(/\b\w/g, c => c.toUpperCase()) : s; }
}

/* ---------------- core: absorb ---------------- */
export function absorb(prev = {}, userText = '') {
  const q = { ...(prev || {}) };
  const t = lower(userText);

  // payment
  if (!q.payment) {
    const p = pickPayment(t);
    if (p) q.payment = p;
  }

  // budget
  if (!q.budget) {
    const n = parseNumberPeso(t);
    if (Number.isFinite(n) && n > 0) q.budget = n;
  }

  // location
  if (!q.location) {
    // “taga qc ako”, “from pasig”, “qc lang ako”
    const locHint = t.match(/\b(qc|quezon\s*city|makati|pasig|mandaluyong|manila|cavite|laguna|bulacan|pampanga|cebu|davao)\b/);
    if (locHint) q.location = normalizeLocation(locHint[0]);
  }

  // transmission
  if (!q.transmission) {
    const tr = pickTransmission(t);
    if (tr) q.transmission = tr;
  }

  // body type
  if (!q.bodyType) {
    const bt = pickBodyType(t);
    if (bt) q.bodyType = bt;
    // heuristic: if user said "mirage"/"vios" and no body type, assume sedan/hatch appropriately
    const cm = lower(q.model || '');
    if (!q.bodyType && /mirage|wigo|swift|picanto|brio/.test(cm)) q.bodyType = 'hatchback';
    if (!q.bodyType && /vios|city|civic|altis|elantra|yaris/.test(cm)) q.bodyType = 'sedan';
  }

  // preference: brand/model/year/variant
  const pref = parseBrandModelVariantYear(t);
  if (pref.brand && !q.brand) q.brand = pref.brand;
  if (pref.model && !q.model) q.model = pref.model;
  if (pref.variant && !q.variant) q.variant = pref.variant;
  if (pref.year && !q.year) q.year = pref.year;

  return q;
}

/* ---------------- summary for Phase 2 preface ---------------- */
export function summary(q = {}) {
  const parts = [];
  if (q.payment) parts.push(`Payment: ${cap(q.payment)}`);
  if (q.budget) parts.push(`Budget: ₱${Number(q.budget).toLocaleString('en-PH')}`);
  if (q.location) parts.push(`Location: ${q.location}`);
  if (q.transmission) parts.push(`Trans: ${cap(q.transmission)}`);
  if (q.bodyType) parts.push(`Body: ${cap(q.bodyType)}`);
  const pref = [q.brand, q.model, q.variant, q.year].filter(Boolean).join(' ');
  if (pref) parts.push(`Pref: ${pref}`);
  return parts.join(' • ');

  function cap(s){ return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
}

export default { absorb, summary };
