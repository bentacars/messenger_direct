export const ToneB = {
  greetNew: () =>
    "Hi! 👋 I’m your BentaCars consultant. Ako na bahala mag-match ng best unit para sa’yo—no more endless scrolling. Let’s find your car, fast.",
  greetReturning: () =>
    "Welcome back! 👋 Itutuloy natin kung saan tayo huli, or gusto mong mag-start over?",
  ask: {
    plan: () => "Cash or financing ang plan mo?",
    location: () => "Saan location mo? (city/province)",
    body: () => "Anong body type hanap mo? (sedan/suv/mpv/van/pickup—or ‘any’)",
    trans: () => "Auto o manual? (pwede ‘any’)",
    budgetCash: () => "Cash budget range? (e.g., 450k–600k)",
  },
  acks: {
    noted: () => "Noted. 👍",
    gotIt: () => "Got it. ✅"
  },
  resume: (missingLabel) => `Sige, para ma-match ko nang ayos—${missingLabel}?`,
  summaryIntro: () => "Copy. Ito yung hahanapin ko for you:",
};
