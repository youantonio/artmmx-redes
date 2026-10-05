// Motor que corre cada minuto (Cron Trigger): publica lo programado y sincroniza la bandeja.
// Diseñado para el plan gratis: máximo ~45 llamadas externas por minuto y pasos cortos.
// Referencia de lógica: BrightBean Studio apps/publisher/engine.py y apps/inbox/tasks.py.
import { Budget, clip, uid } from "./util.js";
import { parse } from "./db.js";
import { metaPublish, metaFetchInbox, metaConfigured } from "./meta.js";
import { googlePublish, googleFetchReviews, googleConfigured } from "./google.js";

const BACKOFF_MS = [60e3, 5 * 60e3, 30 * 60e3]; // 1, 5 y 30 minutos (como BrightBean)
const MAX_INTENTOS = 3;
const SYNC_CADA = { facebook: 15 * 60e3, instagram: 15 * 60e3, google: 30 * 60e3 }; // los webhooks traen lo urgente

export async function runCron(env) {
  const budget = new Budget(45);
  const res = { publicados: 0, pendientes: 0, fallidos: 0, sincronizadas: 0, mensajes: 0 };
  await publishDue(env, budget, res);
  await syncInbox(env, budget, res);
  return res;
}

// ---------------- PUBLICAR ----------------
export async function publishDue(env, budget, res = {}) {
  const nowIso = new Date().toISOString();
  const rows = (await env.DB.prepare(
    `SELECT d.*, p.texto, p.media, p.link, p.formato, p.negocio_id AS p_negocio,
            c.red, c.externo_id AS c_ext, c.page_id, c.handle, c.token_enc, c.refresh_enc, c.token_expira, c.estado AS c_estado
       FROM destinos d JOIN posts p ON p.id = d.post_id JOIN cuentas c ON c.id = d.cuenta_id
      WHERE d.estado IN ('pendiente','procesando') AND p.estado IN ('programado','publicando')
        AND p.programado_para <= ? AND d.siguiente <= ?
      ORDER BY p.programado_para LIMIT 8`
  ).bind(nowIso, Date.now()).all()).results || [];

  const tocados = new Set();
  for (const r of rows) {
    if (budget.left < 4) break;
    tocados.add(r.post_id);
    const cuenta = { id: r.cuenta_id, red: r.red, externo_id: r.c_ext, page_id: r.page_id, handle: r.handle, token_enc: r.token_enc, refresh_enc: r.refresh_enc, token_expira: r.token_expira };
    const post = { texto: r.texto, media: parse(r.media, []), link: r.link, formato: r.formato };
    await env.DB.prepare("UPDATE posts SET estado='publicando' WHERE id=? AND estado='programado'").bind(r.post_id).run();
    try {
      if (r.c_estado !== "conectada") throw Object.assign(new Error("La cuenta está desconectada; vuelve a conectarla"), { permanente: true });
      let out;
      if (r.red === "google") {
        if (!googleConfigured(env)) throw Object.assign(new Error("Falta configurar Google (GOOGLE_CLIENT_ID/SECRET)"), { permanente: true });
        out = await googlePublish(env, cuenta, post, budget);
      } else {
        if (!metaConfigured(env)) throw Object.assign(new Error("Falta configurar Meta (META_APP_ID/SECRET)"), { permanente: true });
        out = await metaPublish(env, cuenta, post, r, budget);
      }
      if (out.hecho) {
        await env.DB.prepare("UPDATE destinos SET estado='publicado', externo_id=?, permalink=?, error=NULL, publicado_en=? WHERE id=?")
          .bind(clip(out.externo_id, 200), out.permalink || null, new Date().toISOString(), r.id).run();
        res.publicados = (res.publicados || 0) + 1;
      } else {
        // Instagram sigue procesando el archivo: se revisa otra vez en 30 s (máximo ~30 min = 60 revisiones)
        const revisiones = r.contenedor === out.pendiente ? r.revisiones + 1 : 0;
        if (revisiones > 60) throw Object.assign(new Error("Instagram tardó demasiado en procesar el archivo"), { permanente: true });
        await env.DB.prepare("UPDATE destinos SET estado='procesando', contenedor=?, siguiente=?, revisiones=? WHERE id=?")
          .bind(out.pendiente, Date.now() + 30e3, revisiones, r.id).run();
        res.pendientes = (res.pendientes || 0) + 1;
      }
    } catch (e) {
      if (e.budget) break;
      const intentos = r.intentos + 1;
      const auth = e.status === 401 || e.code === 190;
      const permanente = e.permanente || auth || (e.status >= 400 && e.status < 500 && e.status !== 429 && e.code !== 2 && e.code !== 4 && e.code !== 17);
      const msg = friendly(e);
      if (auth) await env.DB.prepare("UPDATE cuentas SET estado='reconectar', error=? WHERE id=?").bind(msg, r.cuenta_id).run();
      if (permanente || intentos >= MAX_INTENTOS) {
        await env.DB.prepare("UPDATE destinos SET estado='fallido', error=?, intentos=? WHERE id=?").bind(msg, intentos, r.id).run();
        res.fallidos = (res.fallidos || 0) + 1;
      } else {
        await env.DB.prepare("UPDATE destinos SET estado='pendiente', contenedor=NULL, error=?, intentos=?, siguiente=? WHERE id=?")
          .bind(msg, intentos, Date.now() + BACKOFF_MS[intentos - 1], r.id).run();
      }
    }
  }
  for (const id of tocados) await refreshPostState(env, id);
  return res;
}

