// "Secret?" gate for pla.chriscouch.net. Fails closed.
import { safeEqual, signSession, verifySession, safeNext, rateKey } from "./_gate.js";

const COOKIE = "pla_session";
const TTL_MS = 3 * 24 * 3600 * 1000;
const MAX_FAILS = 5;
const WINDOW_MIN = 15;
const ROBOTS = "noindex, nofollow";

function getCookie(req, name) {
  const h = req.headers.get("Cookie") || "";
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function loginPage(next, status, msg = "", extra = {}) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#111;color:#eee}form{display:flex;flex-direction:column;gap:.6rem}input,button{font-size:1rem;padding:.5rem}p{color:#f88;margin:0}</style></head>
<body><form method="POST" action="/__login"><label for="s">Secret?</label><input id="s" name="secret" type="password" autocomplete="current-password" autofocus required><input type="hidden" name="next" value="${esc(next)}"><button type="submit">Enter</button>${msg ? `<p>${esc(msg)}</p>` : ""}</form></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": ROBOTS, ...extra },
  });
}

async function logAttempt(env, ip, ua, ok, path) {
  try {
    if (!env.DB) return;
    await env.DB.prepare("INSERT INTO access_log (ts, ip, ua, ok, path) VALUES (?, ?, ?, ?, ?)")
      .bind(new Date().toISOString(), ip, ua.slice(0, 200), ok, path.slice(0, 200)).run();
  } catch (_) { /* best effort */ }
}

async function recentFails(env, ip) {
  try {
    if (!env.DB) return 0;
    const since = new Date(Date.now() - WINDOW_MIN * 60000).toISOString();
    const pre = rateKey(ip);
    const r = pre
      ? await env.DB.prepare("SELECT COUNT(*) AS n FROM access_log WHERE ip LIKE ? AND ok = 0 AND ts > ?").bind(pre + ":%", since).first()
      : await env.DB.prepare("SELECT COUNT(*) AS n FROM access_log WHERE ip = ? AND ok = 0 AND ts > ?").bind(ip, since).first();
    return (r && r.n) || 0;
  } catch (_) { return 0; }
}

async function handleLogin(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua = request.headers.get("User-Agent") || "";
  let secret = "", next = "/";
  try {
    const f = await request.formData();
    secret = String(f.get("secret") || "");
    next = safeNext(String(f.get("next") || "/"));
  } catch (_) {}

  if ((await recentFails(env, ip)) >= MAX_FAILS) {
    await logAttempt(env, ip, ua, 0, "/__login (rate-limited)");
    return loginPage(next, 429, "Too many attempts. Try again later.", { "Retry-After": String(WINDOW_MIN * 60) });
  }

  const ok = !!env.PLA_SECRET && !!env.COOKIE_KEY && secret.length > 0 && (await safeEqual(secret, env.PLA_SECRET));
  await logAttempt(env, ip, ua, ok ? 1 : 0, "/__login -> " + next);
  if (!ok) return loginPage(next, 401, "Nope.");

  const token = await signSession(env.COOKIE_KEY, Date.now() + TTL_MS);
  return new Response(null, {
    status: 302,
    headers: {
      Location: next,
      "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_MS / 1000}`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": ROBOTS,
    },
  });
}

// Keep upstream redirects inside the proxied prefix: a root-absolute Location such as
// "/login" would otherwise land on the pla site gate's login instead of Leaf Tender's.
export function prefixLocation(res, prefix) {
  const loc = res.headers.get("Location");
  if (!loc || !loc.startsWith("/") || loc.startsWith("//") || loc === prefix || loc.startsWith(prefix + "/")) return res;
  const out = new Response(res.body, res);
  out.headers.set("Location", prefix + loc);
  return out;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (url.pathname === "/__login") {
    if (request.method === "POST") return handleLogin(request, env);
    return loginPage("/", 200);
  }

  if (env.COOKIE_KEY && (await verifySession(env.COOKIE_KEY, getCookie(request, COOKIE)))) {
    if (url.pathname.startsWith("/api/")) {
      // Forward to the rfq-pla Worker via the PLA service binding (configured on the Pages project).
      if (!env.PLA) return new Response(JSON.stringify({ error: "api unavailable" }), { status: 503, headers: { "Content-Type": "application/json", "X-Robots-Tag": ROBOTS } });
      return env.PLA.fetch(request);
    }
    if (url.pathname === "/leaf-tender" || url.pathname.startsWith("/leaf-tender/")) {
      // Leaf Tender Worker (UI + /api). Strip the /leaf-tender prefix so the Worker serves from /.
      if (!env.LEAF_TENDER) return new Response("Leaf Tender unavailable", { status: 503, headers: { "Content-Type": "text/plain", "X-Robots-Tag": ROBOTS } });
      const u = new URL(request.url);
      let rest = u.pathname.slice("/leaf-tender".length) || "/";
      if (!rest.startsWith("/")) rest = "/" + rest;
      u.pathname = rest;
      const headers = new Headers(request.headers);
      headers.set("X-Forwarded-Prefix", "/leaf-tender");
      const res = await env.LEAF_TENDER.fetch(new Request(u.toString(), { method: request.method, headers, body: request.body, redirect: "manual" }));
      return prefixLocation(res, "/leaf-tender");
    }
    const res = await next();
    const out = new Response(res.body, res);
    out.headers.set("X-Robots-Tag", ROBOTS);
    return out;
  }

  const target = safeNext(url.pathname + url.search);
  return loginPage(target, 401);
}
