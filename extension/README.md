# Paper Terminal — Monitor (extensión de Chrome)

Un panel lateral de escritorio para **mirar el Track** y para recibir las **mismas alertas**
que llegan al teléfono, como notificación de Chrome.

- **Sin cuenta**: no hay cartera, no hay posiciones, no hay órdenes. El trading sigue en la app.
- **Sin backend nuevo**: lee el mismo server (Railway) que usa el móvil.
- **Sin tableros de feeds**: FOMO **no** se pinta acá porque sus filtros se aplican
  localmente en el teléfono — un espejo en el navegador mostraría otros tokens. Lo que
  sí llega son sus **alertas**, configuradas por dispositivo.
- **Sin build step**: JavaScript plano y módulos ES; se carga tal cual está la carpeta.

## Instalar

1. `chrome://extensions` → activá **Modo de desarrollador**.
2. **Cargar descomprimida** → elegí la carpeta `extension/` de este repo.
3. Click en el ícono de la extensión → se abre el **panel lateral** (side panel).

Requiere Chrome 120+ (usa `chrome.sidePanel` y `chrome.alarms` con período de 1 minuto).

## Qué muestra

| Pestaña | De dónde sale |
| --- | --- |
| **Alertas** | `GET /api/notifications/history` + el push en vivo del topic `alerts:{deviceId}` |
| **Track** | topic `track`; el detalle de un token (tabla de snapshots) va por `GET /api/track/:address` |
| **Ajustes** | server, categorías de alerta, umbrales del Track y "Probar alerta" |

Click en una fila de **Track** → tabla de snapshots minuto a minuto del token (mcap, volumen,
holders, TP, bundle%, chat, tesis, TOP·D, CAL, salud y señal). Arriba de la tabla van las
**entradas CAL100**: una fila por wallet con callout ≥$100 que apareció *después* de que el
track empezara a mirar ese token, con el PnL de su portfolio (1d y 1w) leído en ese momento
— es el PnL de toda su cartera, no el de su posición en el token. Sólo se listan las que están
en ganancia en alguna ventana (la ventana en rojo no se pinta). Cada una de esas filas en verde
**también dispara el aviso `Track CAL100+`** (ver Alertas). También sale del server.
En **Alertas**, click → abre el token en GMGN (el panel no opera).

## Alertas

La extensión se registra en el server como un dispositivo más (`PUT /api/notifications/config`
con `push_token: null` — una extensión no puede tener token de Expo): el server la trata como
*panel-only* y le manda las alertas por su topic privado de WebSocket.

- El **service worker** mantiene ese WebSocket (con ping cada 20 s, que además mantiene vivo
  al worker) y convierte cada alerta en una **notificación de Chrome**.
- Como un worker MV3 puede dormirse, hay dos redes de seguridad: un `chrome.alarms` cada
  minuto que lo revive y `GET /api/notifications/history` para recuperar lo que llegó
  mientras estaba dormido. El dedupe es por `id` del historial del server.
- Click en la notificación → abre el panel en el token; si Chrome no deja abrir el panel sin
  gesto, cae a abrir GMGN en una pestaña.
- Los **umbrales del Track** (chat ≥ wallets, tesis ≥, TOP·D ≥) son por dispositivo y viven en
  el server, igual que en la app: podés tener el teléfono y el navegador con reglas distintas.
- La categoría de FOMO Trending está en Ajustes y avisa igual, aunque el panel no tenga
  su tablero.
- Las 2 de **FOMO HOLDER** miran los tokens **activos del Track** (no el feed de Trending):
  holder con ≥$100 comprados, con PnL de 24h positivo (`FOMO HOLDER 24H`) o perteneciente a
  un clan del top 50 de 24h/7d (`FOMO HOLDER TOP50`). Mientras el token siga activo se revisan
  cada minuto; avisan una sola vez por token+categoría, con un resumen de hasta 3 holders (una
  alerta por wallet serían cientos por minuto), y nacen OFF.

Las 3 categorías de entrada del Track se evalúan en el **snapshot de entrada** del token, una
vez por token, en el server. O sea: la extensión no calcula nada — solo muestra y avisa.

**`Track CAL100+` y las 3 de holder son la excepción**: no se evalúan en el snapshot (el PnL de
la wallet no está ahí, lo trae el barrido unos segundos después) y **no son una vez por token
sino por cada wallet**. CAL100+ avisa cada entrada con callout ≥$100 que queda en verde en 1d o
1w, sin piso de monto; es la más ruidosa (medido: ~28 avisos por hora de track) y nace ON.

Las 3 de **holder** miran **todos** los holders ≥$100 de `mint-positions`, tengan o no callout:
`Track HOLDER 1D/1W` (1d o 1w positivo), `Track HOLDER 1D+1W` (las dos positivas; categoría
aparte, así que con las dos ON llegan las dos) y `Track HOLDER TOP50` (al aparecer estaba en el
top 50 daily o weekly del board global de pump.fun — refresco cada 15 min, match por wallet o
`userId`). El PnL se pide **una sola vez por token+wallet** y el top 50 se evalúa **una sola
vez**: si la wallet entra al top después, no vuelve a avisar. Las tres nacen ON.

## Permisos

| Permiso | Para qué |
| --- | --- |
| `storage` | server, dispositivo, categorías, umbrales y el dedupe de alertas |
| `notifications` | el aviso de escritorio |
| `sidePanel` | el panel |
| `alarms` | revivir al worker y recuperar el historial |
| host `paperterminal-production.up.railway.app` | el server por defecto |

Si en **Ajustes** cambiás el server por otro origen (por ejemplo un server local), Chrome pide
permiso para ese origen: dale **Permitir acceso** y después **Guardar y reconectar**. Sin ese
permiso el `fetch` y el WebSocket fallan y el panel lo dice.

## Archivos

```
extension/
  manifest.json     MV3 · side panel · permisos
  background.js     service worker: WS de alertas + notificaciones de Chrome + fallback
  sidepanel.html    el marco (header, tabs, main)
  sidepanel.css     la paleta de la app (src/constants/paper.ts)
  sidepanel.js      el Track, la lista de alertas, el detalle y los ajustes
  shared.js         taxonomía de alertas, settings, API/WS y formateadores (worker + panel)
  icons/            los íconos (tomados de assets/images/icon.png de la app)
```

## Limitaciones conocidas

- El panel mantiene su **propia** conexión WebSocket para el Track (el worker tiene la de
  alertas): son dos sockets contra el server por navegador abierto.
- `chrome.sidePanel.open()` exige un gesto de usuario: el click en la notificación cuenta,
  pero si Chrome lo rechaza el click abre GMGN en una pestaña.
- Los íconos son el PNG de la app escalado por Chrome (no hay un set 16/48/128 propio).
