// server/lib/matcher.js
import rules from '../config/rules.json' assert { type: 'json' };

const API = process.env.INVENTORY_API_URL;

function normalize(s) { return (s || '').toString().trim().toLowerCase(); }

export async function fetchMatches(state) {
  // Build query object; your API can ignore empty params
  const params = new URLSearchParams();
  if (state.payment) params.set('plan', state.payment);
  if (state.location) params.set('location', state.location);
  if (state.transmission) params.set('transmission', state.transmission);
  if (state.body) params.set('body_type', state.body);
  if (state.brand) params.set('brand', state.brand);
  if (state.model) params.set('model', state.model);
  if (state.variant) params.set('variant', state.variant);
  if (state.year) params.set('year', state.year);

  const url = `${API}?${params.toString()}`;
  const rsp = await fetch(url);
  const items = (await rsp.json()) || [];

  // Apply price logic client-side as safeguard
  const out = [];
  for (const u of items) {
    const srp = Number(u.srp || 0);
    const allIn = Number(u.all_in || 0);
    if (state.payment === 'cash') {
      if (!state.budget) continue;
      const ok = Math.abs(srp - state.budget) <= rules.price_logic.cash_srp_window;
      if (!ok) continue;
    } else if (state.payment === 'financing') {
      if (!state.budget) continue;
      const ok = allIn <= (state.budget + rules.price_logic.financing_allin_grace);
      if (!ok) continue;
    }
    out.push(u);
  }

  // priority first: price_status Priority, then OK
  out.sort((a, b) => {
    const pa = normalize(a.price_status);
    const pb = normalize(b.price_status);
    if (pa === pb) return 0;
    if (pa === 'priority') return -1;
    if (pb === 'priority') return 1;
    if (pa === 'ok to market') return -1;
    if (pb === 'ok to market') return 1;
    return 0;
  });

  return out.slice(0, rules.match_max_total);
}
