// Conector para Claude (MCP por HTTP + OAuth 2.1 con registro dinámico y PKCE S256).
// En Claude: Configuración → Conectores → Agregar conector personalizado → https://TU-WORKER/mcp
// Cada herramienta reutiliza la API del panel con los mismos permisos del usuario que autorizó.
import { json, err, HttpError, uid, randomToken, sha256hex, hashPassword, safeEqual, clip, b64u } from "./util.js";

const PROTOCOL = "2025-06-18";
const ACCESS_MS = 30 * 24 * 3600e3;   // 30 días
const REFRESH_MS = 180 * 24 * 3600e3; // 180 días
const CODE_MS = 5 * 60e3;

export const MCP_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS oauth_clientes (id TEXT PRIMARY KEY, nombre TEXT, redirect_uris TEXT NOT NULL, creado TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS oauth_codigos (codigo_hash TEXT PRIMARY KEY, cliente_id TEXT NOT NULL, usuario_id TEXT NOT NULL, negocio_id TEXT,
     redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expira INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mcp_tokens (token_hash TEXT PRIMARY KEY, refresh_hash TEXT UNIQUE, usuario_id TEXT NOT NULL, negocio_id TEXT,
     cliente_id TEXT NOT NULL, expira INTEGER NOT NULL, refresh_expira INTEGER NOT NULL, creado TEXT NOT NULL DEFAULT (datetime('now')))`,
];

// ---------------- Descubrimiento ----------------
export function wellKnown(url, path) {
  const o = url.origin;
  if (path.startsWith("/.well-known/oauth-protected-resource"))
    return json({ resource: `${o}/mcp`, authorization_servers: [o], bearer_methods_supported: ["header"], scopes_supported: ["redes"] });
  if (path.startsWith("/.well-known/oauth-authorization-server"))
    return json({
      issuer: o, authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/oauth/token`, registration_endpoint: `${o}/oauth/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["redes"],
    });
  return null;
}

// ---------------- Registro dinámico de clientes (Claude se registra solo) ----------------
export async function register(request, env) {
  const b = await request.json().catch(() => ({}));
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String).slice(0, 5) : [];
  if (!uris.length || !uris.every(validRedirect)) return json({ error: "invalid_redirect_uri" }, 400);
  const id = "c_" + randomToken(16);
  await env.DB.prepare("INSERT INTO oauth_clientes (id, nombre, redirect_uris) VALUES (?,?,?)").bind(id, clip(b.client_name || "Cliente MCP", 80), JSON.stringify(uris)).run();
  return json({ client_id: id, client_name: b.client_name || "Cliente MCP", redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], token_endpoint_auth_method: "none", client_id_issued_at: Math.floor(Date.now() / 1000) }, 201);
}
function validRedirect(u) {
  try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1"].includes(x.hostname)); } catch { return false; }
}

// ---------------- Autorizar: el usuario entra con su correo y elige negocio ----------------
export async function authorize(request, env, url) {
  const q = request.method === "POST" ? Object.fromEntries(await request.formData()) : Object.fromEntries(url.searchParams);
  const cliente = q.client_id ? await env.DB.prepare("SELECT * FROM oauth_clientes WHERE id=?").bind(q.client_id).first() : null;
  if (!cliente) return page("Conector no reconocido", "<p>Vuelve a agregar el conector desde Claude.</p>", 400);
  const uris = JSON.parse(cliente.redirect_uris);
  if (!uris.includes(q.redirect_uri)) return page("Dirección de regreso inválida", "<p>Vuelve a agregar el conector desde Claude.</p>", 400);
  if (q.response_type !== "code" || !q.code_challenge || (q.code_challenge_method || "S256") !== "S256")
    return redirectBack(q, { error: "invalid_request", error_description: "Se requiere PKCE S256" });

  let error = "";
  if (request.method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const key = "oauth:" + ip; const t = Date.now();
    const lim = await env.DB.prepare("SELECT n, desde FROM intentos WHERE clave=?").bind(key).first();
    if (lim && t - lim.desde < 15 * 60e3 && lim.n >= 10) error = "Demasiados intentos. Espera 15 minutos.";
    else {
      const u = await env.DB.prepare("SELECT * FROM usuarios WHERE email=? AND activo=1").bind(String(q.email || "").trim().toLowerCase()).first();
      const ok = u && safeEqual((await hashPassword(String(q.password || ""), u.pass_salt)).hash, u.pass_hash);
      if (!ok) {
        if (!lim || t - lim.desde >= 15 * 60e3) await env.DB.prepare("INSERT OR REPLACE INTO intentos (clave, n, desde) VALUES (?,1,?)").bind(key, t).run();
        else await env.DB.prepare("UPDATE intentos SET n=n+1 WHERE clave=?").bind(key).run();
        error = "Correo o contraseña incorrectos";
      } else {
        let negocio = u.negocio_id;
        if (u.rol === "plataforma") {
          const n = q.negocio ? await env.DB.prepare("SELECT id FROM negocios WHERE id=? AND activo=1").bind(q.negocio).first() : null;
          if (!n) error = "Elige el negocio que Claude va a administrar";
          negocio = n?.id;
        }
        if (!error) {
          const code = randomToken(32);
          await env.DB.prepare("INSERT INTO oauth_codigos (codigo_hash, cliente_id, usuario_id, negocio_id, redirect_uri, challenge, expira) VALUES (?,?,?,?,?,?,?)")
            .bind(await sha256hex(code), cliente.id, u.id, negocio, q.redirect_uri, q.code_challenge, Date.now() + CODE_MS).run();
          return redirectBack(q, { code });
        }
      }
    }
  }
  const negocios = (await env.DB.prepare("SELECT id, nombre FROM negocios WHERE activo=1 ORDER BY nombre").all()).results || [];
  const hidden = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope"]
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] || "")}">`).join("");
  return page("Conectar Claude a ArtMMX Redes", `
    <p><b>${esc(cliente.nombre)}</b> quiere leer tu bandeja, responder mensajes y programar publicaciones en tu nombre.</p>
    <form method="POST">${hidden}
      <label>Correo</label><input name="email" type="email" required value="${esc(q.email || "")}" autocomplete="username">
      <label>Contraseña</label><input name="password" type="password" required autocomplete="current-password">
      <label>Negocio (solo si eres administrador de la plataforma)</label>
      <select name="negocio"><option value="">— El mío —</option>${negocios.map((n) => `<option value="${esc(n.id)}" ${q.negocio === n.id ? "selected" : ""}>${esc(n.nombre)}</option>`).join("")}</select>
      ${error ? `<p class="e">${esc(error)}</p>` : ""}
      <button>Autorizar</button>
    </form>`, error ? 400 : 200);
}

