// netlify/functions/nasr-freq.js  (Clearance Delivery Trainer v0.18)
//
// Current FAA frequencies for US airports, from the FAA's 28-day NASR subscription
// (FRQ "Frequency Data" CSV group), so the trainer doesn't depend on OurAirports for US fields.
//
//   ?action=get            -> the stored table { meta, ap:{ LID: {cd,g,t,ap,ctr,d} } }  (fast; no FAA call)
//   ?action=update         -> download the current cycle's FRQ zip from nfdc.faa.gov, rebuild, store, return meta + diff
//   ?action=inspect&id=SQL -> header row + raw FRQ rows serviced by that airport (to check column use against real data)
//   ?action=inspect&id=SBA&group=CLS_ARSP -> same for the class-airspace file (Class C flag, v0.19)
//
// Source pages (read 18-Oct-2026):
//   https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/   (current + preview cycles)
//   .../NASR_Subscription/2026-10-01 lists FRQ as
//   https://nfdc.faa.gov/webContent/28DaySub/extra/01_Oct_2026_FRQ_CSV.zip
// FRQ columns known from the FAA TXT-to-CSV mapping PDF: FACILITY, FAC_NAME, FACILITY_TYPE, FREQ, SECTORIZATION,
// SERVICED_FACILITY, ... The remaining names are looked up by header, with fallbacks, so a renamed column fails soft
// and shows up in the update result's `columns` list.
//
// Dependency-free on purpose (drag-and-drop deploys run no npm install): zip is read with Node's own zlib, and
// Netlify Blobs uses the same verified Lambda "edge" protocol as Weather's hit-counter.js and Schedule's sync.js:
// siteID from the x-nf-site-id header, token + edge URL from event.blobs, one authenticated request per GET/PUT.

const zlib = require('zlib');

const STORE_NAME = 'clearance-delivery-nasr';
const KEY = 'frq-table';
const SUB_PAGE = 'https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/';
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ---------- Netlify Blobs (edge protocol, as in hit-counter.js) ---------- */
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

/* ---------- which cycle is current ---------- */
function ymd(d) { return d.toISOString().slice(0, 10); }
async function currentCycle(now) {
  const today = ymd(now);
  try {
    const res = await fetch(SUB_PAGE, { headers: { 'user-agent': 'Mozilla/5.0 (GeezerGeek Pilot Clearance Delivery Trainer)' } });
    if (res.ok) {
      const html = await res.text();
      const dates = [...new Set([...html.matchAll(/NASR_Subscription\/(\d{4}-\d{2}-\d{2})/g)].map(m => m[1]))].sort();
      const cur = dates.filter(d => d <= today).pop();
      if (cur) return { eff: cur, from: 'page' };
    }
  } catch (e) { /* fall through to arithmetic */ }
  // 28-day AIRAC-style cycles; 2026-10-01 is a published cycle date (read on faa.gov 18-Oct-2026)
  const base = Date.UTC(2026, 9, 1), day = 86400000;
  const n = Math.floor((now.getTime() - base) / (28 * day));
  return { eff: ymd(new Date(base + n * 28 * day)), from: 'arithmetic' };
}
function groupUrl(eff, group) {
  const [y, m, d] = eff.split('-');
  return `https://nfdc.faa.gov/webContent/28DaySub/extra/${d}_${MON[+m - 1]}_${y}_${group}_CSV.zip`;
}
const frqUrl = eff => groupUrl(eff, 'FRQ');
async function fetchGroupRows(eff, group) {
  const url = groupUrl(eff, group);
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (GeezerGeek Pilot Clearance Delivery Trainer)' } });
  if (!res.ok) throw new Error(`FAA download failed (HTTP ${res.status}) for ${url}`);
  const { name, text } = unzipEntry(Buffer.from(await res.arrayBuffer()), n => new RegExp('^(.*/)?' + group + '[^/]*\\.csv$', 'i').test(n));
  return { url, name, rows: parseCSV(text) };
}
/* Class C airports from the CLS_ARSP (class airspace) group. Column names not yet confirmed against the real file,
   so: airport id = first of ARPT_ID / LOCATION_ID / SITE_ID / FACILITY_ID / ARPT; Class C = any column whose name
   contains CLASS_C (value starting with Y, or "C"). Returns null if the columns can't be found (caller keeps going). */
