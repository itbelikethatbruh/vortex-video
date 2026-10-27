/* Vortex Video — Cloudflare Pages worker (advanced mode).
   Serves the static site, plus:
   - /api/turn: short-lived Cloudflare TURN relay credentials for calls on strict networks
     (secrets TURN_KEY_ID and TURN_KEY_TOKEN are set on the Pages project, never in the page)
   - /.well-known/assetlinks.json: links the Android app to this site (ANDROID_CERT_SHA256),
     so the app opens full screen without Chrome's address bar */
const PKG = 'dev.pages.vortex_video.twa';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/turn') return turn(req, env);
    if (url.pathname === '/.well-known/assetlinks.json') {
      const fps = String(env.ANDROID_CERT_SHA256 || '').split(',').map((s) => s.trim()).filter(Boolean);
      const body = fps.length ? [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: PKG, sha256_cert_fingerprints: fps } }] : [];
      return Response.json(body, { headers: { 'cache-control': 'public, max-age=300' } });
    }
    return env.ASSETS.fetch(req);
  },
};

async function turn(req, env) {
  const no = (msg, status) => Response.json({ error: msg }, { status, headers: { 'cache-control': 'no-store' } });
  if (req.method !== 'GET') return no('method', 405);
  // only the app's own pages ask for relay credentials
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return no('forbidden', 403);
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return no('relay not configured', 503);
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.TURN_KEY_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl: 6 * 3600 }),
  });
  if (!r.ok) return no('relay unavailable', 502);
  const j = await r.json();
  const list = [].concat(j.iceServers || []).map((s) => {
    // browsers refuse port 53; drop those addresses
    const urls = [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u));
    return urls.length ? Object.assign({}, s, { urls }) : null;
  }).filter(Boolean);
  return Response.json({ iceServers: list }, { headers: { 'cache-control': 'no-store' } });
}
