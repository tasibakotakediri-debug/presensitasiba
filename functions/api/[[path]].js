const EMPTY_STATE = { participants: [], attendance: [], receipts: [], spreadsheet: null };
const SESSION_SECONDS = 12 * 60 * 60;
const PBKDF2_ITERATIONS = 310000;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

async function ensureDatabase(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)').run();
  await db.prepare('INSERT OR IGNORE INTO app_state (id, data) VALUES (1, ?)').bind(JSON.stringify(EMPTY_STATE)).run();
}

async function state(db) {
  const row = await db.prepare('SELECT data FROM app_state WHERE id = 1').first();
  return { ...EMPTY_STATE, ...(row ? JSON.parse(row.data) : {}) };
}

async function saveState(db, value) {
  await db.prepare('UPDATE app_state SET data = ? WHERE id = 1').bind(JSON.stringify(value)).run();
}

function randomHex(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function hashPassword(password, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(salt), iterations: PBKDF2_ITERATIONS }, material, 256);
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return result === 0;
}

function cookieValue(request, name) {
  const entry = (request.headers.get('Cookie') || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : '';
}

function sessionCookie(token, maxAge = SESSION_SECONDS) {
  return `hadir_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function isAdmin(request, db) {
  const token = cookieValue(request, 'hadir_session');
  if (!token) return false;
  const hashed = await tokenHash(token), now = Math.floor(Date.now() / 1000);
  const session = await db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').bind(hashed).first();
  if (!session || session.expires_at <= now) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hashed).run();
    return false;
  }
  await db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + SESSION_SECONDS, hashed).run();
  return true;
}

async function requestBody(request) {
  try { return await request.json(); }
  catch { throw new Error('Format data tidak valid.'); }
}

function spreadsheetDetails(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Masukkan tautan Google Sheets yang valid.'); }
  if (url.hostname !== 'docs.google.com' || !url.pathname.startsWith('/spreadsheets/d/')) throw new Error('Gunakan tautan Google Sheets yang valid.');
  const published = url.pathname.match(/^\/spreadsheets\/d\/e\/([^/]+)\/(?:pubhtml|pub)/);
  const match = published || url.pathname.match(/^\/spreadsheets\/d\/([^/]+)/);
  if (!match || (!published && match[1] === 'e')) throw new Error('ID spreadsheet tidak ditemukan pada tautan.');
  return { url: url.toString(), id: match[1], gid: url.searchParams.get('gid') || url.hash.match(/(?:^#|&)gid=(\d+)/)?.[1] || '0', published: !!published };
}

async function getSpreadsheetCsv(sheet) {
  const id = encodeURIComponent(sheet.id), gid = encodeURIComponent(sheet.gid);
  const urls = sheet.published
    ? [`https://docs.google.com/spreadsheets/d/e/${id}/pub?output=csv&gid=${gid}`]
    : [`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`, `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid}`, `https://docs.google.com/spreadsheets/d/${id}/pub?output=csv&gid=${gid}`];
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { Accept: 'text/csv,text/plain,*/*' } });
      if (!response.ok) continue;
      const text = await response.text();
      if (text.trim() && !/^\s*<!doctype html|^\s*<html/i.test(text)) return text;
    } catch {}
  }
  throw new Error('Google Sheets belum dapat dibaca. Pastikan aksesnya Viewer atau publikasikan tab sebagai CSV.');
}