function redirectBack(q, params) {
  const u = new URL(q.redirect_uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (q.state) u.searchParams.set("state", q.state);
  return Response.redirect(u.toString(), 302);
}

// ---------------- Token ----------------
export async function token(request, env) {
  const ct = request.headers.get("Content-Type") || "";
  const b = ct.includes("json") ? await request.json().catch(() => ({})) : Object.fromEntries(await request.formData().catch(() => new FormData()));
  const bad = (e, d) => json({ error: e, error_description: d }, 400);
  if (b.grant_type === "authorization_code") {
    const row = await env.DB.prepare("SELECT * FROM oauth_codigos WHERE codigo_hash=?").bind(await sha256hex(String(b.code || ""))).first();
    if (!row) return bad("invalid_grant", "Código inválido");
    await env.DB.prepare("DELETE FROM oauth_codigos WHERE codigo_hash=?").bind(row.codigo_hash).run(); // un solo uso
    if (row.expira < Date.now() || row.cliente_id !== b.client_id || row.redirect_uri !== b.redirect_uri) return bad("invalid_grant", "Código vencido o no corresponde");
    const challenge = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(b.code_verifier || ""))));
    if (!safeEqual(challenge, row.challenge)) return bad("invalid_grant", "PKCE inválido");
    return json(await issue(env, row.usuario_id, row.negocio_id, row.cliente_id));
  }
  if (b.grant_type === "refresh_token") {
    const row = await env.DB.prepare("SELECT * FROM mcp_tokens WHERE refresh_hash=?").bind(await sha256hex(String(b.refresh_token || ""))).first();
    if (!row || row.refresh_expira < Date.now() || (b.client_id && b.client_id !== row.cliente_id)) return bad("invalid_grant", "Refresh inválido");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM mcp_tokens WHERE token_hash=?").bind(row.token_hash),
      env.DB.prepare("DELETE FROM sesiones WHERE token_hash=?").bind(row.token_hash),
    ]);
    return json(await issue(env, row.usuario_id, row.negocio_id, row.cliente_id));
  }
  return bad("unsupported_grant_type", "");
}

async function issue(env, usuarioId, negocioId, clienteId) {
  const access = "mcp_" + randomToken(32), refresh = "mcr_" + randomToken(32);
  const ah = await sha256hex(access), t = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sesiones (token_hash, usuario_id, expira) VALUES (?,?,?)").bind(ah, usuarioId, t + ACCESS_MS),
    env.DB.prepare("INSERT INTO mcp_tokens (token_hash, refresh_hash, usuario_id, negocio_id, cliente_id, expira, refresh_expira) VALUES (?,?,?,?,?,?,?)")
      .bind(ah, await sha256hex(refresh), usuarioId, negocioId, clienteId, t + ACCESS_MS, t + REFRESH_MS),
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: Math.floor(ACCESS_MS / 1000), refresh_token: refresh, scope: "redes" };
}