export async function refreshPostState(env, postId) {
  const ds = (await env.DB.prepare("SELECT estado FROM destinos WHERE post_id=?").bind(postId).all()).results || [];
  if (!ds.length) return;
  const n = (s) => ds.filter((d) => d.estado === s).length;
  let estado = "publicando";
  if (n("publicado") === ds.length) estado = "publicado";
  else if (n("pendiente") + n("procesando") === 0) estado = n("publicado") ? "parcial" : "fallido";
  await env.DB.prepare("UPDATE posts SET estado=? WHERE id=? AND estado IN ('programado','publicando')").bind(estado, postId).run();
}

function friendly(e) {
  const m = String(e.message || e);
  if (e.status === 401 || e.code === 190) return "El permiso de la cuenta venció o fue retirado. Vuelve a conectarla.";
  if (e.status === 429 || e.code === 4 || e.code === 17 || e.code === 32) return "La red social pidió esperar (límite de uso). Se reintenta solo.";
  if (/permission|permiso|\(#10\)|\(#200\)/i.test(m)) return "Falta un permiso en la app de Meta/Google: " + clip(m, 160);
  return clip(m, 300);
}

// ---------------- BANDEJA ----------------
export async function syncInbox(env, budget, res = {}) {
  const ahora = Date.now();
  const cands = (await env.DB.prepare(
    "SELECT * FROM cuentas WHERE estado='conectada' ORDER BY sync_en LIMIT 6"
  ).all()).results || [];
  for (const c of cands) {
    if (budget.left < 4) break;
    if (ahora - (c.sync_en || 0) < (SYNC_CADA[c.red] || 15 * 60e3)) continue;
    if (c.red === "google" ? !googleConfigured(env) : !metaConfigured(env)) continue;
    await env.DB.prepare("UPDATE cuentas SET sync_en=? WHERE id=?").bind(ahora, c.id).run();
    try {
      const msgs = c.red === "google" ? await googleFetchReviews(env, c, budget) : await metaFetchInbox(env, c, budget);
      res.mensajes = (res.mensajes || 0) + (await storeMessages(env, c, msgs));
      res.sincronizadas = (res.sincronizadas || 0) + 1;
      if (c.error) await env.DB.prepare("UPDATE cuentas SET error=NULL WHERE id=?").bind(c.id).run();
    } catch (e) {
      if (e.budget) break;
      const auth = e.status === 401 || e.code === 190;
      await env.DB.prepare("UPDATE cuentas SET error=?, estado=? WHERE id=?").bind("Bandeja: " + friendly(e), auth ? "reconectar" : "conectada", c.id).run();
    }
  }
  return res;
}

// Guarda mensajes sin duplicar (misma cuenta + mismo id externo). Devuelve cuántos son nuevos.
export async function storeMessages(env, cuenta, msgs) {
  if (!msgs.length) return 0;
  const antes = await env.DB.prepare("SELECT COUNT(*) AS n FROM mensajes WHERE cuenta_id=?").bind(cuenta.id).first();
  const stmts = msgs.map((m) => env.DB.prepare(
    `INSERT INTO mensajes (id, negocio_id, cuenta_id, tipo, externo_id, hilo_id, autor_id, autor_nombre, texto, calificacion, permalink, recibido_en, respondido, extra, estado)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, CASE WHEN ?=1 THEN 'resuelto' ELSE 'nuevo' END)
     ON CONFLICT(cuenta_id, externo_id) DO UPDATE SET
       texto=excluded.texto,
       autor_nombre=CASE WHEN mensajes.autor_nombre IN ('Contacto','') THEN excluded.autor_nombre ELSE mensajes.autor_nombre END,
       calificacion=COALESCE(excluded.calificacion, mensajes.calificacion),
       permalink=COALESCE(NULLIF(excluded.permalink,''), mensajes.permalink),
       respondido=MAX(mensajes.respondido, excluded.respondido),
       extra=CASE WHEN mensajes.tipo='resena' THEN excluded.extra ELSE mensajes.extra END`
  ).bind(uid(), cuenta.negocio_id, cuenta.id, m.tipo, clip(m.externo_id, 300), clip(m.hilo_id, 300), clip(m.autor_id, 100), clip(m.autor_nombre, 120),
    clip(m.texto, 4000), m.calificacion ?? null, clip(m.permalink, 500), m.recibido_en, m.respondido ? 1 : 0, JSON.stringify(m.extra || {}), m.respondido ? 1 : 0));
  await env.DB.batch(stmts);
  const despues = await env.DB.prepare("SELECT COUNT(*) AS n FROM mensajes WHERE cuenta_id=?").bind(cuenta.id).first();
  return despues.n - antes.n;
}
