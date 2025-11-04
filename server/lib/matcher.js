// Rank by: Priority tag > budget fit > body type > transmission > prefs > low mileage
const K = (x)=> Number(String(x??'').replace(/[^\d]/g,'')) || 0;
const has = (s, k)=> String(s||'').toLowerCase().includes(String(k||'').toLowerCase());

function fitsBudgetCash(u, budget) {
  if (!budget) return 1;
  const srp = K(u.srp);
  return (srp >= budget - 50000 && srp <= budget + 50000) ? 1 : 0;
}
function fitsBudgetFin(u, budget) {
  if (!budget) return 1;
  const ai = K(u.all_in);
  return ai && (ai <= budget + 50000) ? 1 : 0;
}
function txMatch(uTx, pref) {
  if (!pref || pref === 'any') return true;
  const a = String(uTx||'').toLowerCase();
  if (pref === 'automatic') return /(a\/?t|automatic|auto)/.test(a);
  if (pref === 'manual')    return /(m\/?t|manual)/.test(a);
  return has(a, pref);
}

export function rank(units, slots) {
  const scored = units.map(u => {
    let sc = 0;

    if (String(u.price_status||'').toLowerCase().includes('priority')) sc += 10;

    if (slots.plan === 'cash')  sc += fitsBudgetCash(u, K(slots.budget)) * 4;
    if (slots.plan === 'financing') sc += fitsBudgetFin(u, K(slots.budget)) * 4;

    if (slots.body_type && String(u.body_type||'').toLowerCase() === String(slots.body_type).toLowerCase()) sc += 4;
    if (txMatch(u.transmission, slots.transmission)) sc += 2;

    // optional prefs
    if (slots.model_pref && has(u.model, slots.model_pref)) sc += 3;
    if (slots.brand_pref && has(u.brand, slots.brand_pref)) sc += 2;
    if (slots.year_pref  && String(u.year)===String(slots.year_pref)) sc += 1;

    if (u.mileage && Number(u.mileage) < 30000) sc += 1;

    return { u, sc };
  });

  scored.sort((a,b)=> b.sc - a.sc);
  return scored.map(x=> x.u);
}
