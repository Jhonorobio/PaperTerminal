# Paper Terminal — Monitor (extensión de Chrome)

Un panel lateral de escritorio para **mirar** lo que el server de la app ya sirve, y para
recibir las **mismas alertas** que llegan al teléfono, como notificación de Chrome.

- **Sin cuenta**: no hay cartera, no hay posiciones, no hay órdenes. El trading sigue en la app.
- **Sin backend nuevo**: lee el mismo server (Railway) que usa el móvil — FOMO, Photon, el
  tracker y el board Pump Trend. — por HTTP + WebSocket.
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
| **FOMO** | topics `fomo` (Graduados) y `fomo_trending` |
| **Photon** | topic `memescope` (columnas New y Graduated, tal cual las sirve el server) |
| **Track** | topic `track`; el detalle de un token (tabla de snapshots) va por `GET /api/track/:address` |
| **Pump** | topic `pump_trending` (top 5 del board) |
| **Ajustes** | server, categorías, umbrales y "Probar alerta" |

Click en una fila → abre el token en GMGN (el panel no opera). En **Track**, click abre la
tabla de snapshots minuto a minuto del token (mcap, volumen, holders, TP, bundle%, chat,
tesis, TOP·D, CAL, salud y señal).

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

Las categorías del Track se evalúan en el **snapshot de entrada** del token, una vez por
token, en el server. O sea: la extensión no calcula nada — solo muestra y avisa.

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
  sidepanel.js      los tableros, la lista de alertas y el detalle del Track
  shared.js         taxonomía de alertas, settings, API/WS y formateadores (worker + panel)
  icons/            los íconos (tomados de assets/images/icon.png de la app)
```

## Limitaciones conocidas

- El panel mantiene su **propia** conexión WebSocket para los tableros (el worker tiene la de
  alertas): son dos sockets contra el server por navegador abierto.
- `chrome.sidePanel.open()` exige un gesto de usuario: el click en la notificación cuenta,
  pero si Chrome lo rechaza el click abre GMGN en una pestaña.
- Los íconos son el PNG de la app escalado por Chrome (no hay un set 16/48/128 propio).
