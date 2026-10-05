// Utilidades: respuestas, cifrado (AES-GCM), contraseñas (PBKDF2), firmas (HMAC).
const enc = new TextEncoder();
const dec = new TextDecoder();

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

export const err = (status, message, extra = {}) => json({ error: message, ...extra }, status);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

export const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const randomToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));

export async function sha256hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export async function hmacHex(key, data, algo = "SHA-256") {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: algo }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, typeof data === "string" ? enc.encode(data) : data));
}

export function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---- Llave maestra: SECRET_KEY (secreto del Worker) o, si no existe, una generada y guardada en D1 ----
let masterCache = null;
export async function masterSecret(env) {
  if (env.SECRET_KEY) return env.SECRET_KEY;
  if (masterCache) return masterCache;
  const row = await env.DB.prepare("SELECT v FROM config WHERE k='secret_key'").first();
  if (row) return (masterCache = row.v);
  const v = randomToken(48);
  await env.DB.prepare("INSERT OR IGNORE INTO config (k,v) VALUES ('secret_key',?)").bind(v).run();
  const again = await env.DB.prepare("SELECT v FROM config WHERE k='secret_key'").first();
  return (masterCache = again.v);
}

async function aesKey(env) {
  const base = await crypto.subtle.importKey("raw", enc.encode(await masterSecret(env)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("artmmx-redes"), info: enc.encode("tokens-v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encrypt(env, text) {
  if (text == null || text === "") return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(String(text)));
  const out = new Uint8Array(12 + ct.byteLength); out.set(iv); out.set(new Uint8Array(ct), 12);
  return b64u(out);
}

export async function decrypt(env, blob) {
  if (!blob) return null;
  const raw = unb64u(blob);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await aesKey(env), raw.slice(12));
  return dec.decode(pt);
}

// ---- Contraseñas ----
export async function hashPassword(password, saltB64) {
  const salt = saltB64 ? unb64u(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const k = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, k, 256);
  return { hash: b64u(bits), salt: b64u(salt) };
}

// ---- Estado firmado para OAuth (evita CSRF y dice a qué negocio pertenece la conexión) ----
export async function signState(env, payload) {
  const body = b64u(enc.encode(JSON.stringify({ ...payload, exp: Date.now() + 15 * 60 * 1000, n: randomToken(8) })));
  return body + "." + (await hmacHex(await masterSecret(env), "state:" + body));
}
export async function readState(env, state) {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig || !safeEqual(sig, await hmacHex(await masterSecret(env), "state:" + body))) throw new HttpError(400, "Enlace de conexión inválido");
  const p = JSON.parse(dec.decode(unb64u(body)));
  if (p.exp < Date.now()) throw new HttpError(400, "El enlace de conexión expiró, inténtalo otra vez");
  return p;
}

// ---- Presupuesto de subrequests (plan gratis: 50 por ejecución) ----
export class Budget {
  constructor(n = 45) { this.left = n; }
  take(n = 1) { if (this.left < n) return false; this.left -= n; return true; }
}

export async function fetchJson(url, opts = {}, budget) {
  if (budget && !budget.take()) throw Object.assign(new Error("Límite de llamadas por minuto alcanzado"), { budget: true });
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  if (!r.ok) {
    const msg = data?.error?.message || data?.error_description || data?.error?.status || data?.raw || ("HTTP " + r.status);
    const e = new Error(String(msg));
    e.status = r.status; e.data = data;
    e.code = data?.error?.code;
    throw e;
  }
  return data;
}

export const clip = (s, n) => String(s ?? "").slice(0, n);
