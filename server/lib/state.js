// server/lib/state.js
export function initIfNeeded(s = {}) {
  s.phase ||= 'qualifying';
  s.pending ||= 'collect';
  s.collected ||= { payment: !!s.payment, budget: !!s.budget, location: !!s.location, transmission: !!s.transmission, body: !!s.body };
  return s;
}

export function applyExtraction(s, ex) {
  const f = (k) => ex[k] && (s[k] = s[k] || (k === 'budget' ? Number(ex[k]) : String(ex[k]).toLowerCase()));
  ['payment','budget','location','transmission','body','brand','model','variant','year'].forEach(f);
  s.collected = {
    payment: !!s.payment, budget: !!s.budget, location: !!s.location, transmission: !!s.transmission, body: !!s.body
  };
  return s;
}

export function missingFields(s) {
  const need = [];
  if (!s.payment) need.push('payment');
  if (!s.budget) need.push('budget');
  if (!s.location) need.push('location');
  if (!s.transmission) need.push('transmission');
  if (!s.body) need.push('body');
  return need;
}
