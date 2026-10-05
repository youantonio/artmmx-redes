// Facebook Pages + Instagram (cuenta profesional ligada a la Página) vía Graph API.
// Un solo inicio de sesión de Facebook conecta: publicaciones, comentarios y DMs (Messenger + Instagram).
// Referencia de lógica: BrightBean Studio providers/facebook.py, instagram.py, meta_comments.py, meta_messaging.py.
import { fetchJson, encrypt, decrypt, clip, HttpError, hmacHex, safeEqual, uid } from "./util.js";

export const META_SCOPES = [
  "pages_show_list", "pages_read_engagement", "pages_manage_posts", "pages_manage_engagement",
  "pages_read_user_content", "pages_manage_metadata", "pages_messaging", "business_management",
  "instagram_basic", "instagram_content_publish", "instagram_manage_comments", "instagram_manage_messages",
];
export const PAGE_WEBHOOK_FIELDS = "feed,messages";

const gv = (env) => env.GRAPH_VERSION || "v25.0";
const G = (env) => `https://graph.facebook.com/${gv(env)}`;
export const metaConfigured = (env) => !!(env.META_APP_ID && env.META_APP_SECRET);

async function graph(env, path, { method = "GET", params = {}, token, budget } = {}) {
  const url = new URL(path.startsWith("http") ? path : G(env) + path);
  const body = new URLSearchParams();
  const all = { ...params, ...(token ? { access_token: token } : {}) };
  for (const [k, v] of Object.entries(all)) {
    if (v === undefined || v === null) continue;
    const val = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (method === "GET") url.searchParams.set(k, val); else body.set(k, val);
  }
  return fetchJson(url.toString(), method === "GET" ? {} : { method, body }, budget);
}