// ---------------- Servidor MCP ----------------
const TOOLS = [
  { name: "resumen", description: "Resumen del negocio: mensajes nuevos, publicaciones programadas, publicadas, con error y cuentas conectadas.", inputSchema: { type: "object", properties: {} } },
  { name: "listar_cuentas", description: "Cuentas conectadas (Facebook, Instagram, Google Business) con su id, estado y errores.", inputSchema: { type: "object", properties: {} } },
  { name: "listar_mensajes", description: "Lista la bandeja: DMs de Instagram/Messenger, comentarios y reseñas de Google. Por defecto solo los pendientes.",
    inputSchema: { type: "object", properties: {
      estado: { type: "string", enum: ["pendientes", "nuevo", "abierto", "resuelto", "archivado", "todos"], default: "pendientes" },
      tipo: { type: "string", enum: ["dm", "comentario", "resena"] }, limite: { type: "integer", minimum: 1, maximum: 100, default: 30 } } } },
  { name: "ver_mensaje", description: "Detalle de un mensaje con su conversación previa y las respuestas ya enviadas.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "responder_mensaje", description: "Envía una respuesta REAL a la red social (DM privado, respuesta pública a comentario o respuesta pública a reseña de Google). Confirma el texto con el usuario antes de enviar.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, texto: { type: "string", maxLength: 4000 } }, required: ["id", "texto"] } },
  { name: "cambiar_estado_mensaje", description: "Marca un mensaje como resuelto, archivado, abierto o nuevo.", inputSchema: { type: "object", properties: { id: { type: "string" }, estado: { type: "string", enum: ["nuevo", "abierto", "resuelto", "archivado"] } }, required: ["id", "estado"] } },
  { name: "ocultar_comentario", description: "Oculta un comentario de Facebook o Instagram (deja de verse públicamente).", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "listar_publicaciones", description: "Últimas publicaciones con su estado por cuenta (programado, publicado, error).", inputSchema: { type: "object", properties: { limite: { type: "integer", minimum: 1, maximum: 100, default: 20 } } } },
  { name: "crear_publicacion", description: "Crea una publicación para una o varias cuentas. accion: 'borrador', 'programar' (requiere programado_para en ISO 8601 con zona horaria) o 'ahora'. Instagram exige al menos una imagen o video (URL https pública).",
    inputSchema: { type: "object", properties: {
      texto: { type: "string" }, cuentas: { type: "array", items: { type: "string" }, description: "ids de listar_cuentas" },
      accion: { type: "string", enum: ["borrador", "programar", "ahora"], default: "borrador" }, programado_para: { type: "string" },
      imagenes: { type: "array", items: { type: "string" }, description: "URLs https de imágenes" }, videos: { type: "array", items: { type: "string" } },
      link: { type: "string" }, formato: { type: "string", enum: ["post", "story"], default: "post" } }, required: ["texto", "cuentas"] } },
];

