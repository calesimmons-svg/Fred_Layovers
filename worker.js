/**
 * Fred layovers — Cloudflare Worker API (D1 database)
 *
 * Bindings / settings the Worker needs:
 *   DB              D1 database binding (fred-layovers)
 *   POST_CODE       secret: shared squadron code required for any change
 *   ALLOWED_ORIGIN  variable: your GitHub Pages origin, e.g. https://you.github.io  ("*" = any)
 *
 * Routes:
 *   GET  /data                      everything the site needs
 *   POST /entries                   add a spot            {loc, cat, name, area, note}
 *   PUT  /entries/:id               edit a spot           {loc, cat, name, area, note}
 *   POST /entries/:id/vote          vote                  {dir, prev}  (each -1, 0, or 1)
 *   POST /stations                  add a location        {icao, city, region, cpName, cpFreq}
 *   PUT  /stations/:icao            update any of          {city, region, cpName, cpFreq, notes}
 *   DELETE /entries/:id             delete a spot
 *   DELETE /stations/:icao          delete a location and all of its spots
 */

const CATS = ['eat', 'drink', 'hotel', 'act'];

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(req, env);
    } catch (e) {
      res = json({ error: e.expose ? e.message : 'Server error' }, e.status || 500);
      if (!e.expose) console.error(e);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
};

async function route(req, env) {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const m = req.method;

  if (m === 'GET' && parts[0] === 'data' && parts.length === 1) return getData(env);

  // Everything below changes data and needs the squadron code
  if (!env.POST_CODE || req.headers.get('X-Post-Code') !== env.POST_CODE) fail(401, 'Wrong or missing squadron code');
  const body = m === 'DELETE' ? {} : await req.json().catch(() => fail(400, 'Body must be JSON'));

  if (parts[0] === 'entries') {
    if (m === 'POST' && parts.length === 1) return addEntry(env, body);
    if (m === 'PUT' && parts.length === 2) return editEntry(env, parts[1], body);
    if (m === 'DELETE' && parts.length === 2) return deleteEntry(env, parts[1]);
    if (m === 'POST' && parts.length === 3 && parts[2] === 'vote') return vote(env, parts[1], body);
  }
  if (parts[0] === 'stations') {
    if (m === 'POST' && parts.length === 1) return addStation(env, body);
    if (m === 'PUT' && parts.length === 2) return updateStation(env, parts[1], body);
    if (m === 'DELETE' && parts.length === 2) return deleteStation(env, parts[1]);
  }
  fail(404, 'Not found');
}

/* ---------- Read ---------- */
async function getData(env) {
  const [st, en] = await env.DB.batch([
    env.DB.prepare('SELECT icao, city, region, cp_name, cp_freq, notes FROM stations ORDER BY rowid'),
    env.DB.prepare('SELECT id, loc, cat, name, area, note, created, up, down FROM entries')
  ]);
  return json({
    stations: st.results.map(s => ({
      code: s.icao, city: s.city, region: s.region,
      cp: { name: s.cp_name, freq: s.cp_freq, notes: s.notes }
    })),
    entries: en.results.map(e => ({
      id: e.id, loc: e.loc, cat: e.cat, name: e.name, area: e.area, note: e.note,
      date: e.created, up: e.up, down: e.down
    }))
  });
}

/* ---------- Spots ---------- */
async function spotFields(env, b) {
  const f = {
    loc: clean(b.loc, 4).toUpperCase(), cat: clean(b.cat, 10),
    name: clean(b.name, 60), area: clean(b.area, 40), note: clean(b.note, 1500)
  };
  if (!f.name) fail(400, 'Name is required');
  if (!CATS.includes(f.cat)) fail(400, 'Unknown category');
  const st = await env.DB.prepare('SELECT 1 FROM stations WHERE icao = ?').bind(f.loc).first();
  if (!st) fail(400, 'Unknown station');
  return f;
}

async function addEntry(env, b) {
  const f = await spotFields(env, b);
  const id = crypto.randomUUID(), created = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO entries (id, loc, cat, name, area, note, created) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, f.loc, f.cat, f.name, f.area, f.note, created).run();
  return json({ ok: true, id, created }, 201);
}

