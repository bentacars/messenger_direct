// /server/flows/qualifier.js
// Human-style parser for Phase 1. Exports: absorb(), summary()

const GEO_WORDS = [
  'qc','quezon city','manila','makati','taguig','pasig','mandaluyong','marikina',
  'caloocan','valenzuela','malabon','navotas','pasay','parañaque','las piñas',
  'cavite','laguna','batangas','rizal','bulacan','pampanga','ncr','metro manila',
  'cebu','davao','iloilo','bacolod','cagayan de oro'
];

const BODY_TYPES = ['sedan','suv','mpv','van','pickup','hatchback','crossover','auv'];

export function absorb(current = {}, text = '') {
  const q = { ...current };
  const t = String(text || '').trim();
  const low = t.toLowerCase();

  // -------- payment intent (cash / financing)
  if (/(^|\b)(cash|spot\s?cash|full\s?(cash|payment))\b/.test(low)) q.payment = 'cash';
  if (/(loan|hulog|installment|amort|financ(e|ing)|all[- ]?in)\b/.test(low)) q.payment = 'financing';

  // -------- transmission
  if (/\b(auto|at|automatic)\b/.test(low)) q.transmission = 'automatic';
  if (/\b(manual|mt)\b/.test(low)) q.transmission = 'manual';
  if (/\b(any|kahit ano)\b/.test(low) && !q.transmission) q.transmission = 'any';

  // -------- body type
  for (const bt of BODY_TYPES) {
    if (new RegExp(`\\b${bt}\\b`).test(low)) { q.bodyType = bt; break; }
  }
  if (!q.bodyType && /\b7[\s-]?seater\b/.test(low)) q.bodyType = 'mpv';

  // -------- budget (cash SRP or financing all-in/cash-out)
  // support 550k, ₱550,000, 1.2m, 95k all-in
  const bud = low.match(/(?:₱|php|\b)(\d{1,3}(?:[.,]\d{3})+|\d+(?:\.\d+)?)(\s*m|\s*k)?/i);
  if (bud) {
    let raw = bud[1].replace(/[.,]/g,'');
    let val = Number(raw);
    if (/m\b/i.test(bud[2] || '')) val = val * 1_000_000;
    if (/k\b/i.test(bud[2] || '')) val = val * 1_000;
    q.budget = val; // Cash → SRP; Financing → all-in/cash-out
  }

  // -------- location (city/province/NCR + “malapit sa …”)
  const locFromWord = GEO_WORDS.find(w => low.includes(w));
  const locDirect = low.match(/\b(location|taga|from|area)\s*[:\-]?\s*([a-z\s\-]+)$/i);
  if (locFromWord) q.location = capWords(locFromWord);
  else if (locDirect) q.location = capWords(locDirect[2].trim());

  // -------- brand/model/variant/year as *preferences* (never block Phase 1)
  const year = low.match(/\b(20[01]\d|202[0-9])\b/);
  if (year) q.year = year[1];

  // simple brand/model picks (expand as needed)
  const brands = ['toyota','mitsubishi','honda','nissan','suzuki','ford','hyundai','kia','isuzu','chevrolet','mazda'];
  const models = ['vios','innova','fortuner','mirage','mirage g4','city','civic','wigo','raize','yaris','brv','br-v','xtrail','terra','ranger','everest','starex','traviz','k2500','wrangler'];
  const b = brands.find(x => low.includes(x));
  if (b) q.brand = capWords(b);
  // prefer multi-word models first
  const modelHit = models.sort((a,b)=>b.length-a.length).find(x => low.includes(x));
  if (modelHit) q.model = capWords(modelHit.replace(/\bg4\b/,'G4').replace(/\bbr-v\b/,'BR-V'));

  // variant (very loose)
  const varHit = low.match(/\b(e|vx|vx+|xe|g|e a\/?t|glx|gls|sport|premium|xlt|xl)\b/i);
  if (varHit) q.variant = capWords(varHit[0]);

  return q;
}

export function summary(q = {}) {
  const parts = [];
  if (q.payment) parts.push(q.payment === 'cash' ? 'Cash buyer' : 'Financing');
  if (q.budget) parts.push(`Budget ~ ₱${fmt(q.budget)}`);
  if (q.location) parts.push(`Location: ${q.location}`);
  if (q.transmission) parts.push(`Trans: ${cap(q.transmission)}`);
  if (q.bodyType) parts.push(`Body: ${cap(q.bodyType)}`);
  // prefs (soft)
  const prefs = [q.brand, q.model, q.year, q.variant].filter(Boolean).join(' ');
  if (prefs) parts.push(`Pref: ${prefs}`);
  return parts.join(' • ') || 'no qualifiers yet';
}

/* utils */
function cap(s=''){ return s.charAt(0).toUpperCase()+s.slice(1); }
function capWords(s=''){ return s.split(/\s+/).map(cap).join(' '); }
function fmt(n=0){ return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,','); }
