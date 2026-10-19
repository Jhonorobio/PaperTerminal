/**
 * Expo Push transport — ported from `server con APIS/src/services/push.js`.
 * Plain fetch against the Expo push service; no SDK needed on this side.
 */

const PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_ENDPOINT = 'https://exp.host/--/api/v2/push/getReceipts';
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;

function pushHeaders() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (EXPO_ACCESS_TOKEN) h['Authorization'] = `Bearer ${EXPO_ACCESS_TOKEN}`;
  return h;
}

/** Dirección corta (misma forma que la app: 5…4) para el cuerpo del push. */
function shortAddr(address) {
  const a = String(address ?? '');
  return a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a;
}

/**
 * Sends one push. `data` rides along for the app's deep links.
 *
 * Si `data.address` viene, el cuerpo arranca con la dirección del token: en pump.fun
 * el símbolo se repite entre tokens, así que la dirección es lo que identifica el
 * aviso en la notificación del sistema (en la app se ve completa en Alertas).
 * @returns {{ ticketId: string|null, result: object }}
 */
export async function sendPush(token, { title, body, data = {} }) {
  const addr = typeof data.address === 'string' ? shortAddr(data.address) : '';
  const finalBody = addr && body && !body.includes(addr) ? `Token ${addr} · ${body}` : body;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(PUSH_ENDPOINT, {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({ to: token, title, body: finalBody, data }),
      signal: controller.signal,
    });
    const result = await res.json();
    return { ticketId: result?.data?.id || null, result };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches the receipt for one ticket — a ticket only means Expo *accepted* the
 * message; the receipt is the real delivery verdict from FCM (where credential
 * and registration failures actually show up). Null while still generating.
 */
export async function getPushReceipt(ticketId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(RECEIPTS_ENDPOINT, {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({ ids: [ticketId] }),
      signal: controller.signal,
    });
    const json = await res.json();
    return json?.data?.[ticketId] ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Expo pushes tokens in two shapes: the classic ExponentPushToken[...] and the
 * newer ExponentPushToken(...) — accept both or the phone silently stays tokenless.
 */
export function isValidPushToken(token) {
  return typeof token === 'string' && /^ExponentPushToken[\[(][A-Za-z0-9_-]+[\])]$/.test(token);
}

/**
 * Checks push receipts and returns the device ids whose tokens are dead
 * (DeviceNotRegistered / InvalidCredentials) so the caller can drop them.
 */
export async function checkReceipts(ticketIds, ticketToDevice) {
  const invalidDevices = new Set();
  if (!ticketIds.length) return invalidDevices;
  for (let i = 0; i < ticketIds.length; i += 100) {
    const chunk = ticketIds.slice(i, i + 100);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(RECEIPTS_ENDPOINT, {
        method: 'POST',
        headers: pushHeaders(),
        body: JSON.stringify({ ids: chunk }),
        signal: controller.signal,
      });
      const receipts = await res.json();
      if (receipts?.data) {
        for (const [ticketId, receipt] of Object.entries(receipts.data)) {
          if (receipt?.status === 'error') {
            const err = receipt.details?.error;
            if (err === 'DeviceNotRegistered' || err === 'InvalidCredentials') {
              invalidDevices.add(ticketToDevice.get(ticketId));
            }
          }
        }
      }
    } catch {
      // receipt check failed — the next cycle retries
    } finally {
      clearTimeout(timer);
    }
  }
  return invalidDevices;
}
