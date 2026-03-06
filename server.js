const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cookie = require('cookie');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ─── HELPERS ───────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function setCookie(res, name, value, opts = {}) {
  const defaults = { httpOnly: true, path: '/', sameSite: 'lax', maxAge: 60*60*24*30 };
  if (BASE_URL.startsWith('https')) defaults.secure = true;
  res.setHeader('Set-Cookie', cookie.serialize(name, value, { ...defaults, ...opts }));
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie', cookie.serialize(name, '', { httpOnly: true, path: '/', maxAge: 0 }));
}

function getCookies(req) {
  return cookie.parse(req.headers.cookie || '');
}

function getSession(req) {
  const cookies = getCookies(req);
  const token = cookies.session;
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?')
    .get(token, Math.floor(Date.now()/1000));
  if (!session) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  return user || null;
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now()/1000) + (60*60*24*30); // 30 days
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, expiresAt);
  setCookie(res, 'session', token);
  return token;
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function redirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mise-en-place/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const opts = {
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...headers }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── GOOGLE OAUTH ──────────────────────────────────────────────────────────

function googleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function googleCallback(code) {
  const tokens = await httpsPost('oauth2.googleapis.com', '/token', {
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: `${BASE_URL}/auth/google/callback`,
    grant_type: 'authorization_code',
  });
  if (!tokens.access_token) throw new Error('No access token');
  const profile = await fetchJSON(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${tokens.access_token}`);
  return profile;
}

// ─── USER DATA HELPERS ─────────────────────────────────────────────────────

function getUserData(userId, table) {
  const row = db.prepare(`SELECT data FROM ${table} WHERE user_id = ?`).get(userId);
  return row ? JSON.parse(row.data) : null;
}

function setUserData(userId, table, data) {
  const id = `${table}_${userId}`;
  const existing = db.prepare(`SELECT id FROM ${table} WHERE user_id = ?`).get(userId);
  if (existing) {
    db.prepare(`UPDATE ${table} SET data = ?, updated_at = unixepoch() WHERE user_id = ?`)
      .run(JSON.stringify(data), userId);
  } else {
    db.prepare(`INSERT INTO ${table} (id, user_id, data) VALUES (?, ?, ?)`)
      .run(id, userId, JSON.stringify(data));
  }
}

// ─── STATIC FILES ──────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath);
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(content);
  return true;
}

// ─── ROUTER ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {

    // ── AUTH: Google OAuth ──────────────────────────────────────────────
    if (pathname === '/auth/google') {
      const state = crypto.randomBytes(16).toString('hex');
      setCookie(res, 'oauth_state', state, { maxAge: 600, httpOnly: true });
      return redirect(res, googleAuthUrl(state));
    }

    if (pathname === '/auth/google/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const cookies = getCookies(req);
      
      if (!code || !GOOGLE_CLIENT_ID) {
        return redirect(res, '/?error=auth_failed');
      }

      try {
        const profile = await googleCallback(code);
        const userId = `google_${profile.sub}`;
        
        // Upsert user
        db.prepare(`INSERT INTO users (id, email, name, avatar) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, avatar=excluded.avatar`)
          .run(userId, profile.email, profile.name, profile.picture);

        createSession(res, userId);
        clearCookie(res, 'oauth_state');
        return redirect(res, '/');
      } catch(e) {
        console.error('Google auth error:', e);
        return redirect(res, '/?error=auth_failed');
      }
    }

    if (pathname === '/auth/logout') {
      const cookies = getCookies(req);
      if (cookies.session) {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(cookies.session);
      }
      clearCookie(res, 'session');
      return redirect(res, '/');
    }

    if (pathname === '/auth/me') {
      const user = getSession(req);
      if (!user) return json(res, { user: null });
      return json(res, { user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar } });
    }

    // ── API: Recipe data ────────────────────────────────────────────────
    if (pathname.startsWith('/api/')) {
      const user = getSession(req);
      if (!user) return json(res, { error: 'Unauthorized' }, 401);

      const resource = pathname.replace('/api/', '');

      if (method === 'GET') {
        const data = getUserData(user.id, resource);
        return json(res, { data });
      }

      if (method === 'POST') {
        const body = await parseBody(req);
        setUserData(user.id, body.resource || resource, body.data);
        return json(res, { ok: true });
      }
    }

    // ── SHARE TARGET ────────────────────────────────────────────────────
    if (pathname === '/share') {
      const user = getSession(req);
      const sharedUrl = url.searchParams.get('url') || '';
      const sharedText = url.searchParams.get('text') || '';
      const sharedTitle = url.searchParams.get('title') || '';
      const params = new URLSearchParams({ shared_url: sharedUrl, shared_text: sharedText, shared_title: sharedTitle });
      return redirect(res, `/?${params}`);
    }

    // ── STATIC FILES ────────────────────────────────────────────────────
    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(res, path.join(__dirname, 'public', 'index.html'));
    }

    const staticPath = path.join(__dirname, 'public', pathname);
    if (serveFile(res, staticPath)) return;

    // SPA fallback
    serveFile(res, path.join(__dirname, 'public', 'index.html'));

  } catch(e) {
    console.error('Server error:', e);
    res.writeHead(500);
    res.end('Internal server error');
  }
});

server.listen(PORT, () => {
  console.log(`\n🍽️  Mise en Place running at ${BASE_URL}`);
  console.log(`   Google Client ID: ${GOOGLE_CLIENT_ID ? '✓ set' : '✗ NOT SET - auth will not work'}`);
  console.log(`   Database: ready\n`);
});
