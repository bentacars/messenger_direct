const K = (x)=> Number(String(x??'').replace(/[^\d]/g,'')) || 0;
const fmt = (n)=> n.toLocaleString('en-PH');

export function cashLine(u) {
  const srp = K(u.srp);
  if (!srp) return 'SRP: —';
  return `SRP: ₱${fmt(srp)} (negotiable upon viewing)`;
}

function roundUp5k(n){ const step=5000; return Math.ceil(n/step)*step; }

export function financingLine(u) {
  const ai = K(u.all_in);
  if (!ai) return 'All-in: —';
  const low = roundUp5k(ai);
  const high = low + 20000;
  return `All-in: ₱${fmt(low)}–₱${fmt(high)} (subject for approval)\nStandard is ~20–30% DP for used cars; may all-in promo tayo this month.`;
}

export function monthlyLines(u) {
  const y2 = K(u['2yrs']), y3 = K(u['3yrs']), y4 = K(u['4yrs']);
  const parts = [];
  if (y2) parts.push(`2yrs ₱${fmt(y2)}/mo`);
  if (y3) parts.push(`3yrs ₱${fmt(y3)}/mo`);
  if (y4) parts.push(`4yrs ₱${fmt(y4)}/mo`);
  return parts.join(' | ');
}