export function metaAuthUrl(env, redirectUri, state) {
  const u = new URL(`https://www.facebook.com/${gv(env)}/dialog/oauth`);
  u.searchParams.set("client_id", env.META_APP_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  if (env.META_CONFIG_ID) u.searchParams.set("config_id", env.META_CONFIG_ID);
  else u.searchParams.set("scope", META_SCOPES.join(","));
  return u.toString();
}

// Intercambia el código, obtiene token de larga duración y guarda cada Página (+ su Instagram) como cuenta.
export async function metaConnect(env, { code, redirectUri, negocioId }) {
  const short = await graph(env, "/oauth/access_token", { params: { client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, redirect_uri: redirectUri, code } });
  const long = await graph(env, "/oauth/access_token", { params: { grant_type: "fb_exchange_token", client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, fb_exchange_token: short.access_token } });
  const pages = await graph(env, "/me/accounts", {
    token: long.access_token,
    params: { fields: "id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}", limit: 25 },
  });
  const list = (pages.data || []).slice(0, 15);
  if (!list.length) throw new HttpError(400, "Facebook no regresó ninguna Página. Revisa que seas administrador de la Página y que la hayas seleccionado al dar permisos.");
  const saved = [];
  for (const p of list) {
    const tok = await encrypt(env, p.access_token);
    saved.push(await upsertCuenta(env, { negocioId, red: "facebook", externoId: p.id, nombre: p.name, handle: "", avatar: p.picture?.data?.url || "", tokenEnc: tok, pageId: p.id }));
    const ig = p.instagram_business_account;
    if (ig?.id) saved.push(await upsertCuenta(env, { negocioId, red: "instagram", externoId: ig.id, nombre: ig.username || p.name, handle: ig.username || "", avatar: ig.profile_picture_url || "", tokenEnc: tok, pageId: p.id }));
    // Webhooks de la Página: comentarios (feed) y mensajes (Messenger). Instagram usa la misma suscripción de la app.
    try { await graph(env, `/${p.id}/subscribed_apps`, { method: "POST", token: p.access_token, params: { subscribed_fields: PAGE_WEBHOOK_FIELDS } }); }
    catch (e) { await env.DB.prepare("UPDATE cuentas SET error=? WHERE negocio_id=? AND page_id=?").bind("Webhook: " + clip(e.message, 200), negocioId, p.id).run(); }
  }
  return saved;
}

async function upsertCuenta(env, c) {
  const row = await env.DB.prepare("SELECT id FROM cuentas WHERE negocio_id=? AND red=? AND externo_id=?").bind(c.negocioId, c.red, c.externoId).first();
  const id = row?.id || uid();
  await env.DB.prepare(
    `INSERT INTO cuentas (id, negocio_id, red, externo_id, nombre, handle, avatar, token_enc, page_id, estado, error)
     VALUES (?,?,?,?,?,?,?,?,?,'conectada',NULL)
     ON CONFLICT(negocio_id, red, externo_id) DO UPDATE SET nombre=excluded.nombre, handle=excluded.handle, avatar=excluded.avatar,
       token_enc=excluded.token_enc, page_id=excluded.page_id, estado='conectada', error=NULL`
  ).bind(id, c.negocioId, c.red, c.externoId, c.nombre, c.handle, c.avatar, c.tokenEnc, c.pageId).run();
  return { id, red: c.red, nombre: c.nombre };
}

const tokenOf = (env, cuenta) => decrypt(env, cuenta.token_enc);

// ---------------- PUBLICAR ----------------
// Devuelve { hecho: true, externo_id, permalink } o { pendiente: contenedor } (Instagram procesa en varios pasos).
export async function metaPublish(env, cuenta, post, destino, budget) {
  const token = await tokenOf(env, cuenta);
  const media = post.media || [];
  if (cuenta.red === "facebook") return publishFacebook(env, cuenta, token, post, media, budget);
  return publishInstagram(env, cuenta, token, post, media, destino, budget);
}

async function publishFacebook(env, cuenta, token, post, media, budget) {
  const page = cuenta.externo_id;
  const text = clip(post.texto, 60000);
  const videos = media.filter((m) => m.tipo === "video");
  const fotos = media.filter((m) => m.tipo !== "video");
  let r;
  if (videos.length) {
    r = await graph(env, `/${page}/videos`, { method: "POST", token, budget, params: { file_url: videos[0].url, description: text } });
  } else if (fotos.length === 1) {
    r = await graph(env, `/${page}/photos`, { method: "POST", token, budget, params: { url: fotos[0].url, caption: text } });
    r = { id: r.post_id || r.id };
  } else if (fotos.length > 1) {
    const ids = [];
    for (const f of fotos.slice(0, 10)) {
      const ph = await graph(env, `/${page}/photos`, { method: "POST", token, budget, params: { url: f.url, published: "false" } });
      ids.push({ media_fbid: ph.id });
    }
    const params = { message: text };
    ids.forEach((x, i) => { params[`attached_media[${i}]`] = JSON.stringify(x); });
    r = await graph(env, `/${page}/feed`, { method: "POST", token, budget, params });
  } else {
    r = await graph(env, `/${page}/feed`, { method: "POST", token, budget, params: { message: text, link: post.link || undefined } });
  }
  return { hecho: true, externo_id: r.id, permalink: r.id ? `https://www.facebook.com/${r.id}` : null };
}

async function publishInstagram(env, cuenta, token, post, media, destino, budget) {
  const ig = cuenta.externo_id;
  const caption = clip(post.texto, 2200);
  if (!media.length) throw Object.assign(new Error("Instagram necesita al menos una foto o video"), { permanente: true });

  // Paso 2: ya hay contenedor → revisar si terminó de procesarse y publicarlo.
  if (destino.contenedor) {
    const st = await graph(env, `/${destino.contenedor}`, { token, budget, params: { fields: "status_code,status" } });
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw Object.assign(new Error("Instagram rechazó el archivo: " + (st.status || st.status_code)), { permanente: true });
    if (st.status_code !== "FINISHED") return { pendiente: destino.contenedor };
    const pub = await graph(env, `/${ig}/media_publish`, { method: "POST", token, budget, params: { creation_id: destino.contenedor } });
    let permalink = null;
    try { permalink = (await graph(env, `/${pub.id}`, { token, budget, params: { fields: "permalink" } })).permalink; } catch {}
    return { hecho: true, externo_id: pub.id, permalink };
  }

  // Paso 1: crear el contenedor.
  let cont;
  if (media.length === 1) {
    const m = media[0];
    const params = m.tipo === "video" ? { media_type: "REELS", video_url: m.url, caption } : { image_url: m.url, caption };
    if (post.formato === "story") { params.media_type = "STORIES"; delete params.caption; }
    cont = await graph(env, `/${ig}/media`, { method: "POST", token, budget, params });
  } else {
    const children = [];
    for (const m of media.slice(0, 10)) {
      const params = m.tipo === "video" ? { media_type: "VIDEO", video_url: m.url, is_carousel_item: "true" } : { image_url: m.url, is_carousel_item: "true" };
      children.push((await graph(env, `/${ig}/media`, { method: "POST", token, budget, params })).id);
    }
    cont = await graph(env, `/${ig}/media`, { method: "POST", token, budget, params: { media_type: "CAROUSEL", children: children.join(","), caption } });
  }
  return { pendiente: cont.id };
}

// ---------------- BANDEJA: leer ----------------
// Devuelve una lista de mensajes normalizados {tipo, externo_id, hilo_id, autor_id, autor_nombre, texto, permalink, recibido_en, extra}
export async function metaFetchInbox(env, cuenta, budget) {
  const token = await tokenOf(env, cuenta);
  const out = [];
  const self = new Set([cuenta.externo_id, cuenta.page_id].filter(Boolean));
  const selfHandle = (cuenta.handle || "").toLowerCase();

  // Comentarios
  if (cuenta.red === "facebook") {
    const feed = await graph(env, `/${cuenta.externo_id}/feed`, { token, budget, params: { limit: 10, fields: "id,permalink_url,comments.limit(25).order(reverse_chronological){id,message,created_time,from{id,name},parent{id}}" } });
    for (const p of feed.data || []) for (const c of p.comments?.data || []) {
      if (self.has(c.from?.id)) continue;
      out.push({ tipo: "comentario", externo_id: c.id, hilo_id: p.id, autor_id: c.from?.id || "", autor_nombre: c.from?.name || "Usuario de Facebook", texto: c.message || "", permalink: p.permalink_url || "", recibido_en: iso(c.created_time), extra: { post_id: p.id, parent_id: c.parent?.id || null } });
    }
  } else {
    const med = await graph(env, `/${cuenta.externo_id}/media`, { token, budget, params: { limit: 10, fields: "id,permalink,comments.limit(25){id,text,timestamp,username,from{id,username}}" } });
    for (const p of med.data || []) for (const c of p.comments?.data || []) {
      const user = c.from?.username || c.username || "";
      if (self.has(c.from?.id) || (selfHandle && user.toLowerCase() === selfHandle)) continue;
      out.push({ tipo: "comentario", externo_id: c.id, hilo_id: p.id, autor_id: c.from?.id || "", autor_nombre: user ? "@" + user : "Usuario de Instagram", texto: c.text || "", permalink: p.permalink || "", recibido_en: iso(c.timestamp), extra: { media_id: p.id } });
    }
  }

  // DMs (Messenger o Instagram Direct, ambos por la Página)
  const platform = cuenta.red === "facebook" ? "messenger" : "instagram";
  const conv = await graph(env, `/${cuenta.page_id || cuenta.externo_id}/conversations`, { token, budget, params: { platform, limit: 10, fields: "id,updated_time,messages.limit(5){id,message,created_time,from}" } });
  for (const cv of conv.data || []) for (const m of cv.messages?.data || []) {
    const from = m.from || {};
    if (self.has(from.id) || (selfHandle && (from.username || "").toLowerCase() === selfHandle)) continue;
    out.push({ tipo: "dm", externo_id: m.id, hilo_id: cv.id, autor_id: from.id || "", autor_nombre: from.name || (from.username ? "@" + from.username : "Contacto"), texto: m.message || "(archivo adjunto)", permalink: "", recibido_en: iso(m.created_time), extra: { conversacion: cv.id } });
  }
  return out;
}

const iso = (t) => { const d = t ? new Date(typeof t === "number" ? t : String(t).replace(/\+0000$/, "Z")) : new Date(); return isNaN(d) ? new Date().toISOString() : d.toISOString(); };

// ---------------- BANDEJA: responder / ocultar ----------------
export async function metaReply(env, cuenta, msg, text) {
  const token = await tokenOf(env, cuenta);
  if (msg.tipo === "dm") {
    const old = Date.now() - new Date(msg.recibido_en).getTime() > 24 * 3600 * 1000;
    const params = { recipient: { id: msg.autor_id }, message: { text: clip(text, 1000) }, messaging_type: old ? "MESSAGE_TAG" : "RESPONSE" };
    if (old) params.tag = "HUMAN_AGENT";
    const r = await graph(env, `/${cuenta.page_id || cuenta.externo_id}/messages`, { method: "POST", token, params });
    return r.message_id || r.id || "";
  }
  const edge = cuenta.red === "instagram" ? "replies" : "comments";
  const target = cuenta.red === "facebook" && msg.extra?.parent_id ? msg.extra.parent_id : msg.externo_id;
  const r = await graph(env, `/${target}/${edge}`, { method: "POST", token, params: { message: clip(text, 2000) } });
  return r.id || "";
}

export async function metaHideComment(env, cuenta, msg, hide = true) {
  const token = await tokenOf(env, cuenta);
  const params = cuenta.red === "instagram" ? { hide: String(hide) } : { is_hidden: String(hide) };
  await graph(env, `/${msg.externo_id}`, { method: "POST", token, params });
}

// ---------------- WEBHOOKS ----------------
export async function verifyMetaSignature(env, raw, header) {
  if (!env.META_APP_SECRET || !header?.startsWith("sha256=")) return false;
  const expected = await hmacHex(env.META_APP_SECRET, raw);
  return safeEqual(header.slice(7), expected);
}

// Convierte el cuerpo del webhook en mensajes normalizados agrupados por id externo de la cuenta (Página o IG).
export function parseMetaWebhook(body) {
  const out = []; // { cuentaExt, red, msg }
  const red = body.object === "instagram" ? "instagram" : body.object === "page" ? "facebook" : null;
  if (!red) return out;
  for (const entry of body.entry || []) {
    const acct = String(entry.id || "");
    for (const ev of entry.messaging || []) {
      const m = ev.message;
      if (!m || m.is_echo || !m.mid) continue;
      if (String(ev.sender?.id) === acct) continue;
      out.push({ cuentaExt: acct, red, msg: { tipo: "dm", externo_id: m.mid, hilo_id: String(ev.sender?.id || ""), autor_id: String(ev.sender?.id || ""), autor_nombre: "Contacto", texto: m.text || (m.attachments?.length ? "(archivo adjunto)" : ""), permalink: "", recibido_en: iso(ev.timestamp), extra: { webhook: true } } });
    }
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (red === "facebook" && ch.field === "feed" && v.item === "comment" && v.verb === "add") {
        if (String(v.from?.id) === acct) continue;
        out.push({ cuentaExt: acct, red, msg: { tipo: "comentario", externo_id: v.comment_id, hilo_id: v.post_id, autor_id: v.from?.id || "", autor_nombre: v.from?.name || "Usuario de Facebook", texto: v.message || "", permalink: v.post?.permalink_url || "", recibido_en: iso(v.created_time ? v.created_time * 1000 : null), extra: { post_id: v.post_id, parent_id: v.parent_id && v.parent_id !== v.post_id ? v.parent_id : null } } });
      }
      if (red === "instagram" && ch.field === "comments" && v.id) {
        if (String(v.from?.id) === acct) continue;
        out.push({ cuentaExt: acct, red, msg: { tipo: "comentario", externo_id: v.id, hilo_id: v.media?.id || "", autor_id: v.from?.id || "", autor_nombre: v.from?.username ? "@" + v.from.username : "Usuario de Instagram", texto: v.text || "", permalink: "", recibido_en: new Date().toISOString(), extra: { media_id: v.media?.id || null } } });
      }
    }
  }
  return out;
}
