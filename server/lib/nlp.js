const BODY_MAP = {
  sedan:'sedan', suv:'suv', mpv:'mpv', van:'van', pickup:'pickup',
  auv:'auv', hatch:'hatchback', hatchback:'hatchback', crossover:'crossover'
};

export function parseUtterance(textRaw) {
  const text = (textRaw||'').toLowerCase().trim();

  const out = {
    plan:null, budget:null, location:null, transmission:null, body_type:null,
    brand_pref:null, model_pref:null, year_pref:null, variant_pref:null,
    commands:{ restart:false }
  };

  if (!text) return out;

  // restart command
  if (text === 'restart' || text === '/restart') { out.commands.restart = true; return out; }

  // plan
  if (/\bcash\b|spot cash|full payment|straight\b/.test(text)) out.plan = 'cash';
  if (/\bfinanc|all[- ]?in|hulog\b/.test(text)) out.plan = 'financing';

  // transmission
  if (/\b(automatic|a\/?t|auto)\b/.test(text)) out.transmission = 'automatic';
  if (/\b(manual|m\/?t|stick)\b/.test(text)) out.transmission = 'manual';
  if (/\b(any)\b/.test(text)) out.transmission = 'any';

  // body type
  for (const k of Object.keys(BODY_MAP)) {
    if (text.includes(k)) { out.body_type = BODY_MAP[k]; break; }
  }
  // crude location extraction: capture words like qc, quezon city, cavite, cebu, etc.
  const locMatch = text.match(/\b(qc|quezon city|manila|makati|pasig|taguig|valenzuela|caloocan|mandaluyong|pasay|marikina|muntinlupa|parañaque|cavite|laguna|batangas|rizal|bulacan|pampanga|cebu|davao|iloilo|bacolod|cagayan de oro|ncr|metro manila)\b/);
  if (locMatch) out.location = locMatch[0];

  // budget: looks for patterns like 550k, 600,000 etc.
  const money = text.replace(/[,₱\s]/g,'').match(/\b(\d{3,7})k?\b/);
  if (money) {
    let val = Number(money[1]);
    if (/k\b/.test(text)) val *= 1000;
    out.budget = val; // cash budget or cash-out (depending on plan; we only collect here)
  }

  // simple brand/model/year/variant preference capture (optional)
  const year = text.match(/\b(20\d{2}|19\d{2})\b/);
  if (year) out.year_pref = year[1];

  return out;
}