function classCFrom(rows) {
  const H = rows[0].map(h => h.trim().toUpperCase());
  let idc = -1; for (const n of ['ARPT_ID', 'LOCATION_ID', 'SITE_ID', 'FACILITY_ID', 'ARPT', 'LOC_ID']) { idc = H.indexOf(n); if (idc >= 0) break; }
  const cc = H.map((h, i) => /CLASS_?C/.test(h) ? i : -1).filter(i => i >= 0);
  if (idc < 0 || !cc.length) return { ids: null, header: H };
  const ids = new Set();
  for (let k = 1; k < rows.length; k++) {
    const r = rows[k]; const id = (r[idc] || '').trim().toUpperCase(); if (!id) continue;
    if (cc.some(i => /^(Y|C$)/i.test((r[i] || '').trim()))) ids.add(id);
  }
  return { ids: [...ids], header: H };
}

/* ---------- zip (central directory -> one entry, deflate or stored) ---------- */
function unzipEntry(buf, test) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  let p = buf.readUInt32LE(eocd + 16);
  const n = buf.readUInt16LE(eocd + 10);
  const names = [];
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad zip directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    names.push(name);
    if (test(name)) {
      const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28);
      const data = buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
      return { name, text: (method === 0 ? data : zlib.inflateRawSync(data)).toString('latin1') };
    }
    p += 46 + nl + xl + cl;
  }
  throw new Error('No frequency CSV in zip (found: ' + names.join(', ') + ')');
}

