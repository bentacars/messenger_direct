// api/lib/matching.js

// Normalize strings
const norm = s => (s || '').toString().trim().toLowerCase();

export function scoreAndSelect(items, opts) {
  const {
    wanted = 4,
    preferPriority = true,
    body_type, transmission, model, brand, payment,
    budget_cash, budget_allin
  } = opts || {};

  // score
  const scored = (items || []).map(x => {
    let score = 0;

    // Priority boost
    if (preferPriority && norm(x.price_status) === 'priority') score += 1000;

    // Exact signals
    if (body_type && body_type !== 'any' && norm(x.body_type) === norm(body_type)) score += 120;
    if (transmission && transmission !== 'any' && norm(x.transmission).startsWith(norm(transmission))) score += 80;

    if (brand && norm(x.brand) === norm(brand)) score += 70;
    if (model && norm(x.model) === norm(model)) score += 120;
    if (model && norm(x.brand_model || '').includes(norm(model))) score += 60;

    // Budget fit
    if (payment === 'cash' && budget_cash) {
      const p = Number(x.srp || x.cash_price || 0);
      if (p) {
        if (p >= budget_cash.min && p <= budget_cash.max) score += 140;
        else {
          // small penalty for near-miss
          const delta = Math.abs(p - Math.max(budget_cash.min, Math.min(p, budget_cash.max)));
          score += Math.max(0, 80 - Math.min(80, delta / 10000)); // decay
        }
      }
    }
    if (payment === 'financing' && budget_allin) {
      const a = Number(x.price_all_in || x.all_in || 0);
      if (a) {
        if (a >= budget_allin.min && a <= budget_allin.max) score += 140;
        else score += 40; // near-miss
      }
    }

    // mileage lower is better (bonus)
    const km = Number(x.mileage || 0);
    if (km) score += Math.max(0, 60 - Math.min(60, km / 5000));

    // recency if available
    if (x.updated_at) score += 10;

    return {score, item: x};
  });

  // Sort by score desc; if tie, lower mileage first, then newer year
  scored.sort((a,b)=>{
    if (b.score !== a.score) return b.score - a.score;
    const kmA = Number(a.item.mileage||999999), kmB = Number(b.item.mileage||999999);
    if (kmA !== kmB) return kmA - kmB;
    const yA = Number(a.item.year||0), yB = Number(b.item.year||0);
    return yB - yA;
  });

  // If preferPriority but top has none with priority, it's still fine—no “no match” message here.
  return scored.slice(0, wanted).map(x => x.item);
}