function parseCsv(source) {
  const rows = []; let row = [], cell = '', quoted = false;
  source = source.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted && ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) { if (ch === '\r' && source[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((items) => items.some((item) => item.trim()));
}

function headerKey(value) { return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function columnIndex(headers, kind) {
  const keys = headers.map(headerKey), matchers = {
    name: (key) => /^(nama|name)( peserta)?$/.test(key) || key.includes('nama peserta') || key.includes('nama lengkap'),
    id: (key) => /^(id|nis|nisn|nim|nomor peserta|no peserta|no pendaftaran)$/.test(key) || key.includes('id peserta'),
    school: (key) => /^(sekolah|school|asal sekolah)$/.test(key) || key.includes('asal sekolah') || key.includes('nama sekolah'),
  };
  return keys.findIndex(matchers[kind]);
}

async function importParticipants(db) {
  const current = await state(db);
  if (!current.spreadsheet) return json({ error: 'Simpan tautan spreadsheet terlebih dahulu.' }, 400);
  const rows = parseCsv(await getSpreadsheetCsv(current.spreadsheet));
  let header = -1, nameCol = -1, idCol = -1, schoolCol = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const name = columnIndex(rows[i], 'name'), school = columnIndex(rows[i], 'school');
    if (name >= 0 && school >= 0) { header = i; nameCol = name; schoolCol = school; idCol = columnIndex(rows[i], 'id'); break; }
  }
  if (header < 0) return json({ error: 'Kolom tidak dikenali. Gunakan judul Nama Peserta dan Asal Sekolah; ID Peserta opsional.' }, 400);
  let created = 0, updated = 0, skipped = 0, next = current.participants.length + 1;
  for (const row of rows.slice(header + 1)) {
    const name = String(row[nameCol] || '').trim(), school = String(row[schoolCol] || '').trim();
    if (!name || !school) { skipped++; continue; }
    let id = idCol >= 0 ? String(row[idCol] || '').trim() : '';
    if (!id) {
      const match = current.participants.find((person) => person.name.toLowerCase() === name.toLowerCase() && person.school.toLowerCase() === school.toLowerCase());
      if (match) id = match.id;
      else { do { id = `PS-${String(next++).padStart(3, '0')}`; } while (current.participants.some((person) => person.id.toLowerCase() === id.toLowerCase())); }
    }
    const index = current.participants.findIndex((person) => person.id.toLowerCase() === id.toLowerCase()), person = { id, name, school };
    if (index >= 0) { current.participants[index] = person; updated++; }
    else { current.participants.push(person); created++; }
  }
  await saveState(db, current);
  return json({ created, updated, skipped, total: current.participants.length });
}

export async function onRequest(context) {
  const { request, env } = context, db = env.DB;
  if (!db) return json({ error: 'Database D1 belum terhubung. Tambahkan binding bernama DB pada pengaturan Cloudflare Pages.' }, 503);
  try {
    await ensureDatabase(db);
    const { pathname } = new URL(request.url), method = request.method;
    if (method === 'GET' && pathname === '/api/health') return json({ status: 'ok' });

    if (method === 'GET' && pathname === '/api/auth/status') {
      const admin = await db.prepare('SELECT id FROM admin WHERE id = 1').first();
      return json({ setupRequired: !admin, authenticated: await isAdmin(request, db) });
    }
    if (method === 'POST' && pathname === '/api/auth/setup') {
      const data = await requestBody(request), username = String(data.username || '').trim(), password = String(data.password || '');
      if (username.length < 3 || username.length > 60 || password.length < 10 || password.length > 200) return json({ error: 'Username minimal 3 karakter dan kata sandi minimal 10 karakter.' }, 400);
      const salt = randomHex(16), passwordHash = await hashPassword(password, salt);
      const result = await db.prepare('INSERT OR IGNORE INTO admin (id, username, salt, password_hash) VALUES (1, ?, ?, ?)').bind(username, salt, passwordHash).run();
      if (!result.meta.changes) return json({ error: 'Admin sudah disiapkan. Silakan login.' }, 409);
      const token = randomHex(32), tokenDigest = await tokenHash(token), expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
      await db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').bind(tokenDigest, expires).run();
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
    }
    if (method === 'POST' && pathname === '/api/auth/login') {
      const data = await requestBody(request), username = String(data.username || '').trim(), password = String(data.password || '');
      const admin = await db.prepare('SELECT username, salt, password_hash FROM admin WHERE id = 1').first();
      if (!admin || username !== admin.username || !safeEqual(await hashPassword(password, admin.salt), admin.password_hash)) return json({ error: 'Username atau kata sandi salah.' }, 401);
      const token = randomHex(32), tokenDigest = await tokenHash(token), expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
      await db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').bind(tokenDigest, expires).run();
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
    }
    if (method === 'POST' && pathname === '/api/auth/logout') {
      const token = cookieValue(request, 'hadir_session');
      if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await tokenHash(token)).run();
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
    }

    if (method === 'POST' && pathname === '/api/auth/reset-password') {
      const data = await requestBody(request), username = String(data.username || '').trim(), current = String(data.currentPassword || ''), next = String(data.newPassword || '');
      const admin = await db.prepare('SELECT username, salt, password_hash FROM admin WHERE id = 1').first();
      if (!admin || username !== admin.username || !safeEqual(await hashPassword(current, admin.salt), admin.password_hash)) return json({ error: 'Username atau kata sandi saat ini tidak sesuai.' }, 401);
      if (next.length < 10 || next.length > 200) return json({ error: 'Kata sandi baru harus 10–200 karakter.' }, 400);
      const salt = randomHex(16), passwordHash = await hashPassword(next, salt);
      await db.prepare('UPDATE admin SET salt = ?, password_hash = ? WHERE id = 1').bind(salt, passwordHash).run();
      await db.prepare('DELETE FROM sessions').run();
      const token = randomHex(32), tokenDigest = await tokenHash(token), expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
      await db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').bind(tokenDigest, expires).run();
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
    }

    if (!await isAdmin(request, db)) return json({ error: 'Silakan login sebagai admin.' }, 401);
    if (method === 'GET' && pathname === '/api/data') {
      const data = await state(db);
      return json({ participants: data.participants, attendance: data.attendance, receipts: data.receipts });
    }
    if (method === 'PUT' && pathname === '/api/data') {
      const body = await requestBody(request);
      if (![body.participants, body.attendance, body.receipts].every((list) => Array.isArray(list) && list.length < 500000)) return json({ error: 'Data yang dikirim tidak valid.' }, 400);
      const data = await state(db);
      data.participants = body.participants; data.attendance = body.attendance; data.receipts = body.receipts;
      await saveState(db, data);
      return json({ ok: true });
    }
    if (method === 'GET' && pathname === '/api/spreadsheet') return json({ spreadsheet: (await state(db)).spreadsheet || null });
    if (method === 'PUT' && pathname === '/api/spreadsheet') {
      const body = await requestBody(request), data = await state(db);
      try { data.spreadsheet = spreadsheetDetails(String(body.url || '').trim()); }
      catch (error) { return json({ error: error.message }, 400); }
      await saveState(db, data);
      return json({ spreadsheet: data.spreadsheet });
    }
    if (method === 'POST' && pathname === '/api/spreadsheet/import') {
      try { return await importParticipants(db); }
      catch (error) { return json({ error: error.message || 'Impor spreadsheet gagal.' }, 502); }
    }
    return json({ error: 'Endpoint tidak ditemukan.' }, 404);
  } catch (error) {
    return json({ error: error.message || 'Terjadi kesalahan pada server.' }, 500);
  }
}
