# ArtMMX Redes · versión 1 (Cloudflare gratis)

Bandeja única de **DMs de Instagram y Messenger, comentarios y reseñas de Google**, más **publicaciones programadas** para Facebook, Instagram y Google Business. Funciona completo en el **plan gratis de Cloudflare**: Workers + D1 + R2 + Cron Triggers.

Está basado en [BrightBean Studio](https://github.com/brightbeanxyz/brightbean-studio), que es AGPL-3.0. El núcleo de Django se reescribió en JavaScript para Workers. Ver `NOTICE.md`.

## Qué incluye la v1

| Función | Facebook | Instagram | Google Business |
|---|---|---|---|
| Conectar con 1 clic (OAuth) | ✅ | ✅ (viene con la Página) | ✅ |
| Publicar ahora o programado | Texto, link, 1–10 fotos, video | Foto, reel, carrusel (2–10), historia | Post con foto y botón |
| Bandeja: DMs | ✅ Messenger | ✅ Instagram Direct | — |
| Bandeja: comentarios | Responder y ocultar | Responder y ocultar | — |
| Bandeja: reseñas | — | — | ⭐ Leer y responder |
| Webhooks en tiempo real | ✅ | ✅ | (revisión cada 30 min) |

Además trae:
- Varios negocios (clientes), cada uno con su equipo. Roles: plataforma, dueño y equipo.
- Reintentos automáticos: a 1, 5 y 30 minutos.
- Tokens cifrados con AES-256-GCM.
- Página de inicio, aviso de privacidad y página de eliminación de datos (Meta las pide para aprobar la app).

Pendiente para la v2: **YouTube y TikTok**. Threads, Bluesky, LinkedIn, Pinterest y Mastodon quedaron fuera por decisión.

## Conector para Claude (MCP)

En Claude → Configuración → Conectores → *Agregar conector personalizado* → `https://TU-WORKER/mcp`. Claude te manda a una pantalla de ArtMMX Redes donde entras con tu correo; si eres administrador de la plataforma, ahí eliges el negocio.

Herramientas que expone: `resumen`, `listar_cuentas`, `listar_mensajes`, `ver_mensaje`, `responder_mensaje`, `cambiar_estado_mensaje`, `ocultar_comentario`, `listar_publicaciones` y `crear_publicacion`. Claude tiene exactamente los mismos permisos que el usuario que lo autorizó.

Seguridad: OAuth 2.1 con registro dinámico de clientes y PKCE S256. El token de acceso dura 30 días y el refresh rota en cada renovación.

## Límites del plan gratis y cómo se respetan

- **50 llamadas externas por ejecución.** El motor usa máximo 45 por minuto.
- **Instagram procesa los videos en varios pasos.** Se crea el contenedor y se revisa cada minuto hasta que termina, sin bloquear el Worker.
- **Archivos de hasta 95 MB por subida.** El plan gratis acepta 100 MB por petición.
- **Revisión de la bandeja.** Meta cada 15 min por cuenta, como respaldo de los webhooks. Google cada 30 min.

## Instalación

1. **Base de datos.** En Cloudflare → D1 → *Create* → nombre `artmmx-redes-db`. Copia el ID y pégalo en `wrangler.toml`.
2. **Almacenamiento de archivos.** En Cloudflare → R2 → *Create bucket* → `artmmx-redes-media`.
3. **Worker.** En Workers & Pages → *Create* → *Import a repository* → `youantonio/artmmx-redes`:
   - Directorio raíz: `cloudflare`
   - Comando de despliegue: `npx wrangler deploy`
4. **Primer administrador.** Abre `https://artmmx-redes.<tu-subdominio>.workers.dev/panel/`.
   - Te pide un **código de instalación**. Está en D1 → `artmmx-redes-db` → tabla `config` → `codigo_instalacion`.
5. **Secretos.** Se ponen en Worker → *Settings* → *Variables and secrets* cuando tengas las apps:
   - `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN` (una frase que tú inventes)
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `SECRET_KEY`: opcional. Si no la pones, se genera sola y se guarda en D1.

## App de Meta (Facebook + Instagram + DMs)

1. Crea la app en developers.facebook.com, tipo **Business**. Agrega los productos *Facebook Login for Business*, *Messenger* e *Instagram*.
2. **URL de redirección OAuth:** `https://TU-WORKER/auth/meta/callback`
3. **Webhooks:**
   - URL: `https://TU-WORKER/webhooks/meta`. El token de verificación es igual a `META_VERIFY_TOKEN`.
   - Objeto **Page**: campos `feed` y `messages`.
   - Objeto **Instagram**: campos `comments` y `messages`.
4. **Política de privacidad:** `https://TU-WORKER/privacidad.html`. **Eliminación de datos:** `https://TU-WORKER/eliminar-datos.html`.
5. **Permisos que hay que pedir en App Review:** `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_engagement`, `pages_read_user_content`, `pages_manage_metadata`, `pages_messaging`, `business_management`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_messages`.
   - Mientras no estén aprobados, solo funcionan con cuentas que tengan rol en la app (administradores o testers).

## App de Google (Business Profile + reseñas)

1. En Google Cloud, crea un proyecto y activa estas APIs:
   - *My Business Account Management*
   - *My Business Business Information*
   - *Google My Business API* (la v4, que es la de reseñas y posts)
2. **Pide acceso a la Business Profile API** con el formulario de Google. Sin esa aprobación la cuota es 0 y aparece error 429 o 403.
3. Crea credenciales OAuth tipo *Web*. Redirección: `https://TU-WORKER/auth/google/callback`.

## Pruebas

```
node test/test.mjs          # 91 pruebas (incluye el conector de Claude): instalación, permisos, OAuth, publicar, reintentos, bandeja, webhooks, reseñas
node test/dev-server.mjs    # panel local en http://localhost:8787 con redes simuladas
```
