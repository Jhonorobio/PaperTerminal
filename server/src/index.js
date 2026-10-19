/**
 * Paper Terminal feed server — FOMO + Track + push notifications.
 *
 * Runs on your PC (`npm run dev`) and on Railway (same code, volume at /data).
 * The app connects to /ws for live data and to these routes for filters,
 * notification settings and history. Prices/trading stay on the phone — this
 * server exists to keep the feeds alive 24/7 and to fire alerts.
 */
import 'dotenv/config';
import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';

import routes from './routes.js';
import { initWebSocket } from './ws.js';
import { closeFomoHttp, startFomoWatcher } from './fomo.js';
import { startFomoHolders } from './fomo-holders.js';
import { startTrackPoller } from './track.js';

const PORT = Number(process.env.PORT) || 8787;

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use('/api', routes);

app.use((err, _req, res, _next) => {
  const status = err?.status || 500;
  if (process.env.NODE_ENV !== 'production') console.error('[server]', err);
  res.status(status).json({ error: err?.message || 'Internal error' });
});

const server = createServer(app);
initWebSocket(server);

server.listen(PORT, () => {
  console.log(`Feed server on http://localhost:${PORT}`);
  console.log(`WebSocket on ws://localhost:${PORT}/ws`);
  console.log(`Data dir: ${process.env.DATA_DIR || 'data/'}`);
  if (process.env.RAILWAY_ENVIRONMENT && !process.env.DATA_DIR) {
    console.warn(
      '[warn] SIN VOLUMEN: Railway borra este disco en cada reinicio/deploy — los tokens, snapshots y configs del track se pierden. Montá un volumen en el servicio con mount path /data y seteá la variable DATA_DIR=/data.'
    );
  }
  startFomoHolders();
  startFomoWatcher();
  startTrackPoller();
});

// CycleTLS daemons must not keep the process alive on shutdown.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n[server] ${signal} — shutting down`);
    void closeFomoHttp();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
