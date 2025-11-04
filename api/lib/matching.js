// Rank & filter inventory with priority-first

function norm(s){ return String(s||'').toLowerCase(); }
function fuzzyHas(hay, needle){ return norm(hay).includes(norm(needle)); }

export function rankMatches(items, q){
  let arr = items.slice();

  // plan impacts which price we consider
  const priceField = q.plan === 'cash' ? (it => it.srp ?? it.cash_price) : (it => it.price_all_in ?? it.all_in);

  // hard filters
  if (q.body_type && q.body_type!=='any') {
    arr = arr.filter(it => fuzzyHas(it.body_type, q.body_type));
  }
  if (q.transmission && q.transmission!=='any') {
    arr = arr.filter(it => fuzzyHas(it.transmission, q.transmission));
  }
  if (q.model) {
    arr = arr.filter(it => fuzzyHas(it.model, q.model) || fuzzyHas(`${it.brand} ${it.model}`, q.model));
  }
  if (q.brand_model) {
    arr = arr.filter(it => fuzzyHas(`${it.brand} ${it.model}`, q.brand_model));
  }
  if (q.budget) {
    const lim = q.budget;
    arr = arr.filter(it => {
      const p = priceField(it);
      if (!p) return true;
      if (q.plan === 'cash') return Number(p) <= lim;     // cash: SRP <= budget
      // financing: budget is all-in range floor; allow +/- 20k
      return Number(p) >= lim - 20000 && Number(p) <= lim + 20000;
    });
  }

  // score
  arr = arr.map(it => {
    let score = 0;
    if (it.price_status && /priority/i.test(it.price_status)) score += 50;
    if (q.location && it.city && fuzzyHas(q.location, it.city)) score += 12;
    if (q.location && it.province && fuzzyHas(q.location, it.province)) score += 6;
    if (q.transmission && fuzzyHas(it.transmission, q.transmission)) score += 5;
    if (q.body_type && fuzzyHas(it.body_type, q.body_type)) score += 4;
    if (q.model && fuzzyHas(it.model, q.model)) score += 4;
    if (it.image_1) score += 2;
    return { it, score };
  }).sort((a,b)=> b.score - a.score).map(x=>x.it);

  return arr;
}
