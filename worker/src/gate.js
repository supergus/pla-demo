// Same HMAC-SHA256 `pla_session` scheme as functions/_gate.js (re-exported so there is one implementation).
export { verifySession, signSession } from "../../functions/_gate.js";
import { verifySession } from "../../functions/_gate.js";
export function getCookie(req, name) {
  const h = req.headers.get("Cookie") || "";
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}
// Accepts a cookie signed with the production key or the preview key.
export async function hasSession(req, env, nowMs = Date.now()) {
  const t = getCookie(req, "pla_session");
  if (!t) return false;
  for (const k of [env.COOKIE_KEY, env.COOKIE_KEY_PREVIEW]) if (k && (await verifySession(k, t, nowMs))) return true;
  return false;
}
