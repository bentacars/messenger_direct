// server/lib/ai.js
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const MODELS = {
  default: process.env.MODEL_DEFAULT || 'gpt-4.1-mini',
  tone: process.env.MODEL_TONE || 'gpt-4o-mini',
  nlg: process.env.NLG_MODEL || process.env.MODEL_TONE || 'gpt-4o-mini',
  extractor: process.env.EXTRACTOR_MODEL || 'gpt-4o-mini'
};

export async function complete({ system, messages, model = MODELS.default, temperature = 0.3, max_tokens = 300 }) {
  const rsp = await client.chat.completions.create({
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages
    ],
    temperature,
    max_tokens
  });
  return rsp.choices?.[0]?.message?.content?.trim() || '';
}

export async function jsonExtract({ system, input, schemaName }) {
  const schema = {
    name: schemaName || 'extract',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        payment: { type: 'string' },
        budget: { type: 'number' },
        location: { type: 'string' },
        transmission: { type: 'string' },
        body: { type: 'string' },
        brand: { type: 'string' },
        model: { type: 'string' },
        variant: { type: 'string' },
        year: { type: 'string' }
      }
    }
  };

  const rsp = await client.chat.completions.create({
    model: MODELS.extractor,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: input }
    ],
    temperature: 0.1,
    response_format: { type: 'json_schema', json_schema: schema }
  });

  try {
    return JSON.parse(rsp.choices?.[0]?.message?.content || '{}');
  } catch {
    return {};
  }
}
