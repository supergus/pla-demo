import * as C from "./constants.js";
export function estimateUsd(input) {
  const chars = JSON.stringify(input ?? "").length;
  const inTok = Math.ceil(chars / C.CHARS_PER_TOKEN) + C.PROMPT_OVERHEAD_TOKENS;
  const one = inTok * C.USD_PER_INPUT_TOKEN + C.MAX_OUTPUT_TOKENS * C.USD_PER_OUTPUT_TOKEN;
  return one * C.SAFETY * C.MAX_ATTEMPTS;
}
export function actualUsd(usage) {
  if (!usage) return null;
  const i = Number(usage.prompt_tokens || 0), o = Number(usage.completion_tokens || 0);
  return i * C.USD_PER_INPUT_TOKEN + o * C.USD_PER_OUTPUT_TOKEN;
}
export function capUsd(env) {
  const v = Number(env?.DAILY_BUDGET_USD);
  return Number.isFinite(v) && v > 0 ? Math.min(v, C.DAILY_BUDGET_USD) : C.DAILY_BUDGET_USD;
}
