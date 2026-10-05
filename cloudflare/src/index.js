// ArtMMX Redes — Worker principal (Cloudflare, plan gratis).
// Basado en BrightBean Studio (https://github.com/brightbeanxyz/brightbean-studio), licencia AGPL-3.0.
import { json, err, HttpError, uid, randomToken, sha256hex, hashPassword, safeEqual, signState, readState, clip, Budget } from "./util.js";
import { ensureSchema, parse } from "./db.js";
import { metaAuthUrl, metaConnect, metaConfigured, metaReply, metaHideComment, verifyMetaSignature, parseMetaWebhook } from "./meta.js";
import { googleAuthUrl, googleConnect, googleConfigured, googleReplyReview } from "./google.js";
import { wellKnown, register, authorize, token as oauthToken, mcp } from "./mcp.js";
import { runCron, storeMessages, publishDue, syncInbox, refreshPostState } from "./engine.js";

const SESSION_MS = 14 * 24 * 3600 * 1000;
const MAX_UPLOAD = 95 * 1024 * 1024; // el plan gratis acepta hasta 100 MB por petición
const TIPOS_MEDIA = { "image/jpeg": "imagen", "image/png": "imagen", "image/webp": "imagen", "video/mp4": "video", "video/quicktime": "video" };

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureSchema(env);
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return err(e.status, e.message);
      console.error(e);
      return err(500, "Error interno: " + clip(e.message, 200));
    }
  },
  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil(runCron(env).then((r) => console.log("cron", JSON.stringify(r))).catch((e) => console.error("cron", e)));
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = request.method;

  // ---------- Públicas ----------
  if (p === "/api/estado" && m === "GET") {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM usuarios").first();
    if (!n.n) await setupCode(env); // genera el código de instalación (se lee en la consola de D1)
    return json({ app: env.APP_NAME || "ArtMMX Redes", instalacion_pendiente: !n.n, meta: metaConfigured(env), google: googleConfigured(env), media: !!env.MEDIA });
  }
  if (p === "/api/instalar" && m === "POST") return instalar(request, env);
  if (p === "/api/login" && m === "POST") return login(request, env);
  if (p.startsWith("/m/") && m === "GET") return serveMedia(env, p.slice(3));
  if (p === "/webhooks/meta") return metaWebhook(request, env, url);
  if (p.startsWith("/.well-known/oauth-")) return wellKnown(url, p) || err(404, "No encontrado");
  if (p === "/oauth/register" && m === "POST") return register(request, env);
  if (p === "/oauth/authorize") return authorize(request, env, url);
  if (p === "/oauth/token" && m === "POST") return oauthToken(request, env);
  if (p === "/mcp") return mcp(request, env, url, route, ctx);
  if (p === "/auth/meta/callback") return oauthCallback(env, url, "meta");
  if (p === "/auth/google/callback") return oauthCallback(env, url, "google");

  if (!p.startsWith("/api/")) return env.ASSETS.fetch(request);

  // ---------- Con sesión ----------
  const s = await session(request, env);
  if (p === "/api/logout" && m === "POST") {
    await env.DB.prepare("DELETE FROM sesiones WHERE token_hash=?").bind(s.tokenHash).run();
    return json({ ok: true });
  }
  if (p === "/api/yo" && m === "GET") return json({ usuario: pub(s.user), negocio: s.negocio, meta: metaConfigured(env), google: googleConfigured(env) });

  // Plataforma (Antonio): negocios
  if (p === "/api/negocios") {
    must(s.user.rol === "plataforma", "Solo el administrador de la plataforma");
    if (m === "GET") {
      const r = await env.DB.prepare(`SELECT n.*, (SELECT COUNT(*) FROM cuentas c WHERE c.negocio_id=n.id) AS cuentas,
        (SELECT COUNT(*) FROM usuarios u WHERE u.negocio_id=n.id) AS usuarios FROM negocios n ORDER BY n.creado DESC`).all();
      return json({ negocios: r.results || [] });
    }
    if (m === "POST") {
      const b = await body(request);
      const nombre = clip(String(b.nombre || "").trim(), 120);
      must(nombre.length >= 2, "Escribe el nombre del negocio", 400);
      const id = uid();
      await env.DB.prepare("INSERT INTO negocios (id, nombre) VALUES (?,?)").bind(id, nombre).run();
      if (b.dueno_email) await createUser(env, { negocioId: id, nombre: b.dueno_nombre || nombre, email: b.dueno_email, password: b.dueno_password, rol: "dueno" });
      return json({ id }, 201);
    }
  }

  const neg = s.negocio;
  must(neg, s.user.rol === "plataforma" ? "Elige un negocio arriba" : "Tu usuario no tiene negocio asignado", 400);
  const isOwner = s.user.rol !== "equipo";

  // Usuarios del negocio
  if (p === "/api/usuarios") {
    if (m === "GET") return json({ usuarios: ((await env.DB.prepare("SELECT * FROM usuarios WHERE negocio_id=? ORDER BY creado").bind(neg.id).all()).results || []).map(pub) });
    if (m === "POST") {
      must(isOwner, "Solo el dueño puede agregar personas");
      const b = await body(request);
      const id = await createUser(env, { negocioId: neg.id, nombre: b.nombre, email: b.email, password: b.password, rol: b.rol === "dueno" ? "dueno" : "equipo" });
      return json({ id }, 201);
    }
  }
  let mm;
  if ((mm = p.match(/^\/api\/usuarios\/([\w-]+)$/)) && m === "DELETE") {
    must(isOwner, "Solo el dueño puede quitar personas");
    must(mm[1] !== s.user.id, "No puedes borrarte a ti mismo", 400);
    await env.DB.prepare("DELETE FROM usuarios WHERE id=? AND negocio_id=?").bind(mm[1], neg.id).run();
    await env.DB.prepare("DELETE FROM sesiones WHERE usuario_id=?").bind(mm[1]).run();
    return json({ ok: true });
  }

  // Cuentas conectadas
  if (p === "/api/cuentas" && m === "GET") {
    const r = await env.DB.prepare("SELECT id, red, externo_id, nombre, handle, avatar, estado, error, sync_en, creado FROM cuentas WHERE negocio_id=? ORDER BY red, nombre").bind(neg.id).all();
    return json({ cuentas: r.results || [] });
  }
  if ((mm = p.match(/^\/api\/cuentas\/([\w-]+)$/)) && m === "DELETE") {
    must(isOwner, "Solo el dueño puede quitar cuentas");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM mensajes WHERE cuenta_id=? AND negocio_id=?").bind(mm[1], neg.id),
      env.DB.prepare("DELETE FROM destinos WHERE cuenta_id=? AND estado IN ('pendiente','procesando') AND cuenta_id IN (SELECT id FROM cuentas WHERE negocio_id=?)").bind(mm[1], neg.id),
      env.DB.prepare("DELETE FROM cuentas WHERE id=? AND negocio_id=?").bind(mm[1], neg.id),
    ]);
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/conectar\/(meta|google)$/)) && m === "POST") {
    must(isOwner, "Solo el dueño puede conectar cuentas");
    const red = mm[1];
    if (red === "meta") must(metaConfigured(env), "Falta configurar la app de Meta (META_APP_ID y META_APP_SECRET)", 400);
    else must(googleConfigured(env), "Falta configurar Google (GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET)", 400);
    const state = await signState(env, { red, negocio: neg.id, usuario: s.user.id });
    const redirect = `${url.origin}/auth/${red}/callback`;
    return json({ url: red === "meta" ? metaAuthUrl(env, redirect, state) : googleAuthUrl(env, redirect, state) });
  }

  // Medios
  if (p === "/api/media" && m === "POST") return uploadMedia(request, env, url, neg);

  // Publicaciones
  if (p === "/api/posts" && m === "GET") {
    const posts = (await env.DB.prepare("SELECT * FROM posts WHERE negocio_id=? ORDER BY COALESCE(programado_para, creado) DESC LIMIT 100").bind(neg.id).all()).results || [];
    const ids = posts.map((x) => x.id);
    let dest = [];
    if (ids.length) dest = (await env.DB.prepare(`SELECT d.post_id, d.estado, d.error, d.permalink, c.red, c.nombre FROM destinos d JOIN cuentas c ON c.id=d.cuenta_id WHERE d.post_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results || [];
    return json({ posts: posts.map((x) => ({ ...x, media: parse(x.media, []), destinos: dest.filter((d) => d.post_id === x.id) })) });
  }
  if (p === "/api/posts" && m === "POST") return createPost(request, env, s, neg);
  if ((mm = p.match(/^\/api\/posts\/([\w-]+)$/)) && m === "DELETE") {
    const post = await env.DB.prepare("SELECT estado FROM posts WHERE id=? AND negocio_id=?").bind(mm[1], neg.id).first();
    must(post, "No existe", 404);
    must(post.estado !== "publicando", "Se está publicando en este momento; espera un minuto", 409);
    await env.DB.batch([env.DB.prepare("DELETE FROM destinos WHERE post_id=?").bind(mm[1]), env.DB.prepare("DELETE FROM posts WHERE id=?").bind(mm[1])]);
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/posts\/([\w-]+)\/reintentar$/)) && m === "POST") {
    const post = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND negocio_id=?").bind(mm[1], neg.id).first();
    must(post, "No existe", 404);
    await env.DB.batch([
      env.DB.prepare("UPDATE destinos SET estado='pendiente', intentos=0, revisiones=0, contenedor=NULL, error=NULL, siguiente=0 WHERE post_id=? AND estado='fallido'").bind(mm[1]),
      env.DB.prepare("UPDATE posts SET estado='programado', programado_para=COALESCE(programado_para, ?) WHERE id=?").bind(new Date().toISOString(), mm[1]),
    ]);
    ctx.waitUntil(publishDue(env, new Budget(40)));
    return json({ ok: true });
  }

  // Bandeja
  if (p === "/api/mensajes" && m === "GET") {
    const where = ["m.negocio_id=?"]; const args = [neg.id];
    const est = url.searchParams.get("estado");
    if (est === "pendientes") where.push("m.estado IN ('nuevo','abierto')");
    else if (est) { where.push("m.estado=?"); args.push(est); }
    if (url.searchParams.get("tipo")) { where.push("m.tipo=?"); args.push(url.searchParams.get("tipo")); }
    if (url.searchParams.get("cuenta")) { where.push("m.cuenta_id=?"); args.push(url.searchParams.get("cuenta")); }
    const r = await env.DB.prepare(`SELECT m.*, c.red, c.nombre AS cuenta_nombre FROM mensajes m JOIN cuentas c ON c.id=m.cuenta_id
      WHERE ${where.join(" AND ")} ORDER BY m.recibido_en DESC LIMIT 200`).bind(...args).all();
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM mensajes WHERE negocio_id=? AND estado='nuevo'").bind(neg.id).first();
    return json({ mensajes: (r.results || []).map((x) => ({ ...x, extra: parse(x.extra, {}) })), nuevos: cnt.n });
  }
  if ((mm = p.match(/^\/api\/mensajes\/([\w-]+)$/))) {
    const msg = await loadMsg(env, mm[1], neg.id);
    if (m === "GET") {
      if (msg.estado === "nuevo") await env.DB.prepare("UPDATE mensajes SET estado='abierto' WHERE id=?").bind(msg.id).run();
      const resp = (await env.DB.prepare("SELECT r.*, u.nombre AS usuario FROM respuestas r LEFT JOIN usuarios u ON u.id=r.usuario_id WHERE mensaje_id=? ORDER BY r.creado").bind(msg.id).all()).results || [];
      const hilo = msg.hilo_id ? ((await env.DB.prepare("SELECT id, autor_nombre, texto, recibido_en FROM mensajes WHERE cuenta_id=? AND hilo_id=? AND tipo=? ORDER BY recibido_en DESC LIMIT 20").bind(msg.cuenta_id, msg.hilo_id, msg.tipo).all()).results || []) : [];
      return json({ mensaje: msg, respuestas: resp, hilo });
    }
    if (m === "PATCH") {
      const b = await body(request);
      if (b.estado) must(["nuevo", "abierto", "resuelto", "archivado"].includes(b.estado), "Estado inválido", 400);
      await env.DB.prepare("UPDATE mensajes SET estado=COALESCE(?,estado), asignado_a=CASE WHEN ? THEN ? ELSE asignado_a END WHERE id=?")
        .bind(b.estado || null, "asignado_a" in b ? 1 : 0, b.asignado_a || null, msg.id).run();
      return json({ ok: true });
    }
  }
  if ((mm = p.match(/^\/api\/mensajes\/([\w-]+)\/responder$/)) && m === "POST") {
    const msg = await loadMsg(env, mm[1], neg.id);
    const texto = clip(String((await body(request)).texto || "").trim(), 4000);
    must(texto, "Escribe la respuesta", 400);
    const cuenta = await env.DB.prepare("SELECT * FROM cuentas WHERE id=?").bind(msg.cuenta_id).first();
    const rid = uid();
    try {
      const ext = cuenta.red === "google" ? await googleReplyReview(env, cuenta, msg, texto) : await metaReply(env, cuenta, msg, texto);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO respuestas (id, mensaje_id, usuario_id, texto, estado, externo_id) VALUES (?,?,?,?, 'enviada', ?)").bind(rid, msg.id, s.user.id, texto, clip(ext, 300)),
        env.DB.prepare("UPDATE mensajes SET respondido=1, estado='resuelto' WHERE id=?").bind(msg.id),
      ]);
      return json({ ok: true });
    } catch (e) {
      await env.DB.prepare("INSERT INTO respuestas (id, mensaje_id, usuario_id, texto, estado, error) VALUES (?,?,?,?, 'fallida', ?)").bind(rid, msg.id, s.user.id, texto, clip(e.message, 300)).run();
      const hint = msg.tipo === "dm" && /24|window|ventana|outside/i.test(e.message) ? " (Meta solo permite responder DMs dentro de 24 h, o hasta 7 días con el permiso Human Agent)" : "";
      return err(502, "La red social no aceptó la respuesta: " + clip(e.message, 200) + hint);
    }
  }
  if ((mm = p.match(/^\/api\/mensajes\/([\w-]+)\/ocultar$/)) && m === "POST") {
    const msg = await loadMsg(env, mm[1], neg.id);
    must(msg.tipo === "comentario", "Solo se pueden ocultar comentarios", 400);
    const cuenta = await env.DB.prepare("SELECT * FROM cuentas WHERE id=?").bind(msg.cuenta_id).first();
    try { await metaHideComment(env, cuenta, msg, true); }
    catch (e) { return err(502, "No se pudo ocultar: " + clip(e.message, 200)); }
    await env.DB.prepare("UPDATE mensajes SET estado='archivado' WHERE id=?").bind(msg.id).run();
    return json({ ok: true });
  }
  if (p === "/api/sincronizar" && m === "POST") {
    await env.DB.prepare("UPDATE cuentas SET sync_en=0 WHERE negocio_id=?").bind(neg.id).run();
    const r = await syncInbox(env, new Budget(40));
    return json({ ok: true, ...r });
  }
  if (p === "/api/resumen" && m === "GET") {
    const q = (sql) => env.DB.prepare(sql).bind(neg.id).first();
    const [nuevos, prog, pub, fall, cuentas] = await Promise.all([
      q("SELECT COUNT(*) AS n FROM mensajes WHERE negocio_id=? AND estado='nuevo'"),
      q("SELECT COUNT(*) AS n FROM posts WHERE negocio_id=? AND estado IN ('programado','publicando')"),
      q("SELECT COUNT(*) AS n FROM posts WHERE negocio_id=? AND estado='publicado'"),
      q("SELECT COUNT(*) AS n FROM posts WHERE negocio_id=? AND estado IN ('fallido','parcial')"),
      q("SELECT COUNT(*) AS n FROM cuentas WHERE negocio_id=?"),
    ]);
    return json({ nuevos: nuevos.n, programados: prog.n, publicados: pub.n, con_error: fall.n, cuentas: cuentas.n });
  }
  return err(404, "No encontrado");
}

// ================= helpers =================
function must(cond, msg, status = 403) { if (!cond) throw new HttpError(status, msg); }
async function body(request) { try { return await request.json(); } catch { return {}; } }
const pub = (u) => ({ id: u.id, nombre: u.nombre, email: u.email, rol: u.rol, negocio_id: u.negocio_id, creado: u.creado });

async function setupCode(env) {
  const r = await env.DB.prepare("SELECT v FROM config WHERE k='codigo_instalacion'").first();
  if (r) return r.v;
  const code = randomToken(9);
  await env.DB.prepare("INSERT OR IGNORE INTO config (k,v) VALUES ('codigo_instalacion',?)").bind(code).run();
  return (await env.DB.prepare("SELECT v FROM config WHERE k='codigo_instalacion'").first()).v;
}

async function instalar(request, env) {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM usuarios").first();
  must(!n.n, "Ya está instalado", 409);
  const b = await body(request);
  const code = await setupCode(env);
  must(safeEqual(String(b.codigo || "").trim(), code), "Código de instalación incorrecto (está en la consola de D1, tabla config)", 403);
  const id = await createUser(env, { negocioId: null, nombre: b.nombre || "Administrador", email: b.email, password: b.password, rol: "plataforma" });
  await env.DB.prepare("DELETE FROM config WHERE k='codigo_instalacion'").run();
  return json({ id }, 201);
}

async function createUser(env, { negocioId, nombre, email, password, rol }) {
  email = String(email || "").trim().toLowerCase();
  must(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), "Correo inválido", 400);
  must(String(password || "").length >= 8, "La contraseña debe tener al menos 8 caracteres", 400);
  const dup = await env.DB.prepare("SELECT id FROM usuarios WHERE email=?").bind(email).first();
  must(!dup, "Ese correo ya tiene usuario", 409);
  const { hash, salt } = await hashPassword(String(password));
  const id = uid();
  await env.DB.prepare("INSERT INTO usuarios (id, negocio_id, email, nombre, rol, pass_hash, pass_salt) VALUES (?,?,?,?,?,?,?)")
    .bind(id, negocioId, email, clip(String(nombre || email).trim(), 80), rol, hash, salt).run();
  return id;
}

async function login(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const key = "login:" + ip;
  const t = Date.now();
  const row = await env.DB.prepare("SELECT n, desde FROM intentos WHERE clave=?").bind(key).first();
  if (row && t - row.desde < 15 * 60e3 && row.n >= 10) return err(429, "Demasiados intentos. Espera 15 minutos.");
  const b = await body(request);
  const u = await env.DB.prepare("SELECT * FROM usuarios WHERE email=? AND activo=1").bind(String(b.email || "").trim().toLowerCase()).first();
  const ok = u && safeEqual((await hashPassword(String(b.password || ""), u.pass_salt)).hash, u.pass_hash);
  if (!ok) {
    if (!row || t - row.desde >= 15 * 60e3) await env.DB.prepare("INSERT OR REPLACE INTO intentos (clave, n, desde) VALUES (?,1,?)").bind(key, t).run();
    else await env.DB.prepare("UPDATE intentos SET n=n+1 WHERE clave=?").bind(key).run();
    return err(401, "Correo o contraseña incorrectos");
  }
  await env.DB.prepare("DELETE FROM intentos WHERE clave=?").bind(key).run();
  const token = randomToken(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sesiones WHERE expira < ?").bind(t),
    env.DB.prepare("INSERT INTO sesiones (token_hash, usuario_id, expira) VALUES (?,?,?)").bind(await sha256hex(token), u.id, t + SESSION_MS),
  ]);
  return json({ token, usuario: pub(u) });
}

async function session(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) throw new HttpError(401, "Inicia sesión");
  const tokenHash = await sha256hex(token);
  const row = await env.DB.prepare("SELECT u.* FROM sesiones s JOIN usuarios u ON u.id=s.usuario_id WHERE s.token_hash=? AND s.expira>? AND u.activo=1").bind(tokenHash, Date.now()).first();
  if (!row) throw new HttpError(401, "Tu sesión expiró. Inicia sesión otra vez.");
  let negocioId = row.negocio_id;
  if (row.rol === "plataforma") negocioId = request.headers.get("X-Negocio") || null;
  const negocio = negocioId ? await env.DB.prepare("SELECT id, nombre FROM negocios WHERE id=? AND activo=1").bind(negocioId).first() : null;
  return { user: row, negocio, tokenHash };
}

async function loadMsg(env, id, negId) {
  const msg = await env.DB.prepare("SELECT m.*, c.red FROM mensajes m JOIN cuentas c ON c.id=m.cuenta_id WHERE m.id=? AND m.negocio_id=?").bind(id, negId).first();
  must(msg, "Mensaje no encontrado", 404);
  msg.extra = parse(msg.extra, {});
  return msg;
}

async function createPost(request, env, s, neg) {
  const b = await body(request);
  const texto = clip(String(b.texto || ""), 63000);
  const media = (Array.isArray(b.media) ? b.media : []).slice(0, 10)
    .filter((x) => x && /^https:\/\//.test(x.url))
    .map((x) => ({ url: clip(x.url, 1000), tipo: x.tipo === "video" ? "video" : "imagen" }));
  const cuentasIds = Array.isArray(b.cuentas) ? b.cuentas.slice(0, 20) : [];
  must(texto.trim() || media.length, "Escribe un texto o agrega una foto", 400);
  must(cuentasIds.length, "Elige al menos una cuenta", 400);
  const cuentas = (await env.DB.prepare(`SELECT id, red FROM cuentas WHERE negocio_id=? AND id IN (${cuentasIds.map(() => "?").join(",")})`).bind(neg.id, ...cuentasIds).all()).results || [];
  must(cuentas.length === cuentasIds.length, "Alguna cuenta no pertenece a este negocio", 400);
  if (cuentas.some((c) => c.red === "instagram")) must(media.length, "Instagram necesita al menos una foto o video", 400);
  const accion = b.accion === "borrador" ? "borrador" : b.accion === "ahora" ? "ahora" : "programar";
  let cuando = null;
  if (accion === "ahora") cuando = new Date().toISOString();
  if (accion === "programar") {
    const d = new Date(b.programado_para);
    must(!isNaN(d), "Fecha inválida", 400);
    must(d.getTime() > Date.now() - 60e3, "La fecha ya pasó", 400);
    cuando = d.toISOString();
  }
  const id = uid();
  const stmts = [env.DB.prepare("INSERT INTO posts (id, negocio_id, autor_id, texto, media, link, formato, programado_para, estado) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(id, neg.id, s.user.id, texto, JSON.stringify(media), b.link ? clip(b.link, 500) : null, b.formato === "story" ? "story" : "post", cuando, accion === "borrador" ? "borrador" : "programado")];
  for (const c of cuentas) stmts.push(env.DB.prepare("INSERT INTO destinos (id, post_id, cuenta_id) VALUES (?,?,?)").bind(uid(), id, c.id));
  await env.DB.batch(stmts);
  return json({ id }, 201);
}

async function uploadMedia(request, env, url, neg) {
  must(env.MEDIA, "Falta el almacenamiento de archivos (R2). Mientras, pega el link de la imagen.", 400);
  const len = Number(request.headers.get("Content-Length") || 0);
  must(len <= MAX_UPLOAD, "El archivo pesa más de 95 MB", 413);
  const form = await request.formData();
  const f = form.get("archivo");
  must(f && typeof f !== "string", "Falta el archivo", 400);
  const tipo = TIPOS_MEDIA[f.type];
  must(tipo, "Formato no permitido (usa JPG, PNG, WEBP, MP4 o MOV)", 400);
  const ext = f.type.split("/")[1].replace("quicktime", "mov").replace("jpeg", "jpg");
  const key = `${neg.id}/${Date.now()}-${randomToken(6)}.${ext}`;
  await env.MEDIA.put(key, f.stream(), { httpMetadata: { contentType: f.type } });
  return json({ url: `${url.origin}/m/${key}`, tipo }, 201);
}

async function serveMedia(env, key) {
  if (!env.MEDIA || !/^[\w-]+\/[\w.-]+$/.test(key)) return err(404, "No existe");
  const obj = await env.MEDIA.get(key);
  if (!obj) return err(404, "No existe");
  return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" } });
}

async function metaWebhook(request, env, url) {
  if (request.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && env.META_VERIFY_TOKEN && safeEqual(url.searchParams.get("hub.verify_token") || "", env.META_VERIFY_TOKEN);
    return ok ? new Response(url.searchParams.get("hub.challenge") || "") : new Response("forbidden", { status: 403 });
  }
  if (request.method !== "POST") return new Response("method", { status: 405 });
  const raw = await request.text();
  if (!(await verifyMetaSignature(env, raw, request.headers.get("X-Hub-Signature-256")))) return new Response("bad signature", { status: 401 });
  let b; try { b = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  const items = parseMetaWebhook(b);
  const porCuenta = new Map();
  for (const it of items) {
    const cs = (await env.DB.prepare("SELECT * FROM cuentas WHERE red=? AND externo_id=?").bind(it.red, it.cuentaExt).all()).results || [];
    for (const c of cs) { if (!porCuenta.has(c.id)) porCuenta.set(c.id, { c, msgs: [] }); porCuenta.get(c.id).msgs.push(it.msg); }
  }
  for (const { c, msgs } of porCuenta.values()) await storeMessages(env, c, msgs);
  return new Response("ok");
}

async function oauthCallback(env, url, red) {
  const back = (q) => Response.redirect(`${url.origin}/panel/#cuentas?${q}`, 302);
  if (url.searchParams.get("error")) return back("error=" + encodeURIComponent(url.searchParams.get("error_description") || url.searchParams.get("error")));
  try {
    const st = await readState(env, url.searchParams.get("state"));
    must(st.red === red, "Enlace de conexión inválido", 400);
    const u = await env.DB.prepare("SELECT rol, negocio_id FROM usuarios WHERE id=? AND activo=1").bind(st.usuario).first();
    must(u && (u.rol === "plataforma" || (u.rol === "dueno" && u.negocio_id === st.negocio)), "No tienes permiso para conectar cuentas aquí");
    const args = { code: url.searchParams.get("code"), redirectUri: `${url.origin}/auth/${red}/callback`, negocioId: st.negocio };
    const saved = red === "meta" ? await metaConnect(env, args) : await googleConnect(env, args);
    return back("ok=" + saved.length);
  } catch (e) {
    return back("error=" + encodeURIComponent(clip(e.message, 200)));
  }
}
