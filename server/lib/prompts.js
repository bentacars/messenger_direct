// server/lib/prompts.js
// Loads the active tone pack (B = assertive/fast-closing style)

import ToneB from './tone/pack.B.js';   // ✅ default import (no { })

// ---- Exported prompt builder helpers ---- //

export const prompts = {
  greet: () => ToneB.greet(),

  // Phase 1 – qualifying questions
  askVehiclePlan: () => ToneB.ask1(),
  askLocation: () => ToneB.ask2(),
  askBodyType: () => ToneB.ask3(),
  askTrans: () => ToneB.ask4(),
  askBudget: () => ToneB.ask5(),

  // Confirmations
  noted: () => ToneB.noted(),          // ✅ now exists in pack.B.js
  gotIt: () => ToneB.gotit(),

  // Resume if user paused or changed topic
  resume: (label) => ToneB.resume(label),

  // Summary output intro
  summaryIntro: () => ToneB.summaryIntro(),
};