/* ---------- CSV ---------- */
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/* ---------- FRQ rows -> per-airport table ---------- */
const title = s => String(s || '').toLowerCase().replace(/\b[a-z]/g, ch => ch.toUpperCase()).replace(/\bNorcal\b/, 'NorCal').replace(/\bSocal\b/, 'SoCal');
function vhf(s) {   // first VHF airband frequency in the field (drops UHF military ones)
  for (const m of String(s || '').matchAll(/\d{3}\.\d{1,3}/g)) { const v = +m[0]; if (v >= 118 && v < 137) return String(v); }
  return '';
}
function buildTable(rows) {
  const H = rows[0].map(h => h.trim().toUpperCase());
  const col = (...names) => { for (const n of names) { const i = H.indexOf(n); if (i >= 0) return i; } return -1; };
  const C = {
    svc: col('SERVICED_FACILITY'), fac: col('FACILITY', 'FACILITY_ID'), facName: col('FAC_NAME', 'FACILITY_NAME'),
    type: col('FACILITY_TYPE'), freq: col('FREQ', 'FREQUENCY'), use: col('FREQ_USE', 'FREQUENCY_USE'),
    sect: col('SECTORIZATION'), call: col('TOWER_OR_COMM_CALL'), apCall: col('PRIMARY_APPROACH_RADIO_CALL'),
  };
  if (C.svc < 0 || C.freq < 0) throw new Error('FRQ columns not found; header: ' + H.join(','));
  const ap = {};
  const get = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
  for (let k = 1; k < rows.length; k++) {
    const r = rows[k]; if (r.length < 3) continue;
    const id = get(r, C.svc).toUpperCase(); if (!id) continue;
    const f = vhf(get(r, C.freq)); if (!f) continue;
    const type = get(r, C.type).toUpperCase(), use = get(r, C.use).toUpperCase(), sect = get(r, C.sect);
    const e = ap[id] || (ap[id] = {});
    const primary = !/\/S\b|SECONDARY/.test(use);
    const set = (k2, v) => { if (!e[k2] || (primary && !e[k2 + 'P'])) { e[k2] = v; if (primary) e[k2 + 'P'] = 1; } };
    if (/ARTCC|CENTER/.test(type)) {
      // Center frequencies assigned to this airport; prefer low-altitude sectors
      const nm = title(get(r, C.facName) || get(r, C.fac)) + ' Center';
      if (!e.ctr || (/LOW/i.test(sect) && !/LOW/i.test(e.ctrS || ''))) { e.ctr = [f, nm]; e.ctrS = sect; }
      continue;
    }
    if (/\bCD\b|CLNC|CLEARANCE|\bCD\//.test(use)) set('cd', f);
    else if (/GND|GROUND/.test(use)) set('g', f);
    else if (/\bLC\b|LCL|LOCAL|\bTWR\b|TOWER|\bLC\//.test(use)) set('t', f);
    if (/APCH|APP|ARR/.test(use) || /DEP/.test(use)) {
      const nm = title(get(r, C.apCall) || get(r, C.call) || get(r, C.facName));
      if (/APCH|APP/.test(use) && nm && !e.ap) e.ap = [f, nm + ' Approach'];
      if (/DEP/.test(use)) { (e.d || (e.d = [])).length < 6 && e.d.push([f, ('DEP ' + (sect || '')).trim()]); if (nm && !e.ap) e.ap = [f, nm + ' Departure']; }
    }
  }
  for (const id in ap) { const e = ap[id]; delete e.cdP; delete e.gP; delete e.tP; delete e.ctrS; if (!Object.keys(e).length) delete ap[id]; }
  return { ap, columns: H };
}
function diff(prev, cur) {
  if (!prev) return null;
  let added = 0, removed = 0, changed = 0;
  for (const k in cur) { if (!prev[k]) added++; else if (JSON.stringify(prev[k]) !== JSON.stringify(cur[k])) changed++; }
  for (const k in prev) if (!cur[k]) removed++;
  return { added, removed, changed, total: added + removed + changed };
}

/* ---------- handler ---------- */
exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const q = (event && event.queryStringParameters) || {};
  const action = q.action || 'get';
  const reply = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
  try {
    const auth = getBlobsAuth(event);
    const haveBlobs = auth.siteID && auth.token && auth.edgeURL;
    if (action === 'get') {
      if (!haveBlobs) return reply(200, { meta: null, note: 'Blobs auth unavailable in this function context' });
      const txt = await blobsRequest('get', auth, KEY);
      return txt ? { statusCode: 200, headers, body: txt } : reply(200, { meta: null });
    }
    const cyc = await currentCycle(new Date());
    const url = frqUrl(cyc.eff);
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (GeezerGeek Pilot Clearance Delivery Trainer)' } });
    if (!res.ok) throw new Error(`FAA download failed (HTTP ${res.status}) for ${url}`);
    if (action === 'inspect' && q.group) {
      const g = String(q.group).toUpperCase().replace(/[^A-Z_]/g, '');
      const { name, rows } = await fetchGroupRows(cyc.eff, g);
      const id = String(q.id || '').toUpperCase();
      const hits = rows.slice(1).filter(r => r.some(v => (v || '').trim().toUpperCase() === id)).slice(0, 20);
      return reply(200, { cycle: cyc, file: name, rowCount: rows.length - 1, header: rows[0], rows: hits });
    }
    const zip = Buffer.from(await res.arrayBuffer());
    const { name, text } = unzipEntry(zip, n => /FRQ.*\.csv$/i.test(n));
    const rows = parseCSV(text);
    if (action === 'inspect') {
      const id = String(q.id || '').toUpperCase();
      const H = rows[0].map(h => h.trim().toUpperCase()), si = H.indexOf('SERVICED_FACILITY'), fi = H.indexOf('FACILITY');
      const hits = rows.slice(1).filter(r => (si >= 0 && (r[si] || '').trim().toUpperCase() === id) || (fi >= 0 && (r[fi] || '').trim().toUpperCase() === id)).slice(0, 60);
      return reply(200, { cycle: cyc, file: name, rowCount: rows.length - 1, header: H, rows: hits });
    }
    const { ap, columns } = buildTable(rows);
    // Class C flag (non-fatal: frequencies still update if this part fails)
    let classC = null, classErr = '';
    try {
      const cls = await fetchGroupRows(cyc.eff, 'CLS_ARSP');
      const r = classCFrom(cls.rows);
      if (r.ids) { classC = r.ids.length; for (const id of r.ids) (ap[id] || (ap[id] = {})).cc = 1; }
      else classErr = 'Class C columns not found; header: ' + r.header.join(',');
    } catch (e) { classErr = e.message; }
    const until = ymd(new Date(Date.parse(cyc.eff + 'T00:00:00Z') + 28 * 86400000));
    const meta = { effective: cyc.eff, until, fetchedAt: new Date().toISOString(), source: url, file: name, airports: Object.keys(ap).length, rows: rows.length - 1, cycleFrom: cyc.from, classC, ...(classErr ? { classErr } : {}) };
    let prev = null;
    if (haveBlobs) {
      try { const t = await blobsRequest('get', auth, KEY); prev = t ? JSON.parse(t).ap : null; } catch (e) { prev = null; }
      await blobsRequest('put', auth, KEY, JSON.stringify({ meta, ap }));
    }
    return reply(200, { meta, diff: diff(prev, ap), columns, stored: !!haveBlobs, ...(haveBlobs ? {} : { ap }) });
  } catch (err) {
    return reply(502, { error: err.message });
  }
};
