// /server/tone/nudge.js
// Tone Pack "B": friendly but slightly assertive; short, human, and action-oriented.
// Import this from webhook/flows when you need a nudge line.

export const phase1Nudges = [
  "Quick check lang — cash or financing plan mo? Para maitama ko agad ang match.",
  "Saan location mo (city/province)? Iche-check ko yung pinakamalapit na units.",
  "Anong body type mo — sedan, SUV, MPV, van, pickup? ‘Any’ ok din.",
  "Transmission preference — automatic, manual, or ‘any’?",
  "Budget range mo? (cash SRP or cash-out kung financing) para tumama ang options."
];

export const phase1NudgeWrap = [
  "Noted sa previous details mo. Isa na lang: {missing}.",
  "Sige, almost done tayo. Pahabol lang: {missing}.",
  "Got it. Para ma-finalize ko, {missing}.",
];

export const docsNudges = [
  "While securing your viewing slot, send mo na rito ang valid ID at basic docs para ma-pre-approve ka na rin. 🚀",
  "Reminder lang — kung ok, pa-send ng basic docs (IDs + proof of income) para mabilis ang approval.",
  "Pa-abot ng clear photos ng IDs at income proof dito para ma-fast track natin.",
];

export const finalPhase1Stop = "Babalik muna ako later. Gusto mong mag-Continue o Not interested?";
export const docsStop = "Maghihinto muna ako sa follow-ups. If gusto mong ituloy, reply ka lang dito at tutulungan kitang tapusin ang approval.";

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Optional helper to stitch a missing-field prompt using the wrap variants.
export function wrapMissing(missingText) {
  const t = pick(phase1NudgeWrap);
  return t.replace("{missing}", missingText);
}
