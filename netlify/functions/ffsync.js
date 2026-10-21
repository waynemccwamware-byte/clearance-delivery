// netlify/functions/ffsync.js  (Clearance Delivery Trainer v0.25)
//
// Keeps the ForeFlight routes a pilot brought back through Claude, and their last route pick, under a sync code,
// so every browser context on a device sees them. Needed on iPhone: Claude's fill-in link opens in the Claude
// app's own browser, whose storage is separate from the home-screen Control Panel's (found 20-Oct-2026).
//
//   GET  ?k=CODE                       -> { pairs:{ "KSBA-KSQL": {routes, at, ac, ts} }, sel:{pair, custom, r, id, my, alt, ts} | null }
//   POST { k, pair?, entry?, sel? }    -> merges (per pair and for sel, the newer ts wins) and returns the stored record
//
// The code (12 characters, no 0/O/1/I/L, as in Schedule's sync) is made by the app on each device and handed to
// Claude in the request; Claude puts it back in the link (k=). Nothing else identifies the pilot.
// Dependency-free on purpose: Netlify Blobs via the same edge protocol as nasr-freq.js / Schedule's sync.js.

const STORE_NAME = 'clearance-delivery-ffsync';
const CODE_RE = /^[A-HJKMNP-Z2-9]{12}$/;
const PAIR_RE = /^[A-Z0-9]{2,7}-[A-Z0-9]{2,7}$/;
const MAX_PAIRS = 60, MAX_BYTES = 200000;

function getBlobsAuth(event) {
  if (!event || !event.blobs || !event.headers) return {};
  try {
    const data = JSON.parse(Buffer.from(event.blobs, 'base64').toString('utf8'));
    return { siteID: event.headers['x-nf-site-id'], token: data.token, edgeURL: data.url };
  } catch (err) { return {}; }
}
async function blobsRequest(method, { siteID, token, edgeURL }, key, body) {
  const url = new URL(`/${siteID}/${STORE_NAME}/${key}`, edgeURL).toString();
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'text/plain' } : {}) },
    body,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Blobs ${method.toUpperCase()} failed (HTTP ${res.status})`);
  return method === 'get' ? res.text() : null;
}

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

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const reply = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
  try {
    const auth = getBlobsAuth(event);
    if (!(auth.siteID && auth.token && auth.edgeURL)) return reply(503, { error: 'storage unavailable' });
    if (event.httpMethod === 'GET') {
      const k = String((event.queryStringParameters || {}).k || '');
      if (!CODE_RE.test(k)) return reply(400, { error: 'bad code' });
      const txt = await blobsRequest('get', auth, k);
      return reply(200, txt ? JSON.parse(txt) : { pairs: {}, sel: null });
    }
    if (event.httpMethod !== 'POST') return reply(405, { error: 'GET or POST' });
    if ((event.body || '').length > 60000) return reply(413, { error: 'too large' });
    let b; try { b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body || '{}'); } catch (e) { return reply(400, { error: 'bad json' }); }
    if (!CODE_RE.test(String(b.k || ''))) return reply(400, { error: 'bad code' });
    const txt = await blobsRequest('get', auth, b.k);
    const rec = txt ? JSON.parse(txt) : { pairs: {}, sel: null };
    rec.pairs = rec.pairs || {};
    if (b.pair && PAIR_RE.test(String(b.pair))) {
      const e = cleanEntry(b.entry);
      if (e && (!rec.pairs[b.pair] || (rec.pairs[b.pair].ts || 0) < e.ts)) rec.pairs[b.pair] = e;
    }
    const s = cleanSel(b.sel);
    if (s && (!rec.sel || (rec.sel.ts || 0) < s.ts)) rec.sel = s;
    const keys = Object.keys(rec.pairs).sort((a, c) => (rec.pairs[c].ts || 0) - (rec.pairs[a].ts || 0));
    for (const key of keys.slice(MAX_PAIRS)) delete rec.pairs[key];
    let out = JSON.stringify(rec);
    while (out.length > MAX_BYTES && Object.keys(rec.pairs).length > 1) {
      const oldest = Object.keys(rec.pairs).sort((a, c) => (rec.pairs[a].ts || 0) - (rec.pairs[c].ts || 0))[0];
      delete rec.pairs[oldest]; out = JSON.stringify(rec);
    }
    await blobsRequest('put', auth, b.k, out);
    return reply(200, rec);
  } catch (err) {
    return reply(502, { error: err.message });
  }
};
