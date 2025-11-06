// server/lib/constants.js

export const SESSION_TTL_DAYS = 7; // expire after 7 days of inactivity
export const FB_GRAPH_API = "https://graph.facebook.com/v17.0";
export const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
export const INVENTORY_API_URL = process.env.INVENTORY_API_URL;
