// Envía una respuesta por la red correcta y la registra. Lo usan el panel, Claude (MCP) y el agente.
import { uid, clip } from "./util.js";
import { metaReply } from "./meta.js";
import { googleReplyReview } from "./google.js";
import { encolarWhatsApp } from "./whatsapp.js";

export async function enviarRespuesta(env, msg, texto, { usuarioId = null, origen = "equipo" } = {}) {
  const cuenta = await env.DB.prepare("SELECT * FROM cuentas WHERE id=?").bind(msg.cuenta_id).first();
  if (!cuenta) throw new Error("La cuenta ya no existe");
  const rid = uid();
  texto = clip(texto, 4000);
  if (cuenta.red === "whatsapp") {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO respuestas (id, mensaje_id, usuario_id, texto, estado, origen) VALUES (?,?,?,?, 'en_cola', ?)").bind(rid, msg.id, usuarioId, texto, origen),
      env.DB.prepare("UPDATE mensajes SET respondido=1, estado='resuelto' WHERE id=?").bind(msg.id),
    ]);
    await encolarWhatsApp(env, cuenta, msg.hilo_id || msg.autor_id, texto, rid);
    return { id: rid, cola: true };
  }
  try {
    const ext = cuenta.red === "google" ? await googleReplyReview(env, cuenta, msg, texto) : await metaReply(env, cuenta, msg, texto);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO respuestas (id, mensaje_id, usuario_id, texto, estado, externo_id, origen) VALUES (?,?,?,?, 'enviada', ?, ?)").bind(rid, msg.id, usuarioId, texto, clip(ext, 300), origen),
      env.DB.prepare("UPDATE mensajes SET respondido=1, estado='resuelto' WHERE id=?").bind(msg.id),
    ]);
    return { id: rid };
  } catch (e) {
    await env.DB.prepare("INSERT INTO respuestas (id, mensaje_id, usuario_id, texto, estado, error, origen) VALUES (?,?,?,?, 'fallida', ?, ?)").bind(rid, msg.id, usuarioId, texto, clip(e.message, 300), origen).run();
    throw e;
  }
}
