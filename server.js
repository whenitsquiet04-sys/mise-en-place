const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ── Cookie helpers (no dependency) ──
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[decodeURIComponent(k.trim())] = decodeURIComponent(v.join('=').trim());
  });
  return cookies;
}

function setCookie(res, name, value, opts = {}) {
  let str = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  if (opts.maxAge) str += `; Max-Age=${opts.maxAge}`;
  if (opts.httpOnly !== false) str += '; HttpOnly';
  str += '; Path=/; SameSite=Lax';
  if (BASE_URL.startsWith('https')) str += '; Secure';
  const existing = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : [existing]), str]);
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
  });
}

function getSession(req) {
  const token = parseCookies(req).session;
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
    https.get(url, { headers: { 'User-Agent': 'mise/1.0' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpsPost(hostname, urlPath, data, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const isJson = typeof data === 'string';
    const body = isJson ? data : new URLSearchParams(data).toString();
    const contentType = isJson ? 'application/json' : 'application/x-www-form-urlencoded';
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body), ...extraHeaders }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function serveStatic(res, filename) {
  const filePath = path.join(PUBLIC_DIR, filename);
  if (!fs.existsSync(filePath)) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
  res.end(fs.readFileSync(filePath));
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  try {
    if (pathname === '/auth/google') {
      const state = crypto.randomBytes(16).toString('hex');
      setCookie(res, 'oauth_state', state, { maxAge: 600 });
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: `${BASE_URL}/auth/google/callback`,
        response_type: 'code', scope: 'openid email profile', state,
      });
      return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    }

    if (pathname === '/auth/google/callback') {
      const code = url.searchParams.get('code');
      if (!code || !GOOGLE_CLIENT_ID) return redirect(res, '/?error=auth_failed');
      try {
        const tokens = await httpsPost('oauth2.googleapis.com', '/token', {
          code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: `${BASE_URL}/auth/google/callback`, grant_type: 'authorization_code',
        });
        if (!tokens.access_token) throw new Error('No access token: ' + JSON.stringify(tokens));
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
      const token = parseCookies(req).session;
      if (token) db.deleteSession(token);
      clearCookie(res, 'session');
      return redirect(res, '/');
    }

    if (pathname === '/auth/me') {
      const user = getSession(req);
      if (!user) return json(res, { user: null });
      return json(res, { user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar } });
    }

    // Fetch URL content for recipe import
    if (pathname === '/api/fetch-url' && req.method === 'POST') {
      const user = getSession(req);
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      const body = await parseBody(req);
      if (!body.url) return json(res, { error: 'No URL' }, 400);
      try {
        const urlObj = new URL(body.url);
        const isHttps = urlObj.protocol === 'https:';
        const lib = isHttps ? https : http;
        const text = await new Promise((resolve, reject) => {
          const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; recipe-importer/1.0)' } };
          lib.get(options, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
          }).on('error', reject);
        });
        // Strip HTML tags, limit to 8000 chars
        const stripped = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().substring(0, 8000);
        return json(res, { text: stripped });
      } catch(e) {
        console.error('URL fetch error:', e.message);
        return json(res, { error: 'Could not fetch URL' }, 500);
      }
    }

    // Gemini API proxy
    if (pathname === '/api/claude' && req.method === 'POST') {
      const user = getSession(req);
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      const GEMINI_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_KEY) return json(res, { error: 'GEMINI_API_KEY not configured on server' }, 500);
      const body = await parseBody(req);
      try {
        const prompt = (body.system ? body.system + '\n\n' : '') + (typeof body.content === 'string' ? body.content : JSON.stringify(body.content));
        const payload = JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 2000, temperature: 0.2 }
        });
        const result = await httpsPost(
          'generativelanguage.googleapis.com',
          `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
          payload
        );
        console.log('Gemini result:', JSON.stringify(result).substring(0, 500));
        const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        console.log('Gemini text:', text.substring(0, 200));
        return json(res, { text });
      } catch(e) {
        console.error('Gemini proxy error:', e.message);
        return json(res, { error: 'Gemini API failed' }, 500);
      }
    }

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

    if (pathname === '/share') {
      const p = new URLSearchParams({ shared_url: url.searchParams.get('url')||'', shared_text: url.searchParams.get('text')||'' });
      return redirect(res, `/?${p}`);
    }

    if (pathname === '/' || pathname === '/index.html') return serveStatic(res, 'index.html');
    if (!serveStatic(res, pathname)) serveStatic(res, 'index.html');

  } catch(e) {
    console.error('Request error:', e);
    res.writeHead(500); res.end('Error: ' + e.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mise en Place running on port ${PORT}`);
  console.log(`Public dir: ${PUBLIC_DIR}`);
  console.log(`Google auth: ${GOOGLE_CLIENT_ID ? 'configured' : 'NOT SET'}`);
});
