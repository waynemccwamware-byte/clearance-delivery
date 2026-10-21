// netlify/functions/ffsync.js  (Clearance Delivery Trainer v0.26)
//
// Keeps the ForeFlight routes a pilot brought back through Claude, and their last route pick, under a sync code,
// so every browser context on a device sees them. Needed on iPhone: Claude's fill-in link opens in the Claude
// app's own browser, whose storage is separate from the home-screen Control Panel's (found 20-Oct-2026).
//
//   GET  ?k=CODE&pairs=KSBA-KSQL[,…up to 6]  -> { pairs:{ "KSBA-KSQL": {routes, at, ac, ts} }, sel:{pair, custom, r, id, my, alt, ts} | null }
//   POST { k, pair, entry }                   -> stores that pair's routes
//   POST { k, sel }                           -> stores the latest route pick
//
// v0.26: every item has its own blob key and is written with one PUT, never read-modify-write. v0.25 kept one
// record per code and merged into it; Netlify Blobs reads can be stale for a short while after a write
// (eventual consistency), so a pick saved seconds after the routes read the old, empty record and wrote it
// back, wiping the routes. Reads also prefer the uncached edge URL when the function context provides one.
//
// The code (12 characters, no 0/O/1/I/L, as in Schedule's sync) is made by the app on each device and handed to
// Claude in the request; Claude puts it back in the link (k=). Nothing else identifies the pilot.
// Dependency-free on purpose: Netlify Blobs via the same edge protocol as nasr-freq.js / Schedule's sync.js.

const STORE_NAME = 'clearance-delivery-ffsync';
const CODE_RE = /^[A-HJKMNP-Z2-9]{12}$/;
const PAIR_RE = /^[A-Z0-9]{2,7}-[A-Z0-9]{2,7}$/;

function getBlobsAuth(event) {
  if (!event || !event.blobs || !event.headers) return {};
  try {
    const data = JSON.parse(Buffer.from(event.blobs, 'base64').toString('utf8'));
    return { siteID: event.headers['x-nf-site-id'], token: data.token, edgeURL: data.url,
             readURL: data.url_uncached || data.uncachedEdgeURL || data.uncached_url || data.url };
  } catch (err) { return {}; }
}
async function blobsRequest(method, auth, key, body) {
  const base = method === 'get' ? auth.readURL : auth.edgeURL;
  const url = new URL(`/${auth.siteID}/${STORE_NAME}/${encodeURIComponent(key)}`, base).toString();
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${auth.token}`, ...(body ? { 'content-type': 'text/plain' } : {}) },
    body,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Blobs ${method.toUpperCase()} failed (HTTP ${res.status})`);
  return method === 'get' ? res.text() : null;
}
const pairKey = (k, pair) => `${k}~p~${pair}`;
const selKey = k => `${k}~sel`;

const str = (v, n) => String(v == null ? '' : v).slice(0, n);
function cleanEntry(e) {
  if (!e || !Array.isArray(e.routes)) return null;
  const routes = e.routes.slice(0, 40).map(x => ({
    r: str(x.r, 200).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(),
    t: str(x.t, 1).toUpperCase(), n: str(x.n, 8), d: str(x.d, 12),
    lo: Math.max(0, Math.min(60000, +x.lo || 0)), hi: Math.max(0, Math.min(60000, +x.hi || 0)),
    eng: str(x.eng, 3).toUpperCase().replace(/[^PTJ]/g, ''),
  })).filter(x => x.r);
  return routes.length ? { routes, at: str(e.at, 12), ac: str(e.ac, 40), ts: +e.ts || Date.now() } : null;
}
function cleanSel(s) {
  if (!s || !PAIR_RE.test(String(s.pair || ''))) return null;
  return { pair: s.pair, custom: !!s.custom, r: str(s.r, 200), id: str(s.id, 12), my: str(s.my, 200), alt: +s.alt || 0, ts: +s.ts || Date.now() };
}
const parse = t => { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } };

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const reply = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
  try {
    const auth = getBlobsAuth(event);
    if (!(auth.siteID && auth.token && auth.edgeURL)) return reply(503, { error: 'storage unavailable' });
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const k = String(q.k || '');
      if (!CODE_RE.test(k)) return reply(400, { error: 'bad code' });
      const pairs = String(q.pairs || '').split(',').map(s => s.trim().toUpperCase()).filter(p => PAIR_RE.test(p)).slice(0, 6);
      const [selTxt, ...pairTxts] = await Promise.all([blobsRequest('get', auth, selKey(k)), ...pairs.map(p => blobsRequest('get', auth, pairKey(k, p)))]);
      const out = { pairs: {}, sel: parse(selTxt) };
      pairs.forEach((p, i) => { const e = parse(pairTxts[i]); if (e) out.pairs[p] = e; });
      return reply(200, out);
    }
    if (event.httpMethod !== 'POST') return reply(405, { error: 'GET or POST' });
    if ((event.body || '').length > 60000) return reply(413, { error: 'too large' });
    let b; try { b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body || '{}'); } catch (e) { return reply(400, { error: 'bad json' }); }
    if (!CODE_RE.test(String(b.k || ''))) return reply(400, { error: 'bad code' });
    const done = [];
    if (b.pair && PAIR_RE.test(String(b.pair))) {
      const e = cleanEntry(b.entry);
      if (e) { await blobsRequest('put', auth, pairKey(b.k, b.pair), JSON.stringify(e)); done.push('pair'); }
    }
    const s = cleanSel(b.sel);
    if (s) { await blobsRequest('put', auth, selKey(b.k), JSON.stringify(s)); done.push('sel'); }
    return reply(200, { stored: done });
  } catch (err) {
    return reply(502, { error: err.message });
  }
};
