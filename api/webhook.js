import fetch from 'node-fetch';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// ---- Load prompt file & env-configurable defaults ----
const QUALIFIER_PROMPT = await readFile(
  path.join(process.cwd(), 'prompts', 'qualifier.txt'),
  'utf8'
);

// Use one default model/temp for everything (you set these in Vercel)
const MODEL = process.env.MODEL_DEFAULT || 'gpt-4.1';
const TEMPERATURE = Number(process.env.TEMP_DEFAULT ?? 0.30);

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_TURNS = 18; // memory depth per user

// Simple in-memory sessions for Phase 1 tests (swap to Redis/DB later for persistence)
const sessions = new Map();

function historyFor(senderId) {
  if (!sessions.has(senderId)) {
    sessions.set(senderId, [
      { role: 'system', content: QUALIFIER_PROMPT }
    ]);
  }
  return sessions.get(senderId);
}

function clampHistory(arr) {
  const systemMsg = arr[0];
  const tail = arr.slice(-MAX_TURNS * 2); // keep recent user/assistant pairs
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
      temperature: TEMPERATURE
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
  // --- Webhook verification (GET) ---
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // --- Incoming messages (POST) ---
  if (req.method === 'POST') {
    try {
      const body = req.body;
      if (body.object !== 'page') return res.status(404).send('Not a page subscription');

      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const psid = event?.sender?.id;
          if (!psid) continue;

          // Support text and simple postback titles
          const text =
            event?.message?.text ||
            event?.postback?.title ||
            '';

          if (!text) continue;

          // Update conversation memory
          const hist = historyFor(psid);
          hist.push({ role: 'user', content: text });

          // Ask OpenAI
          const reply = await sendToOpenAI(hist);
          if (!reply) continue;

          // Save AI reply then clamp memory
          hist.push({ role: 'assistant', content: reply });
          sessions.set(psid, clampHistory(hist));

          // Send to Messenger
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

// Ensure JSON body parsing is enabled for Vercel Node functions
export const config = { api: { bodyParser: true } };
