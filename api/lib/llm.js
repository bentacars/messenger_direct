import fetch from 'node-fetch';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL       = process.env.MODEL_DEFAULT || 'gpt-4.1';
const TEMPERATURE = Number(process.env.TEMP_DEFAULT ?? 0.30);
export const STOP_LINE = 'GOT IT! ✅ I now have everything I need. I can now search available units for you.';

export async function qualifierPrompt() {
  return await readFile(path.join(process.cwd(), 'prompts', 'qualifier.txt'), 'utf8');
}

export async function chat(history) {
  const r = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: history, temperature: TEMPERATURE })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI: ${r.status} ${JSON.stringify(j)}`);
  return j?.choices?.[0]?.message?.content?.trim() || '';
}
