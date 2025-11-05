// /server/flows/offers.js
// PHASE 2: Retrieval + display logic aligned to your spec

const INVENTORY_API_URL = process.env.INVENTORY_API_URL || '';

export async function step(session, userText, rawEvent) {
  const messages = [];
  const payload = getPayload(rawEvent);
  const t = String(userText || '').toLowerCase();

  session.funnel = session.funnel || {};
  session._offers = session._offers || { page: 0, widened: false, othersCount: 0 };

  // Handle "Others" button/intent
  if (payload === 'SHOW_OTHERS' || /\bothers?\b/.test(t)) {
    session._offers.othersCount = (session._offers.othersCount || 0) + 1;

    // First "Others": advance page (to show backup 2)
    if (session._offers.othersCount === 1) {
      session._offers.page += 1;
    }
    // Second "Others": ask to widen
    else if (session._offers.othersCount >= 2) {
      messages.push({
        type: 'buttons',
        text: 'Gusto mo bang i-widen ko yung search? Pwede akong maghanap outside your body type or i-adjust konti ang price range.',
        buttons: [
          { title: 'Widen search ✅', payload: 'WIDEN_SEARCH' },
          { title: 'Keep as is ❌', payload: 'KEEP_AS_IS' },
        ],
      });
      return { session, messages };
    }
  }

  if (payload === 'WIDEN_SEARCH') {
    session._offers.widened = true;
    session._offers.page = 0;
    session._offers.othersCount = 0;
  }
  if (payload === 'KEEP_AS_IS') {
    // keep filters, just cycle more if possible
    session._offers.page += 1;
  }

  // ----- FETCH + RANK -----
  const qual = session.qualifier || {};
  const { items, error } = await getRankedInventory(qual, session._offers.widened);

  if (error) {
    messages.push({ type: 'text', text: `⚠️ Nagka-issue sa inventory: ${error}. Try mo ulit o revise filters (e.g., “SUV automatic ₱800k QC”).` });
    return { session, messages };
  }

  if (!items.length) {
    messages.push({ type: 'text', text: 'Walang exact match sa ngayon. Pwede kitang i-match sa alternatives—type mo “Others”.' });
    return { session, messages };
  }

  // Up to 4 matches overall
  const top4 = items.slice(0, 4);

  // Compute which 2 to show this round
  const PAGE_SIZE = 2;
  const start = (session._offers.page || 0) * PAGE_SIZE;
  let slice = top4.slice(start, start + PAGE_SIZE);

  // If page overflow, loop back
  if (!slice.length) {
    session._offers.page = 0;
    slice = top4.slice(0, PAGE_SIZE);
  }

  // ----- SEND two units as separate messages -----
  for (const unit of slice) {
    // IMAGE first
    if (unit.image_1) {
      messages.push({ type: 'image', url: unit.image_1 });
    }

    // Build text by payment mode (cash vs financing)
    const isCash = (qual.payment || '').toLowerCase() === 'cash';
    const line1 = `${fmtYearBrandModelVar(unit)}\n${fmtMileageLoc(unit)}`;
    const line2 = isCash
      ? (unit.srp ? `SRP: ₱${money(unit.srp)} (negotiable upon viewing)` : '')
      : (unit.all_in ? `All-in: ₱${money(unit.all_in)} (subject for approval)` : 'All-in available (subject for approval)');
    const hook = quickHook(unit); // simple knowledge hook

    messages.push({
      type: 'text',
      text: [line1, line2, hook].filter(Boolean).join('\n'),
    });
  }

  // ----- Buttons after first 2 -----
  const btns = [];
  slice.forEach((u, idx) => {
    btns.push({ title: `Unit ${idx + 1}`, payload: `CHOOSE_${u.SKU}` });
  });
  btns.push({ title: 'Others', payload: 'SHOW_OTHERS' });
  messages.push({ type: 'buttons', text: 'Pili ka:', buttons: btns });

  // ----- Handle CHOOSE_* (send photos + transition) -----
  if (payload?.startsWith('CHOOSE_')) {
    const chosenId = payload.replace(/^CHOOSE_/, '');
    const chosen = top4.find(x => x.SKU === chosenId) || items.find(x => x.SKU === chosenId);
    if (chosen) {
      session.funnel.unit = { id: chosen.SKU, label: fmtTitle(chosen), raw: chosen };

      messages.push({ type: 'text', text: 'Solid choice! 🔥 Sending full photos…' });

      const imgs = getAllImages(chosen);
      for (const url of imgs) messages.push({ type: 'image', url });

      // Auto-transition if payment already known; else ask
      const pay = (qual.payment || '').toLowerCase();
      if (pay === 'cash' || pay === 'financing') {
        session.nextPhase = pay === 'cash' ? 'cash' : 'financing';
      } else {
        messages.push({
          type: 'buttons',
          text: 'Proceed ka ba via Cash or Financing?',
          buttons: [
            { title: 'Cash', payload: 'CASH' },
            { title: 'Financing', payload: 'FINANCING' },
          ],
        });
      }
      return { session, messages };
    }
  }

  // Branch if user typed/tapped payment after seeing units
  if (payload === 'CASH' || /\bcash\b/.test(t)) {
    session.nextPhase = 'cash';
    messages.push({ type: 'text', text: 'Sige, Cash path tayo. I-schedule natin ang viewing.' });
    return { session, messages };
  }
  if (payload === 'FINANCING' || /financ(ing|e)/.test(t)) {
    session.nextPhase = 'financing';
    messages.push({ type: 'text', text: 'Okay, financing. Ico-collect ko muna ilang details for pre-qual.' });
    return { session, messages };
  }

  return { session, messages };
}

