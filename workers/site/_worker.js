/* Vortex Video — the site, served by Cloudflare Pages (vortex-video.pages.dev).
   The GitHub repo is the source of truth: files come from public/ at a pinned commit (REF),
   so a deploy is atomic and a rollback is just pointing REF at an older commit.
   Extra routes:
   - /api/turn: short-lived Cloudflare TURN relay credentials (TURN_KEY_ID / TURN_KEY_TOKEN secrets)
   - /.well-known/assetlinks.json: links the Android app to this site (ANDROID_CERT_SHA256)
   - /download/android: the signed Android app (releases/vortex-video.apk at REF) */
const REPO = 'itbelikethatbruh/vortex-video';
const PKG = 'dev.pages.vortex_video.twa';
const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', webmanifest: 'application/manifest+json', png: 'image/png', svg: 'image/svg+xml',
  ico: 'image/x-icon', txt: 'text/plain; charset=utf-8', apk: 'application/vnd.android.package-archive',
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === '/api/turn') return turn(req, env);
    if (p === '/.well-known/assetlinks.json') {
      const fps = String(env.ANDROID_CERT_SHA256 || '').split(',').map((s) => s.trim()).filter(Boolean);
      const body = fps.length ? [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: PKG, sha256_cert_fingerprints: fps } }] : [];
      return Response.json(body, { headers: { 'cache-control': 'public, max-age=300' } });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    if (p === '/download/android' || p === '/vortex-video.apk') {
      return file(env, ctx, 'releases/vortex-video.apk', 'apk', { 'content-disposition': 'attachment; filename="vortex-video.apk"', 'cache-control': 'no-cache' });
    }
    let path = p === '/' || p === '/index.html' ? '/index.html' : p;
    if (!/^\/[A-Za-z0-9._\/-]{1,200}$/.test(path) || path.includes('..')) return new Response('Not found', { status: 404 });
    const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1];
    if (!ext || !TYPES[ext.toLowerCase()]) path = '/index.html';           // app routes fall back to the app
    const e = (path.match(/\.([a-z0-9]+)$/i) || [])[1].toLowerCase();
    const fresh = e === 'html' || path === '/sw.js' || e === 'webmanifest';
    return file(env, ctx, 'public' + path, e, { 'cache-control': fresh ? 'no-cache' : 'public, max-age=86400' });
  },
};

async function file(env, ctx, repoPath, ext, headers) {
  const ref = String(env.REF || 'main');
  const src = `https://raw.githubusercontent.com/${REPO}/${ref}/${repoPath}`;
  const cache = caches.default, key = new Request(src);
  let r = await cache.match(key);
  if (!r) {
    const up = await fetch(src, { cf: { cacheTtl: /^[0-9a-f]{40}$/.test(ref) ? 86400 : 60, cacheEverything: true } });
    if (!up.ok) return new Response(up.status === 404 ? 'Not found' : 'Upstream error', { status: up.status === 404 ? 404 : 502 });
    r = new Response(up.body, up);
    if (/^[0-9a-f]{40}$/.test(ref)) { r.headers.set('cache-control', 'public, max-age=86400'); ctx.waitUntil(cache.put(key, r.clone())); }
  }
  const h = new Headers({ 'content-type': TYPES[ext] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' });
  for (const [k, v] of Object.entries(headers || {})) h.set(k, v);
  return new Response(r.body, { status: 200, headers: h });
}

async function turn(req, env) {
  const no = (msg, status) => Response.json({ error: msg }, { status, headers: { 'cache-control': 'no-store' } });
  if (req.method !== 'GET') return no('method', 405);
  const site = req.headers.get('sec-fetch-site');                     // only the app's own pages
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
    const urls = [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u));   // browsers refuse port 53
    return urls.length ? Object.assign({}, s, { urls }) : null;
  }).filter(Boolean);
  return Response.json({ iceServers: list }, { headers: { 'cache-control': 'no-store' } });
}
