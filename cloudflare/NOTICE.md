# Aviso de origen y licencia

ArtMMX Redes es una obra derivada de **BrightBean Studio**:
https://github.com/brightbeanxyz/brightbean-studio (commit 96ccc1e88fefa171c4e5ca981dc9f289bdf60d39).

Se distribuye bajo la misma licencia, la **GNU Affero General Public License v3.0**, que está en `../LICENSE`.

Qué se tomó de BrightBean Studio:
- **Lógica de publicación** y reintentos: `apps/publisher/engine.py`.
- **Proveedores de Meta**: `providers/facebook.py`, `instagram.py`, `meta_comments.py` y `meta_messaging.py`.
- **Google Business**: `providers/google_business.py`.
- **Modelo de bandeja**: `apps/inbox`.

Esa lógica se reescribió en JavaScript para Cloudflare Workers.

Qué se agregó en ArtMMX:
- Reseñas de Google Business: leerlas y responderlas.
- DMs de Instagram a través de la Página de Facebook.
- Ocultar comentarios.
- El motor adaptado a los límites del plan gratis de Cloudflare.

Como lo pide la AGPL, cualquier persona que use este servicio por red puede obtener el código fuente completo en:
https://github.com/youantonio/artmmx-redes
