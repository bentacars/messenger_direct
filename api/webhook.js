import fetch from 'node-fetch';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const MAX_TURNS = 18; // ~18 turns memory per user

// Simple in-memory sessions (OK for initial test)
const sessions = new Map();

function historyFor(senderId) {
  if (!sessions.has(senderId)) {
    sessions.set(senderId, [
      {
        role: 'system',
        content: `
You are BentaCars’ AI Sales Consultant. Speak in friendly Taglish like a real human.

Your job is to QUALIFY the buyer before showing any units.

Ask only ONE question at a time.

REQUIRED INFO TO COLLECT (any order):
1) Cash or Financing
2) Budget (cash price or monthly)
3) Location (city/province)
4) Preferred car type/model (if any)

RULES:
- Use the chat history. Do NOT repeat a question if already answered.
- If the user answers off-topic, gently steer back to what’s missing.
- Keep responses short, conversational, and helpful.
- When ALL 4 are known, reply exactly once with:
"GOT IT! ✅ I now have everything I need. I can now search available units for you."
Then stop asking new questions.
        `.trim()
      }
    ]);
  }
  return sessions.get(senderId);
}

function clampHistory(arr) {
  const systemMsg = arr[0];
  const tail = arr.slice(-MAX_TURNS * 2);
  return [systemMsg, ...tail];
}

async function sendToOpenAI(history) {
  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      messages: history,
      temperature: 0.3
    })
  });
  const json = await resp.json();
  if (!resp.ok) {
    console.error('OpenAI error:', resp.status, JSON.stringify(json));
    throw new Error('OpenAI request failed');
  }
  return json?.choices?.[0]?.message?.content?.trim() || '';
}

async function sendToMessenger(psid, text) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.FB_PAGE_TOKEN}`;
  const body = {
    messaging_type: 'RESPONSE',
    recipient: { id: psid },
    message: { text }
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const j = await r.text();
    console.error('Messenger Send API error:', r.status, j);
  }
}

export default async function handler(req, res) {
  // --- Verify webhook (GET) ---
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // --- Handle messages (POST) ---
  if (req.method === 'POST') {
    try {
      const body = req.body;
      if (body.object !== 'page') return res.status(404).send('Not a page subscription');

      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const psid = event?.sender?.id;
          if (!psid) continue;

          const text =
            event?.message?.text ||
            event?.postback?.title ||
            '';

          if (!text) continue;

          const hist = historyFor(psid);
          hist.push({ role: 'user', content: text });

          const reply = await sendToOpenAI(hist);
          if (!reply) continue;

          hist.push({ role: 'assistant', content: reply });
          sessions.set(psid, clampHistory(hist));

          await sendToMessenger(psid, reply);
        }
      }
      return res.status(200).send('OK');
    } catch (err) {
      console.error('Webhook error:', err);
      return res.status(500).send('Server error');
    }
  }

  return res.status(405).send('Method Not Allowed');
}

// Ensure JSON body parsing is enabled on Vercel Node functions
export const config = { api: { bodyParser: true } };
