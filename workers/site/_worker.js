/* Vortex Video — the site, served by Cloudflare Pages (vortex-video.pages.dev).
   The GitHub repo is the source of truth: files come from public/ at a pinned commit, so a deploy
   is atomic and a rollback is just pointing back at an older commit. The commit is the "ref" key
   in the CONFIG KV namespace (deploy = write a new SHA there), falling back to the REF variable.
   Extra routes:
   - /api/turn: short-lived Cloudflare TURN relay credentials (TURN_KEY_ID / TURN_KEY_TOKEN secrets)
   - /.well-known/assetlinks.json: links the Android app to this site (ANDROID_CERT_SHA256)
   - /download/android: the signed Android app (releases/vortex-video.apk at REF)
   - /api/ring: call alerts. Sends a Web Push to every device of the friend being rung (VAPID_PUBLIC /
     VAPID_PRIVATE_JWK secrets). The caller's own Supabase sign-in is used to look the devices up, so the
     database decides who may ring whom (vortex_push_targets: friends only, rate limited). */
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
    if (p === '/api/ring') return ring(req, env, ctx);
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

let refCache = { v: '', at: 0 };
async function currentRef(env) {
  if (Date.now() - refCache.at < 30000 && refCache.v) return refCache.v;
  let v = '';
  try { if (env.CONFIG) v = (await env.CONFIG.get('ref')) || ''; } catch { /* KV unavailable: use REF */ }
  v = /^[0-9a-f]{40}$/.test(v) ? v : String(env.REF || 'main');
  refCache = { v, at: Date.now() };
  return v;
}

async function file(env, ctx, repoPath, ext, headers) {
  const ref = await currentRef(env);
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

/* ---------------- call alerts (Web Push: RFC 8291 payload encryption + RFC 8292 VAPID) ---------------- */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ring(req, env, ctx) {
  const no = (msg, status) => Response.json({ error: msg }, { status, headers: { 'cache-control': 'no-store' } });
  if (req.method !== 'POST') return no('method', 405);
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return no('forbidden', 403);
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE_JWK || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return no('call alerts not configured', 503);
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt || jwt.length > 4000) return no('sign in first', 401);
  let b;
  try { b = await req.json(); } catch { return no('bad request', 400); }
  b = b && typeof b === 'object' ? b : {};
  const kind = b.kind === 'end' ? 'end' : b.kind === 'ring' ? 'ring' : '';
  if (!kind || !UUID.test(String(b.to || '')) || !/^[a-z0-9]{6,20}$/.test(String(b.id || ''))) return no('bad request', 400);
  const msg = { t: kind, id: b.id, at: Date.now() };
  if (kind === 'ring') {
    if (!/^VTX-[A-Z0-9]{4,24}$/.test(String(b.room || '')) || !/^[a-z0-9]{8,32}$/.test(String(b.tok || ''))) return no('bad request', 400);
    msg.room = b.room; msg.tok = b.tok;
  } else msg.reason = ['answered', 'declined', 'missed'].includes(b.reason) ? b.reason : 'missed';

  const rpc = (fn, args) => fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const r = await rpc('vortex_push_targets', { target: b.to });
  if (!r.ok) {
    let m = 'not allowed';
    try { m = (await r.json()).message || m; } catch { /* */ }
    return no(m, r.status === 401 ? 401 : r.status >= 500 ? 502 : 403);
  }
  const t = await r.json();
  msg.from = t.from; msg.name = String(t.name || 'A friend').slice(0, 40);
  const subs = Array.isArray(t.subs) ? t.subs.slice(0, 10) : [];
  const body = new TextEncoder().encode(JSON.stringify(msg));
  const results = await Promise.all(subs.map(async (s) => {
    try {
      const res = await webPush(env, s, body, { ttl: kind === 'ring' ? 45 : 600, topic: 'r' + b.id });
      if (res.status === 404 || res.status === 410) ctx.waitUntil(rpc('vortex_push_gone', { target: b.to, sub_endpoint: s.endpoint }).catch(() => {}));
      return res.ok;
    } catch { return false; }
  }));
  return Response.json({ devices: subs.length, sent: results.filter(Boolean).length }, { headers: { 'cache-control': 'no-store' } });
}

const b64u = {
  enc(buf) { let s = ''; for (const c of new Uint8Array(buf)) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
};
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const utf8 = (s) => new TextEncoder().encode(s);

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

/* aes128gcm content coding for one push message (RFC 8291 §3.4, single record) */
async function encryptPush(sub, plain) {
  const uaPublic = b64u.dec(sub.p256dh), authSecret = b64u.dec(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('bad subscription keys');
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(plain, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);                               // record size 4096
  return cat(salt, rs, new Uint8Array([65]), asPublic, ct);
}

let vapidKey = null;
async function vapidAuth(env, endpoint) {
  if (!vapidKey) vapidKey = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const u = new URL(endpoint);
  const head = b64u.enc(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.enc(utf8(JSON.stringify({ aud: u.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'https://vortex-video.pages.dev' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapidKey, utf8(head + '.' + claims));
  return `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${env.VAPID_PUBLIC}`;
}

async function webPush(env, sub, plain, { ttl, topic }) {
  if (!/^https:\/\//.test(String(sub.endpoint || ''))) throw new Error('bad endpoint');
  const body = await encryptPush(sub, plain);
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidAuth(env, sub.endpoint),
      'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
      ttl: String(ttl), urgency: 'high', topic,
    },
    body,
  });
}

