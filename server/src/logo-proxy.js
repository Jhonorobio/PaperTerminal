/**
 * Photon image proxy — tpi.tradewithphoton.com blocks hotlinking (403 unless the
 * request carries `Referer: https://photon-sol.tinyastro.io/`, which an app's
 * <Image> can't set). The server fetches with the right Referer and re-serves,
 * with an in-memory cache: the URLs are stable per token, so each logo is fetched
 * from Photon once.
 *
 * Only that one host is allowed — this is not an open proxy.
 */

const ALLOWED_HOSTS = new Set(['tpi.tradewithphoton.com']);
const TTL_MS = 60 * 60_000; // token logos don't change
const MAX_ENTRIES = 600;

const HEADERS = {
  referer: 'https://photon-sol.tinyastro.io/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
};

const cache = new Map(); // url → { body: Buffer, contentType: string, at }

setInterval(() => {
  const now = Date.now();
  for (const [url, hit] of cache) {
    if (now - hit.at > TTL_MS) cache.delete(url);
  }
}, 10 * 60_000).unref();

/** GET /api/photon/logo?u=<encoded photon url> → the image bytes. */
export async function photonLogo(req, res) {
  const raw = req.query.u;
  let url;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    return res.status(400).json({ error: 'url inválida' });
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    return res.status(403).json({ error: 'host no permitido' });
  }

  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    res.setHeader('Content-Type', hit.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(hit.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const upstream = await fetch(key, { headers: HEADERS, signal: controller.signal });
    if (!upstream.ok) return res.status(upstream.status).json({ error: `upstream ${upstream.status}` });
    const body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || 'image/webp';
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { body, contentType, at: Date.now() });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(body);
  } catch (err) {
    const status = err instanceof Error && err.name === 'AbortError' ? 504 : 502;
    return res.status(status).json({ error: 'no se pudo traer la imagen' });
  } finally {
    clearTimeout(timer);
  }
}
