// server/constants.js
export const BODY_TYPES = [
  'sedan','suv','mpv','van','pickup','hatchback','crossover','auv','any'
];

export const TRANS = ['automatic','manual','any','at','mt'];

export const YES = /^(yes|oo|opo|sige|go|ok|okay|game)$/i;

export const CITY_HINTS = [
  'manila','qc','quezon city','pasig','makati','taguig','mandaluyong','pasay',
  'caloocan','malabon','navotas','valenzuela','marikina','parañaque','las piñas',
  'cavite','laguna','bulacan','rizal','cebu','davao','iloilo','bacolod','pampanga'
];

export const INVENTORY_HEADERS = {
  sku: 'SKU',
  plate: 'plate_number',
  year: 'year',
  brand: 'brand',
  model: 'model',
  variant: 'variant',
  transmission: 'transmission',
  fuel: 'fuel_type',
  body: 'body_type',
  color: 'color',
  mileage: 'mileage',
  video: 'video_link',
  drive: 'drive_link',
  image_1: 'image_1',
  image_10: 'image_10',
  dealer_price: 'dealer_price',
  srp: 'srp',
  y2: '2yrs',
  y3: '3yrs',
  y4: '4yrs',
  all_in: 'all_in',
  price_status: 'price_status',
  address: 'complete_address',
  city: 'city',
  province: 'province',
  ncr: 'ncr_zone',
  search_key: 'search_key',
  lock_flag: 'lock_flag',
  brand_model: 'brand_model',
  updated_at: 'updated_at',
  markup_rate: 'markup_rate'
};

export const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

export const NLG_MODEL = process.env.NLG_MODEL || 'gpt-4o-mini';
export const EXTRACTOR_MODEL = process.env.EXTRACTOR_MODEL || 'gpt-4o-mini';
export const TEMP_TONE = Number(process.env.TEMP_TONE || 0.95);
export const FREQ_PENALTY_TONE = Number(process.env.FREQ_PENALTY_TONE || 0.1);
export const PRES_PENALTY_TONE = Number(process.env.PRES_PENALTY_TONE || 0.4);

export const DEBUG_LLM = process.env.DEBUG_LLM === '1';
