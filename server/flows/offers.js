// /server/flows/offers.js
// Phase 2: Show offers from INVENTORY_API_URL based on qualifiers

const INVENTORY_API_URL = process.env.INVENTORY_API_URL || '';

export async function step(session, userText, rawEvent) {
  const messages = [];
  const payload = getPayload(rawEvent);
  const t = String(userText || '').toLowerCase();

  session.funnel = session.funnel || {};
  session._offersPage = Number.isInteger(session._offersPage) ? session._offersPage : 0;

  // Next page if user tapped or said "Show others"
  if (payload === 'SHOW_OTHERS' || /\bothers?\b/.test(t)) {
    session._offersPage += 1;
  }

  // Fetch and rank inventory
  const qual = session.qualifier || {};
  const { items, error } = await getRankedInventory(qual);

  if (error) {
    messages.push({ type: 'text', text: `⚠️ Error pulling inventory: ${error}. Try adjusting filters e.g. “₱600k sedan automatic QC”.` });
    return { session, messages };
  }

  if (!items.length) {
    messages.push({ type: 'text', text: 'Walang swak sa filters. Try revising (e.g., "SUV ₱800k Pasig").' });
    return { session, messages };
  }

  // Paginate 2 per page
  const PAGE_SIZE = 2;
  const start = session._offersPage * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);

  // Loop back if no more
  if (!pageItems.length) {
    session._offersPage = 0;
    return await step(session, userText, rawEvent);
  }

  // Create carousel cards
  const elements = pageItems.map(toGenericElement);

  messages.push({ type: 'generic', elements });

  messages.push({
    type: 'buttons',
    text: 'Di swak? Pili ka:',
    buttons: [
      { title: 'Show others', payload: 'SHOW_OTHERS' },
      { title: 'Cash path', payload: 'CASH' },
      { title: 'Financing path', payload: 'FINANCING' },
    ],
  });

  // When unit is selected
  if (payload?.startsWith('CHOOSE_')) {
    const chosenId = payload.replace(/^CHOOSE_/, '');
    const chosen = items.find(x => x.SKU === chosenId) || pageItems[0];
    session.funnel.unit = { id: chosenId, label: unitLabel(chosen), raw: chosen };
    messages.push({
      type: 'buttons',
      text: `Nice choice: ${unitLabel(chosen)}. Proceed ka ba via Cash or Financing?`,
      buttons: [
        { title: 'Cash', payload: 'CASH' },
        { title: 'Financing', payload: 'FINANCING' },
      ],
    });
    return { session, messages };
  }

  // Branch: Cash
  if (payload === 'CASH' || /\bcash\b/.test(t)) {
    session.nextPhase = 'cash';
    messages.push({ type: 'text', text: 'Sure. 💰 Cash path tayo. Let’s schedule viewing.' });
    return { session, messages };
  }

  // Branch: Financing
  if (payload === 'FINANCING' || /financ(ing|e)/.test(t)) {
    session.nextPhase = 'financing';
    messages.push({ type: 'text', text: 'Sige, financing. Will collect a few details para ma-prequalify ka.' });
    return { session, messages };
  }

  // Stay in offers loop
  return { session, messages };
}

/* ---------------- fetching + ranking ---------------- */
async function getRankedInventory(qual) {
  if (!INVENTORY_API_URL) {
    return { items: [], error: 'INVENTORY_API_URL missing' };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const res = await fetch(INVENTORY_API_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { items: [], error: `HTTP ${res.status} ${txt}` };
    }
    const data = await res.json();
    const arr = Array.isArray(data) ? data : data?.items || [];

    const scored = arr
      .map(normalizeItem)
      .map(item => ({ item, score: scoreItem(item, qual) }))
      .filter(x => x.score > -Infinity);

    scored.sort((a, b) => b.score - a.score || a.item.price - b.item.price);

    return { items: scored.map(x => x.item), error: null };
  } catch (e) {
    return { items: [], error: e.message || 'fetch error' };
  }
}

/* ---------------- sheet field mapping ---------------- */
function normalizeItem(src = {}) {
  const SKU = String(src.SKU || '');
  const brand = src.brand;
  const model = src.model;
  const variant = src.variant;
  const year = src.year;
  const transmission = (src.transmission || '').toLowerCase();
  const body_type = (src.body_type || '').toLowerCase();
  const city = src.city;
  const province = src.province;
  const ncr_zone = src.ncr_zone;

  // Pricing
  const dealer_price = num(src.dealer_price);
  const srp = num(src.srp);
  const all_in = num(src.all_in);
  const price = num(src.srp || src.dealer_price || src.all_in);

  const mileage = num(src.mileage);
  const link = src.drive_link || src.video_link || '';

  const image_url = src.image_1 || 'https://via.placeholder.com/600x400?text=Unit';
  const title = [brand, model, variant, year].filter(Boolean).join(' ') || `Unit ${SKU}`;
  const loc = [city, province || ncr_zone].filter(Boolean).join(', ');
  const subtitle = [
    price ? `₱${money(price)}` : '',
    mileage ? `${mileage} km` : '',
    loc
  ].filter(Boolean).join(' • ');

  return {
    SKU, brand, model, variant, year,
    transmission, body_type,
    city, province, ncr_zone,
    dealer_price, srp, all_in, price,
    mileage, link, image_url, title, subtitle
  };
}

/* ---------------- scoring engine ---------------- */
function scoreItem(it, qual) {
  let s = 0;

  if (qual.bodyType && qual.bodyType !== 'any') {
    s += it.body_type === qual.bodyType ? 5 : -2;
  }
  if (qual.transmission && qual.transmission !== 'any') {
    s += it.transmission === qual.transmission ? 4 : -2;
  }
  if (qual.budget) {
    const budget = qual.budget;
    s += it.price <= budget ? 6 : it.price <= budget * 1.2 ? 2 : -3;
  }
  if (qual.payment) s += 1;

  if (qual.location) {
    const want = qual.location.toLowerCase();
    if (
      (it.city && it.city.toLowerCase().includes(want)) ||
      (it.province && it.province.toLowerCase().includes(want)) ||
      (it.ncr_zone && it.ncr_zone.toLowerCase().includes(want))
    ) {
      s += 3;
    }
  }

  if (it.year) s += (parseInt(it.year, 10) - 2015) * 0.2;

  return s;
}

/* ---------------- rendering helpers ---------------- */
function toGenericElement(it) {
  const buttons = [
    { type: 'postback', title: 'Choose', payload: `CHOOSE_${it.SKU}` },
    { type: 'postback', title: 'Cash', payload: 'CASH' },
    { type: 'postback', title: 'Financing', payload: 'FINANCING' },
  ];
  if (it.link) {
    buttons.unshift({ type: 'web_url', title: 'Details', url: it.link });
    buttons.length = 3;
  }
  return {
    title: it.title,
    subtitle: it.subtitle,
    image_url: it.image_url,
    buttons,
  };
}

function unitLabel(it) {
  return [it.brand, it.model, it.variant, it.year].filter(Boolean).join(' ').trim();
}

/* ---------------- utils ---------------- */
function getPayload(evt) {
  const p = evt?.postback?.payload;
  return typeof p === 'string' ? p : '';
}
function num(v) { const n = Number(String(v)?.replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0; }
function money(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
