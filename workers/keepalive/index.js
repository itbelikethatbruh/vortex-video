/* Vortex Video — Supabase keep-alive.
   Free Supabase projects pause after about a week without traffic, and while paused nobody
   can sign in or ring friends. This cron Worker makes a small API call every two days. */
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(ping(env)); },
  async fetch(req, env) { return Response.json(await ping(env)); },
};
async function ping(env) {
  const h = { apikey: env.SUPABASE_KEY };
  const out = {};
  for (const path of ['/auth/v1/health', '/rest/v1/profiles?select=id&limit=1']) {
    try { const r = await fetch(env.SUPABASE_URL + path, { headers: h }); out[path] = r.status; } catch (e) { out[path] = String(e); }
  }
  return out;
}
