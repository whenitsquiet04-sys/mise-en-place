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
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
  });
}

function setCookie(res, name, value, opts = {}) {
  const o = { httpOnly: true, path: '/', sameSite: 'lax', maxAge: 60*60*24*30, ...opts };
  if (BASE_URL.startsWith('https')) o.secure = true;
  res.setHeader('Set-Cookie', cookie.serialize(name, value, o));
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie', cookie.serialize(name, '', { httpOnly: true, path: '/', maxAge: 0 }));
}

function getCookies(req) { return cookie.parse(req.headers.cookie || ''); }

function getSession(req) {
  const token = getCookies(req).session;
  if (!token) return null;
  return db.getSession(token);
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function redirect(res, url) { res.writeHead(302, { Location: url }); res.end(); }

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mise-en-place/1.0' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  res.end(content); return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  try {
    // ── Google OAuth ──
    if (pathname === '/auth/google') {
      const state = crypto.randomBytes(16).toString('hex');
      setCookie(res, 'oauth_state', state, { maxAge: 600 });
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: `${BASE_URL}/auth/google/callback`,
        response_type: 'code',
        scope: 'openid email profile',
        state,
      });
      return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    }

    if (pathname === '/auth/google/callback') {
      const code = url.searchParams.get('code');
      if (!code || !GOOGLE_CLIENT_ID) return redirect(res, '/?error=auth_failed');
      try {
        const tokens = await httpsPost('oauth2.googleapis.com', '/token', {
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: `${BASE_URL}/auth/google/callback`,
          grant_type: 'authorization_code',
        });
        if (!tokens.access_token) throw new Error('No token');
        const profile = await fetchJSON(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${tokens.access_token}`);
        const userId = `google_${profile.sub}`;
        db.upsertUser(userId, profile.email, profile.name, profile.picture);
        const token = db.createSession(userId);
        setCookie(res, 'session', token);
        clearCookie(res, 'oauth_state');
        return redirect(res, '/');
      } catch(e) {
        console.error('Auth error:', e.message);
        return redirect(res, '/?error=auth_failed');
      }
    }

    if (pathname === '/auth/logout') {
      const token = getCookies(req).session;
      if (token) db.deleteSession(token);
      clearCookie(res, 'session');
      return redirect(res, '/');
    }

    if (pathname === '/auth/me') {
      const user = getSession(req);
      if (!user) return json(res, { user: null });
      return json(res, { user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar } });
    }

    // ── API ──
    if (pathname.startsWith('/api/')) {
      const user = getSession(req);
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      const resource = pathname.replace('/api/', '');
      if (req.method === 'GET') return json(res, { data: db.getData(user.id, resource) });
      if (req.method === 'POST') {
        const body = await parseBody(req);
        db.setData(user.id, body.resource || resource, body.data);
        return json(res, { ok: true });
      }
    }

    // ── Share target ──
    if (pathname === '/share') {
      const p = new URLSearchParams({ shared_url: url.searchParams.get('url')||'', shared_text: url.searchParams.get('text')||'' });
      return redirect(res, `/?${p}`);
    }

    // ── Static files ──
    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(res, path.join(__dirname, 'public', 'index.html'));
    }
    if (!serveFile(res, path.join(__dirname, 'public', pathname))) {
      serveFile(res, path.join(__dirname, 'public', 'index.html'));
    }

  } catch(e) {
    console.error('Server error:', e);
    res.writeHead(500); res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`🍽️  Mise en Place on port ${PORT}`);
  console.log(`   Google auth: ${GOOGLE_CLIENT_ID ? '✓' : '✗ GOOGLE_CLIENT_ID not set'}`);
});
