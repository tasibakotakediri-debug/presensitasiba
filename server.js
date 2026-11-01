const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const COOKIE_SECURE = process.env.NODE_ENV === 'production' ? '; Secure' : '';
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
const blankDb = { participants: [], attendance: [], receipts: [], spreadsheet: null };
const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon' };

function readDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ ...blankDb, admin: null }, null, 2));
  try { return { ...blankDb, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
  catch { throw new Error('File database.json rusak. Pulihkan dari cadangan sebelum melanjutkan.'); }
}
function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${DB_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DB_FILE);
}
function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers });
  res.end(payload);
}
function cookie(req, name) {
  const item = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}
function setSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `hadir_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${COOKIE_SECURE}`);
}
function isAdmin(req) {
  const token = cookie(req, 'hadir_session'), expires = sessions.get(token);
  if (!expires || expires < Date.now()) { sessions.delete(token); return false; }
  sessions.set(token, Date.now() + SESSION_MS);
  return true;
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = ''; req.on('data', part => { raw += part; if (raw.length > 8_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Format data tidak valid.')); } });
    req.on('error', reject);
  });
}
function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function safeEqual(a, b) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function validList(value) { return Array.isArray(value) && value.length < 500000; }
function spreadsheetDetails(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Masukkan tautan Google Sheets yang valid.'); }
  if (url.hostname !== 'docs.google.com' || !url.pathname.startsWith('/spreadsheets/d/')) throw new Error('Gunakan tautan Google Sheets (docs.google.com/spreadsheets/...).');
  const publishedMatch = url.pathname.match(/^\/spreadsheets\/d\/e\/([^/]+)\/(?:pubhtml|pub)/);
  const match = publishedMatch || url.pathname.match(/^\/spreadsheets\/d\/([^/]+)/);
  if (!match || (!publishedMatch && match[1] === 'e')) throw new Error('ID spreadsheet tidak ditemukan pada tautan.');
  const gid = url.searchParams.get('gid') || url.hash.match(/(?:^#|&)gid=(\d+)/)?.[1] || '0';
  return { url: url.toString(), id: match[1], gid, published: !!publishedMatch };
}
async function getSpreadsheetCsv(sheet) {
  const details = spreadsheetDetails(sheet.url), id = encodeURIComponent(details.id), gid = encodeURIComponent(details.gid);
  const urls = details.published
    ? [`https://docs.google.com/spreadsheets/d/e/${id}/pub?output=csv&gid=${gid}`]
    : [
      `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`,
      `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid}`,
      `https://docs.google.com/spreadsheets/d/${id}/pub?output=csv&gid=${gid}`
    ];
  let lastStatus = 'tidak ada respons';
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent':'Mozilla/5.0 Tasiba26/1.0', 'Accept':'text/csv,text/plain,*/*' } });
      lastStatus = `HTTP ${response.status}`;
      if (!response.ok) continue;
      const text = await response.text();
      if (/^\s*<!doctype html|^\s*<html/i.test(text)) { lastStatus = 'Google mengirim halaman akses HTML'; continue; }
      if (text.trim()) return text;
    } catch (error) { lastStatus = error.name === 'TimeoutError' ? 'waktu akses habis' : 'gagal terhubung'; }
  }
  throw new Error(`Google Sheets belum dapat dibaca (${lastStatus}). Coba bagikan sebagai Viewer. Jika masih gagal, di Google Sheets pilih File → Bagikan → Publikasikan ke web, pilih tab peserta dan format CSV, lalu tempel tautan publikasinya di sini.`);
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
  return rows.filter(r => r.some(c => c.trim()));
}
function headerKey(value) { return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function columnIndex(headers, kind) {
  const keys = headers.map(headerKey);
  const matchers = {
    name: k => /^(nama|name)( peserta)?$/.test(k) || k.includes('nama peserta') || k.includes('nama lengkap'),
    id: k => /^(id|nis|nisn|nim|nomor peserta|no peserta|no pendaftaran|nomor pendaftaran)$/.test(k) || k.includes('id peserta') || k.includes('nomor peserta'),
    school: k => /^(sekolah|school|asal sekolah|asal sekolah peserta)$/.test(k) || k.includes('asal sekolah') || k.includes('nama sekolah')
  };
  return keys.findIndex(matchers[kind]);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
      const db = readDb(); return send(res, 200, { setupRequired: !db.admin, authenticated: isAdmin(req) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/setup') {
      const db = readDb(); if (db.admin) return send(res, 409, { error: 'Admin sudah disiapkan. Silakan login.' });
      const data = await body(req), username = String(data.username || '').trim(), password = String(data.password || '');
      if (username.length < 3 || username.length > 60 || password.length < 10 || password.length > 200) return send(res, 400, { error: 'Username minimal 3 karakter dan kata sandi minimal 10 karakter.' });
      db.admin = { username, ...passwordHash(password) }; writeDb(db); setSession(res); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const db = readDb(), data = await body(req), username = String(data.username || '').trim(), password = String(data.password || '');
      if (!db.admin || username !== db.admin.username) return send(res, 401, { error: 'Username atau kata sandi salah.' });
      const attempt = passwordHash(password, db.admin.salt);
      if (!safeEqual(attempt.hash, db.admin.hash)) return send(res, 401, { error: 'Username atau kata sandi salah.' });
      setSession(res); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/reset-password') {
      const db = readDb(), data = await body(req), username = String(data.username || '').trim(), current = String(data.currentPassword || ''), next = String(data.newPassword || '');
      if (!db.admin || username !== db.admin.username) return send(res, 401, { error: 'Username atau kata sandi saat ini tidak sesuai.' });
      const attempt = passwordHash(current, db.admin.salt);
      if (!safeEqual(attempt.hash, db.admin.hash)) return send(res, 401, { error: 'Username atau kata sandi saat ini tidak sesuai.' });
      if (next.length < 10 || next.length > 200) return send(res, 400, { error: 'Kata sandi baru harus 10–200 karakter.' });
      db.admin = { username: db.admin.username, ...passwordHash(next) }; writeDb(db);
      sessions.clear(); setSession(res);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      sessions.delete(cookie(req, 'hadir_session'));
      res.setHeader('Set-Cookie', `hadir_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${COOKIE_SECURE}`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Silakan login sebagai admin.' });
      if (req.method === 'GET' && url.pathname === '/api/spreadsheet') {
        const db = readDb(); return send(res, 200, { spreadsheet: db.spreadsheet || null });
      }
      if (req.method === 'PUT' && url.pathname === '/api/spreadsheet') {
        const db = readDb(), data = await body(req), details = spreadsheetDetails(String(data.url || '').trim());
        db.spreadsheet = details; writeDb(db); return send(res, 200, { spreadsheet: details });
      }
      if (req.method === 'POST' && url.pathname === '/api/spreadsheet/import') {
        const db = readDb(); if (!db.spreadsheet) return send(res, 400, { error: 'Simpan tautan spreadsheet terlebih dahulu.' });
        let source;
        try { source = await getSpreadsheetCsv(db.spreadsheet); }
        catch (error) { return send(res, 502, { error: error.message }); }
        const rows = parseCsv(source); if (!rows.length) return send(res, 400, { error: 'Sheet kosong atau tidak memiliki data CSV.' });
        let headerRow = -1, nameCol = -1, idCol = -1, schoolCol = -1;
        for (let i = 0; i < Math.min(rows.length, 15); i++) {
          const n = columnIndex(rows[i], 'name'), s = columnIndex(rows[i], 'school');
          if (n >= 0 && s >= 0) { headerRow = i; nameCol = n; schoolCol = s; idCol = columnIndex(rows[i], 'id'); break; }
        }
        if (headerRow < 0) return send(res, 400, { error: 'Kolom tidak dikenali. Sediakan judul kolom Nama Peserta dan Asal Sekolah (ID Peserta opsional).'});
        const byId = new Map(db.participants.map((p, i) => [String(p.id).toLocaleLowerCase('id-ID'), i]));
        let created = 0, updated = 0, skipped = 0, next = db.participants.length + 1;
        for (const row of rows.slice(headerRow + 1)) {
          const name = String(row[nameCol] || '').trim(), school = String(row[schoolCol] || '').trim();
          if (!name || !school) { skipped++; continue; }
          let id = idCol >= 0 ? String(row[idCol] || '').trim() : '';
          if (!id) {
            const existing = db.participants.find(p => p.name.trim().toLocaleLowerCase('id-ID') === name.toLocaleLowerCase('id-ID') && p.school.trim().toLocaleLowerCase('id-ID') === school.toLocaleLowerCase('id-ID'));
            if (existing) id = existing.id;
            else { do { id = `PS-${String(next++).padStart(3, '0')}`; } while (byId.has(id.toLocaleLowerCase('id-ID'))); }
          }
          const key = id.toLocaleLowerCase('id-ID'), existingIndex = byId.get(key), participant = { id, name, school };
          if (existingIndex !== undefined) { db.participants[existingIndex] = participant; updated++; }
          else { byId.set(key, db.participants.length); db.participants.push(participant); created++; }
        }
        writeDb(db); return send(res, 200, { created, updated, skipped, total: db.participants.length });
      }
      if (req.method === 'GET' && url.pathname === '/api/data') {
        const db = readDb(); return send(res, 200, { participants: db.participants, attendance: db.attendance, receipts: db.receipts });
      }
      if (req.method === 'PUT' && url.pathname === '/api/data') {
        const db = readDb(), data = await body(req);
        if (!validList(data.participants) || !validList(data.attendance) || !validList(data.receipts)) return send(res, 400, { error: 'Data yang dikirim tidak valid.' });
        db.participants = data.participants; db.attendance = data.attendance; db.receipts = data.receipts; writeDb(db);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Endpoint tidak ditemukan.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let file = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = path.resolve(__dirname, `.${file}`);
    if (!target.startsWith(`${__dirname}${path.sep}`) && target !== path.join(__dirname, 'index.html')) return send(res, 403, 'Forbidden');
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  } catch (err) {
    console.error(err); if (!res.headersSent) send(res, 500, { error: err.message || 'Terjadi kesalahan pada server.' }); else res.end();
  }
});

server.listen(PORT, HOST, () => console.log(`Tasiba 26 berjalan di http://${HOST}:${PORT}`));
