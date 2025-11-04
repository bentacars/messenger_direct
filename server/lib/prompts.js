// server/lib/prompts.js
// Loads the active tone pack (B = assertive/fast-closing style)

import ToneB from './tone/pack.B.js';   // default import only

// ---- Prompt builder helpers ---- //
const prompts = {
  // Welcome / return
  greet: () => ToneB.greet?.() ?? "Hi! 👋 I’m your BentaCars consultant.",
  // Phase 1 – qualifying questions
  askVehiclePlan: () => ToneB.ask1?.() ?? "Cash or financing ang plan mo?",
  askLocation:    () => ToneB.ask2?.() ?? "Saan location mo (city/province)?",
  askBodyType:    () => ToneB.ask3?.() ?? "Anong body type mo? (sedan/SUV/MPV/van/pickup—o ‘any’)",
  askTrans:       () => ToneB.ask4?.() ?? "Auto or manual? (pwede ‘any’)",
  askBudget:      () => ToneB.ask5?.() ?? "Budget range? (cash SRP or cash-out kung financing)",
  // Acks / resume / summary
  noted:          () => ToneB.noted?.() ?? "Noted! ✅",
  gotIt:          () => ToneB.gotit?.() ?? "Got it. 👍",
  resume:         (label = "yan") => ToneB.resume?.(label) ?? `Sige, para ma-match ko nang ayos — ${label} na lang.`,
  summaryIntro:   () => ToneB.summaryIntro?.() ?? "Copy. Ito yung hahanap ko for you:",
};

// Export both names so older imports keep working
export { prompts };
export const P = prompts;   // <-- qualifier.js imports { P }

// (optional) default export if you ever want: import Prompts from '../lib/prompts.js'
export default prompts;
