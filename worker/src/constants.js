// ---- Workers AI pricing & demo limits -------------------------------------------
// Model: Llama 3.3 70B fp8-fast. Prices read from the Workers AI model catalog
// (GET /accounts/:id/ai/models/search, Nov 2026) and the pricing doc:
//   input  $0.293 per 1M tokens   (≈ 26,668 neurons / M)
//   output $2.253 per 1M tokens   (≈ 204,805 neurons / M)
// We IGNORE the free 10k neurons/day allowance so estimates are conservative.
export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const USD_PER_INPUT_TOKEN = 0.293 / 1e6;
export const USD_PER_OUTPUT_TOKEN = 2.253 / 1e6;

// Hard daily cap (UTC day). Reservations are refused if spent+reserved+new > cap,
// so the cap is never exceeded even by in-flight runs. Override with env.DAILY_BUDGET_USD
// (only ever lower; values above 20 are clamped).
export const DAILY_BUDGET_USD = 20;

// Estimate = (input tokens by chars/3 + prompt overhead) * in price + MAX_OUTPUT_TOKENS * out price,
// multiplied by SAFETY and by MAX_ATTEMPTS (each workflow retry may re-call the model).
export const CHARS_PER_TOKEN = 3;          // pessimistic (real ≈ 4)
export const PROMPT_OVERHEAD_TOKENS = 600; // system prompt + schema
export const MAX_OUTPUT_TOKENS = 1024;
export const SAFETY = 1.25;
export const MAX_ATTEMPTS = 3;             // 1 try + 2 retries (see RunWorkflow)
export const MAX_INPUT_CHARS = 20000;

// Rate limits
export const PER_IP_PER_MINUTE = 6;
export const PER_IP_PER_DAY = 100;
export const GLOBAL_RUNS_PER_DAY = 3000;

export const RESTING_MSG = "The demo is resting for today. Please try again tomorrow.";
