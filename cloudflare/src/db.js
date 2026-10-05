// Esquema de la base D1. Se crea solo en la primera petición (no hay que correr nada a mano).
import { MCP_SCHEMA } from "./mcp.js";
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS negocios (
     id TEXT PRIMARY KEY, nombre TEXT NOT NULL, activo INTEGER NOT NULL DEFAULT 1,
     creado TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS usuarios (
     id TEXT PRIMARY KEY, negocio_id TEXT, email TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL,
     rol TEXT NOT NULL CHECK (rol IN ('plataforma','dueno','equipo')),
     pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, activo INTEGER NOT NULL DEFAULT 1,
     creado TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS sesiones (token_hash TEXT PRIMARY KEY, usuario_id TEXT NOT NULL, expira INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS intentos (clave TEXT PRIMARY KEY, n INTEGER NOT NULL, desde INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cuentas (
     id TEXT PRIMARY KEY, negocio_id TEXT NOT NULL,
     red TEXT NOT NULL CHECK (red IN ('facebook','instagram','google')),
     externo_id TEXT NOT NULL, nombre TEXT, handle TEXT, avatar TEXT,
     token_enc TEXT, refresh_enc TEXT, token_expira INTEGER,
     page_id TEXT, extra TEXT NOT NULL DEFAULT '{}',
     estado TEXT NOT NULL DEFAULT 'conectada', error TEXT,
     sync_en INTEGER NOT NULL DEFAULT 0,
     creado TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (negocio_id, red, externo_id))`,
  `CREATE INDEX IF NOT EXISTS ix_cuentas_ext ON cuentas (red, externo_id)`,
  `CREATE TABLE IF NOT EXISTS posts (
     id TEXT PRIMARY KEY, negocio_id TEXT NOT NULL, autor_id TEXT,
     texto TEXT NOT NULL DEFAULT '', media TEXT NOT NULL DEFAULT '[]', link TEXT, formato TEXT NOT NULL DEFAULT 'post',
     programado_para TEXT, estado TEXT NOT NULL DEFAULT 'borrador',
     creado TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS ix_posts_neg ON posts (negocio_id, creado)`,
  `CREATE TABLE IF NOT EXISTS destinos (
     id TEXT PRIMARY KEY, post_id TEXT NOT NULL, cuenta_id TEXT NOT NULL,
     estado TEXT NOT NULL DEFAULT 'pendiente', externo_id TEXT, contenedor TEXT, permalink TEXT,
     intentos INTEGER NOT NULL DEFAULT 0, revisiones INTEGER NOT NULL DEFAULT 0, siguiente INTEGER NOT NULL DEFAULT 0,
     error TEXT, publicado_en TEXT, UNIQUE (post_id, cuenta_id))`,
  `CREATE INDEX IF NOT EXISTS ix_destinos_cola ON destinos (estado, siguiente)`,
  `CREATE TABLE IF NOT EXISTS mensajes (
     id TEXT PRIMARY KEY, negocio_id TEXT NOT NULL, cuenta_id TEXT NOT NULL,
     tipo TEXT NOT NULL CHECK (tipo IN ('dm','comentario','resena')),
     externo_id TEXT NOT NULL, hilo_id TEXT, autor_id TEXT, autor_nombre TEXT,
     texto TEXT NOT NULL DEFAULT '', calificacion INTEGER, permalink TEXT,
     recibido_en TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'nuevo',
     asignado_a TEXT, respondido INTEGER NOT NULL DEFAULT 0, extra TEXT NOT NULL DEFAULT '{}',
     UNIQUE (cuenta_id, externo_id))`,
  `CREATE INDEX IF NOT EXISTS ix_mensajes_neg ON mensajes (negocio_id, estado, recibido_en)`,
  `CREATE TABLE IF NOT EXISTS respuestas (
     id TEXT PRIMARY KEY, mensaje_id TEXT NOT NULL, usuario_id TEXT, texto TEXT NOT NULL,
     estado TEXT NOT NULL, error TEXT, externo_id TEXT,
     creado TEXT NOT NULL DEFAULT (datetime('now')))`,
];

SCHEMA.push(...MCP_SCHEMA);
let ready = false;
export async function ensureSchema(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  ready = true;
}

export const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