async function editEntry(env, id, b) {
  const f = await spotFields(env, b);
  const r = await env.DB.prepare(
    'UPDATE entries SET loc = ?, cat = ?, name = ?, area = ?, note = ? WHERE id = ?'
  ).bind(f.loc, f.cat, f.name, f.area, f.note, id).run();
  if (!r.meta.changes) fail(404, 'Spot not found');
  return json({ ok: true });
}

async function deleteEntry(env, id) {
  const r = await env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
  if (!r.meta.changes) fail(404, 'Spot not found');
  return json({ ok: true });
}

async function vote(env, id, b) {
  const ok = v => v === -1 || v === 0 || v === 1;
  if (!ok(b.dir) || !ok(b.prev)) fail(400, 'dir and prev must be -1, 0, or 1');
  const upD = (b.dir === 1) - (b.prev === 1);
  const downD = (b.dir === -1) - (b.prev === -1);
  // Single atomic update, so simultaneous votes never overwrite each other
  const r = await env.DB.prepare(
    'UPDATE entries SET up = MAX(0, up + ?), down = MAX(0, down + ?) WHERE id = ? RETURNING up, down'
  ).bind(upD, downD, id).first();
  if (!r) fail(404, 'Spot not found');
  return json({ ok: true, up: r.up, down: r.down });
}

/* ---------- Stations ---------- */
const validFreq = f => !f || f.split(/[\/,]/).every(x => {
  x = x.trim(); const n = +x;
  return /^\d{1,3}(\.\d{1,3})?$/.test(x) && n >= 2 && n <= 400;
});

async function addStation(env, b) {
  const icao = clean(b.icao, 4).toUpperCase();
  const city = clean(b.city, 24), region = clean(b.region, 40);
  const cpName = clean(b.cpName, 40), cpFreq = clean(b.cpFreq, 40);
  if (!/^[A-Z][A-Z0-9]{3}$/.test(icao)) fail(400, 'ICAO must be four characters starting with a letter');
  if (!city) fail(400, 'Base or city is required');
  if (!validFreq(cpFreq)) fail(400, 'Bad frequency');
  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO stations (icao, city, region, cp_name, cp_freq) VALUES (?, ?, ?, ?, ?)'
  ).bind(icao, city, region, cpName, cpFreq).run();
  if (!r.meta.changes) fail(409, `${icao} already exists`);
  return json({ ok: true }, 201);
}

async function updateStation(env, icao, b) {
  const sets = [], vals = [];
  if ('city' in b) {
    const c = clean(b.city, 24);
    if (!c) fail(400, 'Base or city is required');
    sets.push('city = ?'); vals.push(c);
  }
  if ('region' in b) { sets.push('region = ?'); vals.push(clean(b.region, 40)); }
  if ('cpName' in b) { sets.push('cp_name = ?'); vals.push(clean(b.cpName, 40)); }
  if ('cpFreq' in b) {
    const f = clean(b.cpFreq, 40);
    if (!validFreq(f)) fail(400, 'Bad frequency');
    sets.push('cp_freq = ?'); vals.push(f);
  }
  if ('notes' in b) { sets.push('notes = ?'); vals.push(clean(b.notes, 2000)); }
  if (!sets.length) fail(400, 'Nothing to update');
  const r = await env.DB.prepare(`UPDATE stations SET ${sets.join(', ')} WHERE icao = ?`)
    .bind(...vals, icao.toUpperCase()).run();
  if (!r.meta.changes) fail(404, 'Station not found');
  return json({ ok: true });
}

async function deleteStation(env, icao) {
  icao = icao.toUpperCase();
  const [, st] = await env.DB.batch([
    env.DB.prepare('DELETE FROM entries WHERE loc = ?').bind(icao),
    env.DB.prepare('DELETE FROM stations WHERE icao = ?').bind(icao)
  ]);
  if (!st.meta.changes) fail(404, 'Station not found');
  return json({ ok: true });
}

/* ---------- Helpers ---------- */
function clean(v, max) { return String(v ?? '').trim().slice(0, max); }

function fail(status, message) {
  const e = new Error(message); e.status = status; e.expose = true; throw e;
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
}

function corsHeaders(req, env) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
  const origin = req.headers.get('Origin') || '';
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Post-Code',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
