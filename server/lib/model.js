// server/lib/model.js
// Human summary for Phase 1 + one-liner selling hooks (LLM-backed with fallbacks)

function clean(s) {
  return (s || '').toString().trim();
}

export function formatSummary(qual = {}) {
  const bits = [];

  if (qual.payment) {
    bits.push(`Payment: ${qual.payment.toString().toUpperCase().startsWith('CASH') ? 'Cash' : 'Financing'}`);
  }
  if (qual.budget) {
    const n = Number(String(qual.budget).replace(/[^\d]/g, ''));
    const pretty = Number.isFinite(n) ? `₱${n.toLocaleString('en-PH', { maximumFractionDigits: 0 })}` : qual.budget;
    bits.push(`Budget: ${pretty}`);
  }
  if (qual.location) bits.push(`Location: ${qual.location}`);
  if (qual.bodyType) bits.push(`Body type: ${qual.bodyType}`);
  if (qual.transmission) bits.push(`Transmission: ${qual.transmission}`);

  // Preferences (do not force ask again)
  const wants = ['brand', 'model', 'variant', 'year'].map(k => clean(qual[k])).filter(Boolean).join(' ');
  if (wants) bits.push(`Pref: ${wants}`);

  return bits.join(' • ');
}

/* --------------------- Hook line (AI → fallback) --------------------- */

const BODY_DEFAULTS = {
  suv: 'Mataas ground clearance — comfy kahit lubak o baha.',
  mpv: '7-seater practicality — pang-family / pang-negosyo.',
  van: 'Maluwag at practical — good for negosyo o malaking pamilya.',
  sedan: 'Matipid at madaling i-maneho sa city traffic.',
  hatchback: 'Tipid sa gas at madaling ipark — solid pang-city.',
  crossover: 'Versatile ride height — panalo sa daily use.',
  pickup: 'Malakas hatak at matibay — pang-trabaho o adventure.',
  auv: 'Practical at matibay — good for family/negosyo.',
};

function genericHook(unit = {}) {
  const bt = (unit.body_type || '').toLowerCase();
  // try model-specific quick wins
  const model = (unit.model || '').toLowerCase();
  const brand = (unit.brand || '').toLowerCase();

  if (model.includes('vios')) return 'Matipid at mura maintenance — perfect sa daily city driving.';
  if (model.includes('mirage')) return 'Super tipid sa gas at madaling ipark.';
  if (model.includes('innova')) return '7-seater na matibay at practical sa long trips.';
  if (model.includes('everest') || model.includes('fortuner') || model.includes('montero')) return 'Mataas ground clearance — kampante sa baha at long drives.';
  if (brand.includes('honda') && model.includes('city')) return 'Reliable at matipid — smooth pang-araw-araw.';

  return BODY_DEFAULTS[bt] || 'Practical choice — reliable at madaling i-maintain.';
}

/**
 * Try to get an AI one-liner. If anything fails, return genericHook().
 * We keep this isolated so offers.js can `await getHookLine(unit)`.
 */
export async function getHookLine(unit = {}) {
  try {
    // defer import to avoid hard dependency if LLM is disabled
    const llm = await import('./llm.js').catch(() => null);
    if (llm && typeof llm.aiHookForUnit === 'function') {
      const hint = await llm.aiHookForUnit({
        brand: unit.brand,
        model: unit.model,
        variant: unit.variant,
        body_type: unit.body_type,
        transmission: unit.transmission,
      });
      if (hint && typeof hint === 'string' && hint.trim()) {
        return hint.trim();
      }
    }
  } catch (e) {
    // silent fallback
  }
  return genericHook(unit);
}
