export default {
  greet: () =>
    "Hi! 👋 I’m your BentaCars consultant. Ako na bahala mag-match ng best unit para sa’yo—no more endless scrolling. Let’s find your car, fast.",
  greetReturn: () =>
    "Welcome back! Tutuloy tayo kung saan tayo huli, or gusto mo mag-start over?",
  ask: {
    plan: () => "Cash or financing ang plan mo?",
    location: () => "Saan location mo? (city/province)",
    body: () => "Anong body type mo hanap? (sedan/suv/mpv/van/pickup—or ‘any’).",
    trans: () => "Auto or manual? (Pwede rin ‘any’)",
    budget: () => "Cash budget range? (e.g., 450k–600k)."
  },
  ack: () => "Noted. ✅",
  resume: (missingLabel) => `Sige, para ma-match ko nang ayos: ${missingLabel}?`,
  summaryIntro: () => "Copy. Ito yung hahanap ko for you:",
};
