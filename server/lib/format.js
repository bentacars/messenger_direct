// server/lib/format.js
// Formatting helpers for offers & messages

/* ======= Basic formatters ======= */
export function peso(n) {
  if (n == null || n === '') return '';
  const x = Number(n);
  if (Number.isNaN(x)) return String(n);
  return `₱${x.toLocaleString('en-PH', { maximumFractionDigits: 0 })}`;
}

export function km(n) {
  if (n == null || n === '') return '';
  const x = Number(n);
  if (Number.isNaN(x)) return String(n);
  return `${x.toLocaleString('en-PH')} km`;
}

export function titleCase(s = '') {
  return s.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
}

/* ======= Unit field helpers ======= */
export function firstImage(unit = {}) {
  for (let i = 1; i <= 10; i++) {
    const k = `image_${i}`;
    if (unit[k]) return unit[k];
  }
  return null;
}

export function allImages(unit = {}) {
  const urls = [];
  for (let i = 1; i <= 10; i++) {
    const k = `image_${i}`;
    if (unit[k]) urls.push(unit[k]);
  }
  return urls;
}

export function cityProv(unit = {}) {
  const city = (unit.city || '').trim();
  const prov = (unit.province || '').trim();
  if (city && prov) return `${city} — ${prov}`;
  return city || prov || '';
}

/* ======= Caption builders ======= */
/**
 * Build a concise, human caption for a unit.
 * @param {object} unit - row from sheet
 * @param {'cash'|'financing'} mode
 * @param {string} hookLine - one-liner selling point (optional)
 */
export function buildUnitCaption(unit = {}, mode = 'cash', hookLine = '') {
  const year = unit.year ? String(unit.year).trim() : '';
  const name = [year, unit.brand, unit.model, unit.variant].filter(Boolean).join(' ').trim();

  const odo = unit.mileage ? `${km(unit.mileage)}` : '';
  const loc = cityProv(unit);
  const line2 = [odo, loc].filter(Boolean).join(' — ');

  let priceLine = '';
  if (mode === 'cash') {
    const srp = unit.srp ? peso(unit.srp) : null;
    priceLine = srp ? `SRP: ${srp} (negotiable upon viewing)` : '';
  } else {
    // financing
    const allIn = unit.all_in ? `${peso(unit.all_in - 10000)}–${peso(unit.all_in + 10000)}` : null; // small band if single value
    priceLine = allIn ? `All-in: ${allIn} (subject for approval)` : '';
  }

  const hook = hookLine ? `\n${hookLine}` : '';

  return [
    name || 'Selected unit',
    line2,
    priceLine,
  ].filter(Boolean).join('\n') + hook;
}

/**
 * Compose a Messenger-ready message object for a unit (first image + caption).
 * Returned object is ready for your router to send as:
 *   replies.push({ type: 'images', urls: [firstImage] }); then a text
 * But some flows prefer a single text message. We expose both patterns.
 */
export function composeUnitReply(unit = {}, mode = 'cash', hookLine = '') {
  const img = firstImage(unit);
  const caption = buildUnitCaption(unit, mode, hookLine);
  return { image: img, caption };
}
