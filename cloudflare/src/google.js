// Google Business Profile: conectar, publicar (posts locales) y RESEÑAS (leer y contestar).
// Requiere que Google apruebe el acceso a la API de Business Profile para tu proyecto de Google Cloud.
import { fetchJson, encrypt, decrypt, clip, HttpError, uid } from "./util.js";

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/business.manage";
export const googleConfigured = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export function googleAuthUrl(env, redirectUri, state) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenRequest(env, params) {
  return fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  });
}

export async function googleConnect(env, { code, redirectUri, negocioId }) {
  const t = await tokenRequest(env, { code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  if (!t.refresh_token) throw new HttpError(400, "Google no entregó acceso permanente. Quita el acceso de la app en tu cuenta de Google y conecta de nuevo.");
  const auth = { Authorization: "Bearer " + t.access_token };
  const accs = await fetchJson("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", { headers: auth });
  const saved = [];
  const tokEnc = await encrypt(env, t.access_token);
  const refEnc = await encrypt(env, t.refresh_token);
  const expira = Date.now() + (t.expires_in || 3600) * 1000;
  for (const a of (accs.accounts || []).slice(0, 5)) {
    const locs = await fetchJson(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title,metadata&pageSize=50`, { headers: auth });
    for (const l of locs.locations || []) {
      // l.name = "locations/123"; para reseñas (API v4) se necesita "accounts/A/locations/123"
      const full = `${a.name}/${l.name}`;
      const row = await env.DB.prepare("SELECT id FROM cuentas WHERE negocio_id=? AND red='google' AND externo_id=?").bind(negocioId, full).first();
      const id = row?.id || uid();
      await env.DB.prepare(
        `INSERT INTO cuentas (id, negocio_id, red, externo_id, nombre, handle, avatar, token_enc, refresh_enc, token_expira, extra, estado, error)
         VALUES (?,?,'google',?,?,?,?,?,?,?,?,'conectada',NULL)
         ON CONFLICT(negocio_id, red, externo_id) DO UPDATE SET nombre=excluded.nombre, token_enc=excluded.token_enc, refresh_enc=excluded.refresh_enc,
           token_expira=excluded.token_expira, extra=excluded.extra, estado='conectada', error=NULL`
      ).bind(id, negocioId, full, l.title || "Ubicación", a.accountName || "", "", tokEnc, refEnc, expira,
        JSON.stringify({ maps: l.metadata?.mapsUri || "", reviews: l.metadata?.newReviewUri || "" })).run();
      saved.push({ id, red: "google", nombre: l.title });
    }
  }
  if (!saved.length) throw new HttpError(400, "Esa cuenta de Google no tiene ubicaciones de Google Business Profile.");
  return saved;
}

// Token vigente (lo renueva solo si ya venció o está por vencer)
export async function googleToken(env, cuenta, budget) {
  if (cuenta.token_expira && cuenta.token_expira > Date.now() + 120000) return decrypt(env, cuenta.token_enc);
  if (budget && !budget.take()) throw Object.assign(new Error("Límite de llamadas"), { budget: true });
  const t = await tokenRequest(env, { refresh_token: await decrypt(env, cuenta.refresh_enc), grant_type: "refresh_token" });
  const tokEnc = await encrypt(env, t.access_token);
  const expira = Date.now() + (t.expires_in || 3600) * 1000;
  // El mismo token sirve para todas las ubicaciones conectadas con esa cuenta de Google
  await env.DB.prepare("UPDATE cuentas SET token_enc=?, token_expira=? WHERE red='google' AND refresh_enc=?").bind(tokEnc, expira, cuenta.refresh_enc).run();
  cuenta.token_enc = tokEnc; cuenta.token_expira = expira;
  return t.access_token;
}

// ---- Reseñas ----
export async function googleFetchReviews(env, cuenta, budget) {
  const token = await googleToken(env, cuenta, budget);
  const r = await fetchJson(`https://mybusiness.googleapis.com/v4/${cuenta.externo_id}/reviews?pageSize=50&orderBy=updateTime%20desc`, { headers: { Authorization: "Bearer " + token } }, budget);
  return (r.reviews || []).map((rv) => ({
    tipo: "resena",
    externo_id: rv.reviewId || rv.name,
    hilo_id: rv.name,
    autor_id: "",
    autor_nombre: rv.reviewer?.isAnonymous ? "Anónimo" : (rv.reviewer?.displayName || "Cliente de Google"),
    texto: rv.comment || "(sin texto, solo calificación)",
    calificacion: STARS[rv.starRating] || null,
    permalink: "",
    recibido_en: rv.createTime || new Date().toISOString(),
    respondido: rv.reviewReply ? 1 : 0,
    extra: { name: rv.name, respuesta: rv.reviewReply?.comment || null, actualizado: rv.updateTime || null },
  }));
}

export async function googleReplyReview(env, cuenta, msg, text) {
  const token = await googleToken(env, cuenta);
  const name = msg.extra?.name || msg.hilo_id;
  await fetchJson(`https://mybusiness.googleapis.com/v4/${name}/reply`, {
    method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ comment: clip(text, 4000) }),
  });
  return name + "/reply";
}

// ---- Publicaciones locales ----
export async function googlePublish(env, cuenta, post, budget) {
  const token = await googleToken(env, cuenta, budget);
  const body = { languageCode: "es", summary: clip(post.texto, 1500), topicType: "STANDARD" };
  const foto = (post.media || []).find((m) => m.tipo !== "video");
  if (foto) body.media = [{ mediaFormat: "PHOTO", sourceUrl: foto.url }];
  if (post.link) body.callToAction = { actionType: "LEARN_MORE", url: post.link };
  const r = await fetchJson(`https://mybusiness.googleapis.com/v4/${cuenta.externo_id}/localPosts`, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, budget);
  return { hecho: true, externo_id: r.name || "", permalink: r.searchUrl || null };
}
