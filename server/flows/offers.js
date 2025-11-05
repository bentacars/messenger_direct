// /server/flows/offers.js
// Phase 2: Show offers and branch to Cash/Financing

export async function step(session, userText, rawEvent) {
  const messages = [];
  const payload = getPayload(rawEvent);
  const t = String(userText || '').toLowerCase();

  // Seed funnel store
  session.funnel = session.funnel || {};

  // First time in offers → show 2 sample units
  if (!session._offersShown) {
    session._offersShown = true;

    messages.push({
      type: 'generic',
      elements: [
        {
          title: 'Toyota Vios 1.3 XE AT 2019',
          subtitle: '₱458,000 • 45k km • Quezon City',
          image_url: 'https://via.placeholder.com/600x400?text=Vios+2019',
          buttons: [
            { type: 'postback', title: 'Choose', payload: 'CHOOSE_VIOS_2019' },
            { type: 'postback', title: 'Cash', payload: 'CASH' },
            { type: 'postback', title: 'Financing', payload: 'FINANCING' },
          ],
        },
        {
          title: 'Mitsubishi Mirage G4 GLX 2020',
          subtitle: '₱398,000 • 30k km • Pasig',
          image_url: 'https://via.placeholder.com/600x400?text=Mirage+G4+2020',
          buttons: [
            { type: 'postback', title: 'Choose', payload: 'CHOOSE_MIRAGE_2020' },
            { type: 'postback', title: 'Cash', payload: 'CASH' },
            { type: 'postback', title: 'Financing', payload: 'FINANCING' },
          ],
        }
      ]
    });

    messages.push({
      type: 'buttons',
      text: 'Di swak? Pwede rin akong maghanap ng iba.',
      buttons: [
        { title: 'Show others', payload: 'SHOW_OTHERS' },
        { title: 'Cash path', payload: 'CASH' },
        { title: 'Financing path', payload: 'FINANCING' },
      ],
    });

    return { session, messages };
  }

  // If user asks for "others", you can regenerate a new carousel or ask for more filters
  if (payload === 'SHOW_OTHERS' || /\bothers?\b/.test(t)) {
    messages.push({
      type: 'text',
      text: 'Anong hanap mo? (e.g., “SUV automatic ₱700k QC”) — I’ll refine the list.',
    });
    // In a real setup, parse the text and query your inventory here, then push a new carousel
    return { session, messages };
  }

  // Capture chosen unit
  if (payload?.startsWith('CHOOSE_')) {
    const chosen = parseChosen(payload);
    session.funnel.unit = chosen;
    messages.push({
      type: 'buttons',
      text: `Nice choice: ${chosen?.label || 'Selected unit'}. Proceed ka ba via Cash or Financing?`,
      buttons: [
        { title: 'Cash', payload: 'CASH' },
        { title: 'Financing', payload: 'FINANCING' },
      ],
    });
    return { session, messages };
  }

  // Branch to cash
  if (payload === 'CASH' || /\bcash\b/.test(t)) {
    session.nextPhase = 'cash';
    messages.push({ type: 'text', text: 'Noted: Cash path. Let’s schedule viewing.' });
    return { session, messages };
  }

  // Branch to financing
  if (payload === 'FINANCING' || /financ(ing|e)/.test(t)) {
    session.nextPhase = 'financing';
    messages.push({ type: 'text', text: 'Sige, financing. I’ll collect a few details.' });
    return { session, messages };
  }

  // Still in offers loop
  messages.push({ type: 'text', text: 'Gusto mo mag-cash o financing para sa napili mong unit?' });
  return { session, messages };
}

/* ---------------- helpers ---------------- */
function getPayload(evt) {
  const p = evt?.postback?.payload;
  return typeof p === 'string' ? p : '';
}

function parseChosen(payload = '') {
  // e.g., CHOOSE_VIOS_2019 → { id:'VIOS_2019', label:'Vios 2019' }
  const id = payload.replace(/^CHOOSE_/, '');
  const label = id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return { id, label };
}
