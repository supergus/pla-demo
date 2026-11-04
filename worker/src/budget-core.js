// Pure budget/rate-limit logic over an async key/value store (DO storage or a Map in tests).
import * as C from "./constants.js";
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const r6 = (x) => Math.round(x * 1e6) / 1e6;

export async function reserve(store, { ip, estUsd, capUsd, nowMs, id }) {
  const day = utcDay(nowMs), minute = Math.floor(nowMs / 60000);
  const g = (await store.get("g:" + day)) || { spent: 0, reserved: 0, runs: 0 };
  const ipd = (await store.get(`ipd:${day}:${ip}`)) || 0;
  const ipm = (await store.get(`ipm:${minute}:${ip}`)) || 0;
  if (ipm >= C.PER_IP_PER_MINUTE) return { ok: false, status: 429, reason: "rate", retryAfter: 60 - Math.floor((nowMs / 1000) % 60) };
  if (ipd >= C.PER_IP_PER_DAY) return { ok: false, status: 429, reason: "ip-day" };
  if (g.runs >= C.GLOBAL_RUNS_PER_DAY || g.spent + g.reserved + estUsd > capUsd) return { ok: false, status: 503, reason: "budget" };
  g.reserved = r6(g.reserved + estUsd); g.runs += 1;
  await store.put("g:" + day, g);
  await store.put(`ipd:${day}:${ip}`, ipd + 1);
  await store.put(`ipm:${minute}:${ip}`, ipm + 1);
  await store.put("res:" + id, { day, estUsd });
  return { ok: true, day };
}

// Settle a reservation. actualUsd null => keep the full estimate as spent (conservative).
export async function settle(store, { id, actualUsd }) {
  const res = await store.get("res:" + id);
  if (!res) return { ok: false, reason: "unknown-or-settled" };   // idempotent
  const g = (await store.get("g:" + res.day)) || { spent: 0, reserved: 0, runs: 0 };
  const charge = actualUsd == null ? res.estUsd : Math.max(0, actualUsd);
  g.reserved = r6(Math.max(0, g.reserved - res.estUsd));
  g.spent = r6(g.spent + charge);
  await store.put("g:" + res.day, g);
  await store.delete("res:" + id);
  return { ok: true, charged: charge };
}

export async function stats(store, nowMs) {
  return (await store.get("g:" + utcDay(nowMs))) || { spent: 0, reserved: 0, runs: 0 };
}
