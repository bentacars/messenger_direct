// api/lib/llm.js
// Lightweight “human” phrasing + utilities (no long system prompts)

export function greet(sess) {
  // First-time vs returning
  if (!sess?.data?.plan && !sess?.data?.city) {
    return "Hi! 👋 I’m your BentaCars consultant. Tutulungan kitang ma-match sa best unit para di ka na mag-scroll nang mag-scroll.";
  }
  return "Hi again! Ready na ko to continue kung saan tayo huli.";
}

export function shouldReset(textLower) {
  return /\b(restart|reset|start over|ulit tayo)\b/i.test(textLower);
}

export function smartReply(tag) {
  switch (tag) {
    case 'plan_retry':
      return "Cash or financing? Para ma-filter ko agad nang tama.";
    default:
      return "Sige.";
  }
}

// Detect model by scanning inventory list; returns model slug (lowercase) if found in user text
export function detectModelFromText(userText, inventoryList) {
  const low = (userText || '').toLowerCase();
  if (!low) return '';
  // Build a small set of unique model tokens from inventory (e.g., 'vios', 'mirage', 'nv350')
  const uniq = new Set();
  for (const it of inventoryList || []) {
    const m = (it.model || '').toLowerCase().trim();
    if (m) uniq.add(m);
  }
  for (const m of uniq) {
    const re = new RegExp(`\\b${escapeRegex(m)}\\b`, 'i');
    if (re.test(low)) return m;
  }
  return '';
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// “450k-600k”, “150000-220000”, “below 600k”, “under 500k”, “200k to 250k”
export function normalizeBudget(text) {
  const t = (text || '').toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ').trim();

  // below/under X
  let m = t.match(/\b(below|under)\s+(\d+\.?\d*)(k)?\b/);
  if (m) {
    const num = Number(m[2]) * (m[3] ? 1000 : 1);
    return { min: 0, max: num };
  }

  // X - Y or X to Y
  m = t.match(/(\d+\.?\d*)(k)?\s*(?:\-|to|–|—)\s*(\d+\.?\d*)(k)?/);
  if (m) {
    const a = Number(m[1]) * (m[2] ? 1000 : 1);
    const b = Number(m[3]) * (m[4] ? 1000 : 1);
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    return { min, max };
  }

  // single number → treat as max
  m = t.match(/(\d+\.?\d*)(k)?/);
  if (m) {
    const v = Number(m[1]) * (m[2] ? 1000 : 1);
    return { min: 0, max: v };
  }
  return null;
}