export async function mcp(request, env, url, route, ctx) {
  const unauthorized = () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: {
    "Content-Type": "application/json", "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"` } });
  if (request.method === "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return new Response("", { status: 405 });
  const h = request.headers.get("Authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!tok) return unauthorized();
  const t = await env.DB.prepare("SELECT * FROM mcp_tokens WHERE token_hash=? AND expira>?").bind(await sha256hex(tok), Date.now()).first();
  if (!t) return unauthorized();

  const call = async (method, path, body) => {
    const r = await route(new Request(url.origin + path, { method, headers: { Authorization: "Bearer " + tok, "X-Negocio": t.negocio_id || "", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined }), env, ctx);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(r.status, d.error || "Error " + r.status);
    return d;
  };

  let msg; try { msg = await request.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  const batch = Array.isArray(msg) ? msg : [msg];
  const out = [];
  for (const m of batch) {
    if (m.id === undefined || m.id === null) continue; // notificaciones
    const ok = (result) => out.push({ jsonrpc: "2.0", id: m.id, result });
    const fail = (code, message) => out.push({ jsonrpc: "2.0", id: m.id, error: { code, message } });
    if (m.method === "initialize") ok({ protocolVersion: m.params?.protocolVersion || PROTOCOL, capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "artmmx-redes", version: "1.0.0" },
      instructions: "Herramientas para administrar redes sociales del negocio en ArtMMX Redes. Antes de responder_mensaje o crear_publicacion con accion 'ahora', muestra el texto al usuario y pide confirmación." });
    else if (m.method === "ping") ok({});
    else if (m.method === "tools/list") ok({ tools: TOOLS });
    else if (m.method === "tools/call") {
      try { ok({ content: [{ type: "text", text: JSON.stringify(await runTool(m.params?.name, m.params?.arguments || {}, call), null, 1) }] }); }
      catch (e) { ok({ isError: true, content: [{ type: "text", text: e.message || String(e) }] }); }
    } else fail(-32601, "Método no soportado: " + m.method);
  }
  if (!out.length) return new Response(null, { status: 202 });
  return json(Array.isArray(msg) ? out : out[0]);
}

async function runTool(name, a, call) {
  const id = (x) => { if (!/^[\w-]{1,64}$/.test(String(x || ""))) throw new Error("id inválido"); return x; };
  switch (name) {
    case "resumen": return call("GET", "/api/resumen");
    case "listar_cuentas": return (await call("GET", "/api/cuentas")).cuentas.map((c) => ({ id: c.id, red: c.red, nombre: c.nombre, handle: c.handle, estado: c.estado, error: c.error }));
    case "listar_mensajes": {
      const est = a.estado === "todos" ? "" : (a.estado || "pendientes");
      const d = await call("GET", `/api/mensajes?estado=${encodeURIComponent(est)}&tipo=${encodeURIComponent(a.tipo || "")}`);
      return { nuevos: d.nuevos, mensajes: d.mensajes.slice(0, Math.min(100, a.limite || 30)).map((m) => ({ id: m.id, tipo: m.tipo, red: m.red, cuenta: m.cuenta_nombre,
        de: m.autor_nombre, texto: m.texto, estrellas: m.calificacion, recibido: m.recibido_en, estado: m.estado, respondido: !!m.respondido })) };
    }
    case "ver_mensaje": {
      const d = await call("GET", "/api/mensajes/" + id(a.id));
      const m = d.mensaje;
      return { id: m.id, tipo: m.tipo, red: m.red, de: m.autor_nombre, texto: m.texto, estrellas: m.calificacion, recibido: m.recibido_en, estado: m.estado,
        respuesta_publica_previa: m.extra?.respuesta || null, conversacion: d.hilo.map((x) => ({ de: x.autor_nombre, texto: x.texto, fecha: x.recibido_en })),
        respuestas: d.respuestas.map((r) => ({ texto: r.texto, estado: r.estado, error: r.error, fecha: r.creado })) };
    }
    case "responder_mensaje": await call("POST", `/api/mensajes/${id(a.id)}/responder`, { texto: a.texto }); return { ok: true, enviado: true };
    case "cambiar_estado_mensaje": await call("PATCH", "/api/mensajes/" + id(a.id), { estado: a.estado }); return { ok: true };
    case "ocultar_comentario": await call("POST", `/api/mensajes/${id(a.id)}/ocultar`, {}); return { ok: true };
    case "listar_publicaciones": return (await call("GET", "/api/posts")).posts.slice(0, Math.min(100, a.limite || 20)).map((p) => ({ id: p.id, estado: p.estado, texto: p.texto,
      programado_para: p.programado_para, archivos: p.media.length, destinos: p.destinos.map((d) => ({ red: d.red, cuenta: d.nombre, estado: d.estado, error: d.error, link: d.permalink })) }));
    case "crear_publicacion": {
      const media = [...(a.imagenes || []).map((u) => ({ url: u, tipo: "imagen" })), ...(a.videos || []).map((u) => ({ url: u, tipo: "video" }))];
      const d = await call("POST", "/api/posts", { texto: a.texto, cuentas: a.cuentas, accion: a.accion || "borrador", programado_para: a.programado_para, media, link: a.link, formato: a.formato });
      return { ok: true, id: d.id, accion: a.accion || "borrador" };
    }
    default: throw new Error("Herramienta desconocida: " + name);
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#0b0b14;color:#f2f2f8;display:grid;place-items:center;min-height:100vh;padding:16px}
main{max-width:420px;width:100%;background:#161626;border:1px solid #25253a;border-radius:20px;padding:26px}h1{font-size:21px;margin:0 0 10px}p{color:#c9c9dc}
label{display:block;font-size:13px;color:#a3a3bd;margin:12px 0 6px}input,select{width:100%;box-sizing:border-box;padding:11px;border-radius:10px;border:1px solid #25253a;background:#11111d;color:#fff;font-size:15px}
button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:11px;background:linear-gradient(120deg,#7c5cff,#22d3ee);color:#fff;font-weight:700;font-size:15px;cursor:pointer}.e{color:#f87171}</style></head>
<body><main><h1>✦ ${esc(title)}</h1>${body}</main></body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" } });
}
