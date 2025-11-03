// /api/lib/matching.js

// Pull from Apps Script endpoint
export async function fetchInventory(INVENTORY_API_URL, query) {
  // The Apps Script you deployed supports GET with ?q=...
  const url = new URL(INVENTORY_API_URL);
  url.searchParams.set('q', JSON.stringify(query || {}));
  const res = await fetch(url.toString(), { method: 'GET' });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Inventory API error');
  return data.items || [];
}

// Basic score + priority selection
export function pickTopTwo(items, want = {}) {
  // priority first
  const scored = items.map((it) => {
    let s = 0;
    if ((it.price_status || '').toLowerCase() === 'priority') s += 1000;

    if (want.model && it.model) {
      const a = (want.model || '').toLowerCase();
      const b = (it.model || '').toLowerCase();
      if (b.includes(a)) s += 50;
    }
    if (want.brand && it.brand) {
      if ((it.brand || '').toLowerCase() === (want.brand || '').toLowerCase()) s += 30;
    }
    if (want.body_type && it.body_type) {
      if ((it.body_type || '').toLowerCase() === (want.body_type || '').toLowerCase()) s += 20;
    }
    if (want.transmission && it.transmission) {
      if ((it.transmission || '').toLowerCase().startsWith((want.transmission || '').toLowerCase())) s += 10;
    }
    // Simple budget proximity (prefers closer all_in or srp)
    const target = want.mode === 'financing' ? num(want.cash_on_hand) : num(want.budget);
    const price = want.mode === 'financing' ? num(it.all_in) : num(it.srp);
    if (target && price) {
      const diff = Math.abs(price - target);
      s += Math.max(0, 200 - Math.min(200, Math.round(diff / 10000))); // up to +200
    }

    return { it, score: s };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map(x => x.it);
}

const num = (v) => (typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.]/g, ''))) || 0;

export function unitTitle(u) {
  const year = u.year ? String(u.year) : '';
  const name = [u.brand, u.model, u.variant].filter(Boolean).join(' ');
  return `${year ? year + ' ' : ''}${name}`.trim();
}

export function unitBlurb(u) {
  const price = u.all_in ? `All-in: ₱${num(u.all_in).toLocaleString('en-PH')}` :
                u.srp ? `SRP: ₱${num(u.srp).toLocaleString('en-PH')}` : '';
  const loc = u.city ? `${u.city}` : (u.province || '');
  const km = u.mileage ? `${num(u.mileage).toLocaleString('en-PH')} km` : '';
  return `${unitTitle(u)}\n${price}\n${loc}${km ? ' — ' + km : ''}`;
}

export function imagesOf(u) {
  const urls = [];
  for (let i = 1; i <= 10; i++) {
    const k = `image_${i}`;
    if (u[k]) urls.push(u[k]);
  }
  return urls;
}
