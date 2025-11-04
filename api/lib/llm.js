// Lightweight NLP + copy helpers focused on Taglish, short & human.

export function shortMoney(n){
  const v = Number(n||0);
  if (!isFinite(v) || v<=0) return '—';
  return v.toLocaleString('en-PH', { maximumFractionDigits: 0 });
}

// exact all-in → [exact, exact+20000] rounded to nearest 5k
export function allInBracket(ai){
  const base = Number(ai||0);
  const hi = base + 20000;
  const round5 = x => Math.round(x/5000)*5000;
  return [round5(base), round5(hi)];
}

export const humanize = {
  ask(line, state){
    // soften asks a bit, keep short
    if (!state.plan && /Cash or financing/i.test(line)) {
      return `Cash or financing ang plan mo?`;
    }
    if (!state.location && /Saan location/i.test(line)) {
      return `Saan location mo? (city/province)`;
    }
    return line;
  }
};

const BODY_WORDS = {
  sedan:['sedan'], suv:['suv'], mpv:['mpv'], van:['van'], pickup:['pickup','pick-up','truck']
};

function pickBody(text){
  const t = text.toLowerCase();
  for (const [k, arr] of Object.entries(BODY_WORDS)){
    if (arr.some(w => t.includes(w))) return k;
  }
  if (/\b(any|kahit ano)\b/i.test(text)) return 'any';
  return null;
}

function pickPlan(text){
  const t = text.toLowerCase();
  if (/\bfinanc(ing|e)?\b/.test(t)) return 'financing';
  if (/\bcash\b/.test(t)) return 'cash';
  return null;
}

function pickTrans(text){
  const t = text.toLowerCase();
  if (/\b(auto|automatic)\b/.test(t)) return 'automatic';
  if (/\b(manual|m/t)\b/.test(t)) return 'manual';
  if (/\bany\b/.test(t)) return 'any';
  return null;
}

function pickBudget(text){
  // accepts "550k below", "450-600k", "90k all in", "95k to 115k"
  const t = text.toLowerCase().replace(/[, ]/g,'');
  const m2 = t.match(/(\d{2,6})k(?:to|-)(\d{2,6})k/);
  if (m2) {
    const a = Number(m2[1])*1000, b = Number(m2[2])*1000;
    return Math.min(a,b); // we just keep a representative floor
  }
  const m = t.match(/(\d{2,6})k/);
  if (m) return Number(m[1])*1000;
  return null;
}

function extractModel(text){
  // crude: single word model candidates
  const m = text.match(/\b(vios|mirage|city|civic|innova|fortuner|hilux|xl7|terra|stargazer|accent|almera|altis|wagonr|urvan|nv350|traviz|k2500|g50)\b/i);
  return m ? m[1][0].toUpperCase()+m[1].slice(1).toLowerCase() : null;
}

function extractBrandModel(text){
  const m = text.match(/\b(toyota|mitsubishi|honda|nissan|isuzu|ford|suzuki|hyundai|kia)\s+([a-z0-9\-]+)\b/i);
  if (!m) return null;
  return `${cap(m[1])} ${cap(m[2])}`;
}
function cap(s){ return s ? s[0].toUpperCase()+s.slice(1).toLowerCase() : s; }

export function parseUtterance(text){
  return {
    plan: pickPlan(text),
    body_type: pickBody(text),
    transmission: pickTrans(text),
    budget: pickBudget(text),
    model: extractModel(text),
    brand_model: extractBrandModel(text),
    location: guessLocation(text)
  };
}

function guessLocation(text){
  // if looks like a city/province phrase, accept
  if (/\b(qc|quezon\s*city|makati|manila|pasig|taguig|caloocan|pasay|mandaluyong|parañaque|marikina|muntinlupa|cavite|laguna|bulacan|pampanga|rizal)\b/i.test(text)) {
    return text;
  }
  return null;
}
