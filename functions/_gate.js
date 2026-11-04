// Pure helpers for the PLA gate (Web Crypto only).
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

export async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s))));
}

// Constant-time compare: hash both, then XOR every byte.
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export async function signSession(key, expMs) {
  const payload = "v1." + Math.floor(expMs / 1000);
  return payload + "." + (await hmac(key, payload));
}

export async function verifySession(key, token, nowMs = Date.now()) {
  if (!key || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^\d{1,12}$/.test(parts[1])) return false;
  const expected = await hmac(key, parts[0] + "." + parts[1]);
  if (!(await safeEqual(expected, parts[2]))) return false;
  return Number(parts[1]) * 1000 > nowMs;
}

export function safeNext(n) {
  if (typeof n !== "string" || !n.startsWith("/") || n.startsWith("//") || n.startsWith("/\\") || /[\r\n\t]/.test(n)) return "/";
  if (n.startsWith("/__login")) return "/";
  return n;
}

// IPv6 clients are rate-limited per /64 (they often rotate within it). Returns the
// /64 prefix ("a:b:c:d") or null to mean "match the exact IP" (IPv4 / short forms).
export function rateKey(ip) {
  if (typeof ip !== "string" || !ip.includes(":")) return null;
  const head = ip.split("::")[0].split(":");
  if (head.length < 4 || head.slice(0, 4).some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return head.slice(0, 4).join(":").toLowerCase();
}