/* ================= FETCH + RANK per spec ================= */

async function getRankedInventory(qual, widened = false) {
  if (!INVENTORY_API_URL) return { items: [], error: 'INVENTORY_API_URL missing' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(INVENTORY_API_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return { items: [], error: `HTTP ${res.status}` };
    const raw = await res.json();
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : []);
    if (!arr.length) return { items: [], error: null };

    // Normalize
    let items = arr.map(normalizeFromSheet);

    // Strong brand/model/year/variant filters when provided
    const want = strongWants(qual);
    if (hasStrongWants(want)) {
      items = items.filter(u =>
        (!want.brand   || eq(u.brand, want.brand)) &&
        (!want.model   || eq(u.model, want.model)) &&
        (!want.year    || String(u.year) === String(want.year)) &&
        (!want.variant || contains(u.variant, want.variant))
      );
    } else {
      // Only Phase 1 fields if brand/model/year/variant not specified
      items = items.filter(u => softPhase1Filter(u, qual, widened));
    }

    // Priority order: price_status = "Priority" first, else "OK to Market"
    items.sort((a, b) => priorityRank(b.price_status) - priorityRank(a.price_status));

    // Score within those tiers
    const scored = items
      .map(u => ({ u, s: scoreUnit(u, qual, widened) }))
      .sort((A, B) => B.s - A.s);

    // Return top 4 only
    return { items: scored.map(x => x.u).slice(0, 4), error: null };
  } catch (e) {
    return { items: [], error: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch error') };
  }
}

/* ================= Normalization (sheet headers a→am) ================= */

function normalizeFromSheet(src = {}) {
  const safe = k => (src[k] ?? '').toString().trim();

  const obj = {
    SKU: safe('SKU'),
    plate_number: safe('plate_number'),
    year: safe('year'),
    brand: safe('brand'),
    model: safe('model'),
    variant: safe('variant'),
    transmission: safe('transmission').toLowerCase(),
    fuel_type: safe('fuel_type'),
    body_type: safe('body_type').toLowerCase(),
    color: safe('color'),
    mileage: toNum(safe('mileage')),
    video_link: safe('video_link'),
    drive_link: safe('drive_link'),
    image_1: safe('image_1') || placeholder(),
    image_2: safe('image_2'),
    image_3: safe('image_3'),
    image_4: safe('image_4'),
    image_5: safe('image_5'),
    image_6: safe('image_6'),
    image_7: safe('image_7'),
    image_8: safe('image_8'),
    image_9: safe('image_9'),
    image_10: safe('image_10'),
    dealer_price: toNum(safe('dealer_price')),
    srp: toNum(safe('srp')),
    term2: toNum(safe('2yrs')),
    term3: toNum(safe('3yrs')),
    term4: toNum(safe('4yrs')),
    all_in: toNum(safe('all_in')),
    price_status: safe('price_status'), // "Priority" / "OK to Market" / etc.
    complete_address: safe('complete_address'),
    city: safe('city'),
    province: safe('province'),
    ncr_zone: safe('ncr_zone'),
    search_key: safe('search_key'),
    lock_flag: safe('lock_flag'),
    brand_model: safe('brand_model'),
    updated_at: safe('updated_at'),
    markup_rate: safe('markup_rate'),
  };

  // fallback title + quick fields for display
  obj.title = fmtTitle(obj);
  obj.locationText = [obj.city, obj.province || obj.ncr_zone].filter(Boolean).join(', ');
  return obj;
}

/* ================= Filters/Scoring per spec ================= */

function strongWants(qual = {}) {
  // you can set qual.brand/model/year/variant upstream if captured
  return {
    brand: (qual.brand || '').trim(),
    model: (qual.model || '').trim(),
    year: qual.year ? String(qual.year).trim() : '',
    variant: (qual.variant || '').trim(),
  };
}
function hasStrongWants(w) {
  return !!(w.brand || w.model || w.year || w.variant);
}

// Phase 1 only: payment, budget, location, transmission, bodyType
function softPhase1Filter(u, qual = {}, widened = false) {
  const pay = (qual.payment || '').toLowerCase();
  const budget = toNum(qual.budget);
  const body = (qual.bodyType || '').toLowerCase();
  const trans = (qual.transmission || '').toLowerCase();
  const loc = (qual.location || '').toLowerCase();

  // Body type
  if (body && body !== 'any' && !widened) {
    if (!eq(u.body_type, body)) return false;
  }
  // Transmission
  if (trans && trans !== 'any' && !widened) {
    if (!eq(u.transmission, trans)) return false;
  }
  // Pricing logic (hidden): cash → SRP within ±50k; financing → all_in <= budget + 50k
  if (budget > 0) {
    if (pay === 'cash') {
      const srp = u.srp || 0;
      if (Math.abs(srp - budget) > 50_000) return false;
    } else if (pay === 'financing') {
      const ai = u.all_in || 0;
      const max = budget + 50_000 * (widened ? 3 : 1); // widen lets us go +150k
      if (!(ai > 0 && ai <= max)) return false;
    }
  }
  // Location (fuzzy)
  if (loc) {
    const locs = [u.city, u.province, u.ncr_zone].map(x => (x || '').toLowerCase());
    if (!locs.some(x => x && (x.includes(loc) || loc.includes(x)))) {
      if (!widened) return false;
    }
  }
  return true;
}

function scoreUnit(u, qual = {}, widened = false) {
  let s = 0;

  // Prioritize price_status
  s += priorityRank(u.price_status) * 10;

  // Body type/transmission affinity
  if (qual.bodyType && qual.bodyType !== 'any') s += eq(u.body_type, qual.bodyType) ? 6 : -2;
  if (qual.transmission && qual.transmission !== 'any') s += eq(u.transmission, qual.transmission) ? 4 : -2;

  // Budget closeness scoring
  const budget = toNum(qual.budget);
  const pay = (qual.payment || '').toLowerCase();
  if (budget > 0) {
    if (pay === 'cash' && u.srp) {
      const diff = Math.abs(u.srp - budget);
      if (diff <= 20_000) s += 6;
      else if (diff <= 50_000) s += 3;
      else if (diff <= 100_000) s += 1;
      else s -= 2;
    }
    if (pay === 'financing' && u.all_in) {
      const max = budget + 50_000 * (widened ? 3 : 1);
      if (u.all_in <= max) s += 6;
      else s -= 2;
    }
  }

  // Location proximity
  if (qual.location) {
    const want = (qual.location || '').toLowerCase();
    const locs = [u.city, u.province, u.ncr_zone].map(x => (x || '').toLowerCase());
    if (locs.some(x => x && (x.includes(want) || want.includes(x)))) s += 3;
  }

  // Recency (updated_at) bonus
  if (u.updated_at) s += 1;

  // Newer year
  if (u.year) s += Math.min(3, Math.max(0, +u.year - 2015) * 0.2);

  return s;
}

function priorityRank(ps = '') {
  const v = (ps || '').toLowerCase();
  if (v.includes('priority')) return 2;
  if (v.includes('ok') && v.includes('market')) return 1;
  return 0;
}

/* ================= Render helpers ================= */

function fmtTitle(u) {
  return [u.year, u.brand, u.model, u.variant].filter(Boolean).join(' ');
}
function fmtYearBrandModelVar(u) {
  return [u.year, u.brand, u.model, u.variant].filter(Boolean).join(' ');
}
function fmtMileageLoc(u) {
  const m = u.mileage ? `${numberWithCommas(u.mileage)} km` : '';
  const loc = u.locationText || [u.city, u.province || u.ncr_zone].filter(Boolean).join(', ');
  return [m, loc].filter(Boolean).join(' — ');
}
function quickHook(u) {
  // Tiny model hooks (Phase 2.5 can replace with /lib/vehicle_specs.js)
  const model = (u.model || '').toLowerCase();
  if (/vios/.test(model)) return 'Matipid sa gas, mura maintenance ✅';
  if (/innova/.test(model)) return '7-seater, pang-pamilya, diesel tipid ✅';
  if (/mirage/.test(model)) return '3-cyl → super tipid sa gas ✅';
  if (/city/.test(model)) return 'Matipid sa gas, good for city driving 🚗';
  if (/fortuner|everest/.test(model)) return 'Malakas hatak, mataas ground clearance 🛞';
  return 'Parts are easy to find, high resale demand 👍';
}
function getAllImages(u) {
  const keys = ['image_1','image_2','image_3','image_4','image_5','image_6','image_7','image_8','image_9','image_10'];
  return keys.map(k => u[k]).filter(x => !!x);
}

/* ================= Misc utils ================= */

function getPayload(evt) {
  const p = evt?.postback?.payload;
  return typeof p === 'string' ? p : '';
}
function toNum(v) {
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function numberWithCommas(x) {
  return String(Math.round(Number(x) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function money(n) { return numberWithCommas(n); }
function eq(a, b) { return (a || '').toString().trim().toLowerCase() === (b || '').toString().trim().toLowerCase(); }
function contains(a, b) { return (a || '').toLowerCase().includes((b || '').toLowerCase()); }
function placeholder() { return 'https://via.placeholder.com/600x400?text=Unit'; }
