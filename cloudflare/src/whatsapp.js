// WhatsApp por "puente" (QR). El puente es un programita que corre en una compu siempre prendida,
// mantiene la sesión de WhatsApp (como WhatsApp Web) y habla con este Worker:
//   POST /wa/estado    → QR, conectado/desconectado, número           (cada minuto y al cambiar)
//   POST /wa/entrante  → mensaje que llegó (o que el dueño escribió desde su teléfono)
//   GET  /wa/salida    → respuestas por enviar (del agente o del panel)
//   POST /wa/ack       → confirma si se envió
// Todo con "Authorization: Bearer <token del puente>".
import { json, err, uid, clip, sha256hex, randomToken, b64u, Budget } from "./util.js";

export const WA_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS wa_puentes (
     cuenta_id TEXT PRIMARY KEY, negocio_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
     estado TEXT NOT NULL DEFAULT 'esperando', qr TEXT, numero TEXT, version TEXT, ping INTEGER NOT NULL DEFAULT 0,
     creado TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS wa_salida (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, para TEXT NOT NULL, texto TEXT NOT NULL,
     respuesta_id TEXT, estado TEXT NOT NULL DEFAULT 'pendiente', intentos INTEGER NOT NULL DEFAULT 0,
     tomado INTEGER NOT NULL DEFAULT 0, error TEXT, creado INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ix_wa_salida ON wa_salida (cuenta_id, estado)`,
];

const enc = new TextEncoder();
const codigoDe = (origin, token) => b64u(enc.encode(JSON.stringify({ u: origin, t: token })));

export async function crearPuente(env, negocioId, nombre, origin) {
  const cuentaId = uid();
  const token = randomToken(32);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO cuentas (id, negocio_id, red, externo_id, nombre, handle, estado, error) VALUES (?,?, 'whatsapp', ?, ?, '', 'reconectar', 'Falta escanear el QR')")
      .bind(cuentaId, negocioId, "wa-" + cuentaId.slice(0, 8), clip(String(nombre || "WhatsApp").trim() || "WhatsApp", 80)),
    env.DB.prepare("INSERT INTO wa_puentes (cuenta_id, negocio_id, token_hash) VALUES (?,?,?)").bind(cuentaId, negocioId, await sha256hex(token)),
  ]);
  return { cuenta_id: cuentaId, codigo: codigoDe(origin, token) };
}

export async function nuevoCodigo(env, negocioId, cuentaId, origin) {
  const token = randomToken(32);
  await env.DB.prepare("UPDATE wa_puentes SET token_hash=? WHERE cuenta_id=? AND negocio_id=?").bind(await sha256hex(token), cuentaId, negocioId).run();
  const ok = await env.DB.prepare("SELECT cuenta_id FROM wa_puentes WHERE cuenta_id=? AND negocio_id=?").bind(cuentaId, negocioId).first();
  if (!ok) return null;
  return { cuenta_id: cuentaId, codigo: codigoDe(origin, token) };
}

export async function verPuente(env, negocioId, cuentaId) {
  const p = await env.DB.prepare("SELECT cuenta_id, estado, qr, numero, version, ping FROM wa_puentes WHERE cuenta_id=? AND negocio_id=?").bind(cuentaId, negocioId).first();
  if (!p) return null;
  const vivo = Date.now() - p.ping < 3 * 60e3;
  return { ...p, puente_en_linea: vivo, qr: vivo && p.estado === "qr" ? p.qr : null };
}

// Pone en cola un texto para que el puente lo envíe. Devuelve el id de la salida.
export async function encolarWhatsApp(env, cuenta, para, texto, respuestaId) {
  const id = uid();
  await env.DB.prepare("INSERT INTO wa_salida (id, cuenta_id, para, texto, respuesta_id, creado) VALUES (?,?,?,?,?,?)")
    .bind(id, cuenta.id, para, clip(texto, 4000), respuestaId || null, Date.now()).run();
  return id;
}

async function tomarSalida(env, cuentaId) {
  const t = Date.now();
  const filas = (await env.DB.prepare(`SELECT id, para, texto, intentos FROM wa_salida WHERE cuenta_id=? AND
      (estado='pendiente' OR (estado='enviando' AND tomado < ?)) ORDER BY creado LIMIT 10`).bind(cuentaId, t - 120e3).all()).results || [];
  const vivas = [];
  for (const f of filas) {
    if (f.intentos >= 3) {
      await env.DB.batch([
        env.DB.prepare("UPDATE wa_salida SET estado='fallida', error='El puente no confirmó el envío' WHERE id=?").bind(f.id),
        env.DB.prepare("UPDATE respuestas SET estado='fallida', error='WhatsApp no confirmó el envío' WHERE id=(SELECT respuesta_id FROM wa_salida WHERE id=?)").bind(f.id),
      ]);
      continue;
    }
    vivas.push(f);
  }
  if (vivas.length) await env.DB.batch(vivas.map((f) => env.DB.prepare("UPDATE wa_salida SET estado='enviando', tomado=?, intentos=intentos+1 WHERE id=?").bind(t, f.id)));
  return vivas.map(({ id, para, texto }) => ({ id, para, texto }));
}

const CHAT_OK = /^[\w.+:-]{3,80}@(s\.whatsapp\.net|lid|c\.us)$/;
const numeroDe = (jid) => (/@s\.whatsapp\.net$/.test(jid) ? "+" + jid.split("@")[0].split(":")[0] : "");

// hooks = { storeMessages, procesarMensaje, enviar, aprender, pausar, getAgente, aplica }
export async function rutaPuente(request, env, url, hooks) {
  const h = request.headers.get("Authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!tok) return err(401, "Falta el token del puente");
  const p = await env.DB.prepare("SELECT * FROM wa_puentes WHERE token_hash=?").bind(await sha256hex(tok)).first();
  if (!p) return err(401, "Código de conexión inválido. Genera uno nuevo en el panel → Cuentas → WhatsApp.");
  const cuenta = await env.DB.prepare("SELECT * FROM cuentas WHERE id=?").bind(p.cuenta_id).first();
  if (!cuenta) return err(410, "Esta conexión de WhatsApp se borró del panel");
  const path = url.pathname.replace(/\/+$/, "");
  const m = request.method;
  const b = m === "POST" ? await request.json().catch(() => ({})) : {};
  await env.DB.prepare("UPDATE wa_puentes SET ping=? WHERE cuenta_id=?").bind(Date.now(), p.cuenta_id).run();

  if (path === "/wa/estado" && m === "POST") {
    const estado = ["qr", "conectado", "desconectado", "iniciando"].includes(b.estado) ? b.estado : "iniciando";
    const qr = estado === "qr" && typeof b.qr === "string" && /^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(b.qr) && b.qr.length < 60000 ? b.qr : null;
    const numero = clip(String(b.numero || "").replace(/[^\d+]/g, ""), 20);
    await env.DB.batch([
      env.DB.prepare("UPDATE wa_puentes SET estado=?, qr=?, numero=COALESCE(NULLIF(?,''), numero), version=? WHERE cuenta_id=?").bind(estado, qr, numero, clip(b.version || "", 30), p.cuenta_id),
      estado === "conectado"
        ? env.DB.prepare("UPDATE cuentas SET estado='conectada', error=NULL, handle=COALESCE(NULLIF(?,''), handle) WHERE id=?").bind(numero, cuenta.id)
        : env.DB.prepare("UPDATE cuentas SET estado='reconectar', error=? WHERE id=?").bind(estado === "qr" ? "Escanea el QR en el panel → Cuentas" : "WhatsApp desconectado: abre el puente", cuenta.id),
    ]);
    return json({ ok: true, intervalo: 5 });
  }

  if (path === "/wa/entrante" && m === "POST") {
    const chat = String(b.chat || "");
    if (!CHAT_OK.test(chat)) return json({ ok: true, ignorado: "chat no individual" });
    const extId = clip(String(b.id || ""), 120);
    if (!extId) return err(400, "Falta id");
    const texto = clip(String(b.texto || "").trim() || (b.media ? `(${b.media})` : ""), 4000);
    const cuando = Number.isFinite(+b.ts) && +b.ts > 0 ? new Date(+b.ts * 1000).toISOString() : new Date().toISOString();

    if (b.de_mi) {
      // El dueño contestó desde su teléfono: lo registramos, pausamos al agente en ese chat y aprendemos.
      const ultimo = await env.DB.prepare("SELECT id, texto FROM mensajes WHERE cuenta_id=? AND hilo_id=? AND tipo='dm' ORDER BY recibido_en DESC LIMIT 1").bind(cuenta.id, chat).first();
      if (!ultimo || !texto) return json({ ok: true });
      const dup = await env.DB.prepare("SELECT id FROM respuestas WHERE externo_id=?").bind(extId).first();
      if (dup) return json({ ok: true });
      const sug = await env.DB.prepare("SELECT texto FROM sugerencias WHERE mensaje_id=?").bind(ultimo.id).first();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO respuestas (id, mensaje_id, usuario_id, texto, estado, externo_id, origen) VALUES (?,?,NULL,?, 'enviada', ?, 'telefono')").bind(uid(), ultimo.id, texto, extId),
        env.DB.prepare("UPDATE mensajes SET respondido=1, estado='resuelto' WHERE id=?").bind(ultimo.id),
        env.DB.prepare("UPDATE sugerencias SET estado='descartada' WHERE mensaje_id=? AND estado IN ('pendiente','humano')").bind(ultimo.id),
      ]);
      const ag = await hooks.getAgente(env, cuenta.negocio_id);
      if (ag.modo !== "apagado") await hooks.pausar(env, cuenta.id, chat, ag.pausa_horas, "Contestaste desde el teléfono");
      await hooks.aprender(env, cuenta.negocio_id, ultimo.texto, texto, { sugerida: sug?.texto || "", mensajeId: ultimo.id });
      return json({ ok: true });
    }

    const nombre = clip(String(b.nombre || "").trim(), 120) || numeroDe(chat) || "Contacto de WhatsApp";
    const { nuevos } = await hooks.storeMessages(env, cuenta, [{ tipo: "dm", externo_id: extId, hilo_id: chat, autor_id: chat, autor_nombre: nombre, texto, permalink: "",
      recibido_en: cuando, extra: { telefono: numeroDe(chat), media: b.media || null } }], { sinCola: true });
    let accion = null;
    if (nuevos.length && hooks.aplica(await hooks.getAgente(env, cuenta.negocio_id), "whatsapp", { tipo: "dm", recibido_en: cuando })) {
      const r = await hooks.procesarMensaje(env, nuevos[0], { enviar: hooks.enviar, budget: new Budget(10) });
      accion = r.accion;
    }
    return json({ ok: true, accion, salida: await tomarSalida(env, cuenta.id) });
  }

  if (path === "/wa/salida" && m === "GET") return json({ salida: await tomarSalida(env, cuenta.id) });

  if (path === "/wa/ack" && m === "POST") {
    const s = await env.DB.prepare("SELECT * FROM wa_salida WHERE id=? AND cuenta_id=?").bind(String(b.id || ""), cuenta.id).first();
    if (!s) return err(404, "No existe");
    if (b.ok) await env.DB.batch([
      env.DB.prepare("UPDATE wa_salida SET estado='enviada', error=NULL WHERE id=?").bind(s.id),
      env.DB.prepare("UPDATE respuestas SET estado='enviada', externo_id=? WHERE id=?").bind(clip(b.externo_id || "", 120), s.respuesta_id),
    ]);
    else await env.DB.batch([
      env.DB.prepare("UPDATE wa_salida SET estado='fallida', error=? WHERE id=?").bind(clip(b.error || "error", 300), s.id),
      env.DB.prepare("UPDATE respuestas SET estado='fallida', error=? WHERE id=?").bind("WhatsApp: " + clip(b.error || "error", 280), s.respuesta_id),
    ]);
    return json({ ok: true });
  }
  return err(404, "No encontrado");
}
