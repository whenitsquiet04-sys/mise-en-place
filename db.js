// Pure Node.js JSON file database — no native dependencies needed
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  || process.env.DATA_DIR
  || path.join(__dirname, 'data');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_FILE = path.join(DB_DIR, 'mise.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) { console.error('DB load error:', e); }
  return { users: {}, sessions: {}, data: {} };
}

function saveDB(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db), 'utf8'); }
  catch(e) { console.error('DB save error:', e); }
}

let _db = loadDB();

// Clean expired sessions
const now = Math.floor(Date.now()/1000);
Object.keys(_db.sessions || {}).forEach(t => { if (_db.sessions[t].expires_at < now) delete _db.sessions[t]; });
saveDB(_db);

const db = {
  upsertUser(id, email, name, avatar) {
    _db = loadDB(); _db.users[id] = { id, email, name, avatar }; saveDB(_db); return _db.users[id];
  },
  getUser(id) { _db = loadDB(); return _db.users[id] || null; },
  createSession(userId) {
    _db = loadDB();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now()/1000) + (60*60*24*30);
    if (!_db.sessions) _db.sessions = {};
    _db.sessions[token] = { token, user_id: userId, expires_at: expiresAt };
    saveDB(_db); return token;
  },
  getSession(token) {
    _db = loadDB();
    const session = (_db.sessions || {})[token];
    if (!session) return null;
    if (session.expires_at < Math.floor(Date.now()/1000)) { delete _db.sessions[token]; saveDB(_db); return null; }
    return _db.users[session.user_id] || null;
  },
  deleteSession(token) { _db = loadDB(); if (_db.sessions) delete _db.sessions[token]; saveDB(_db); },
  getData(userId, resource) { _db = loadDB(); return ((_db.data || {})[userId] || {})[resource] || null; },
  setData(userId, resource, data) {
    _db = loadDB();
    if (!_db.data) _db.data = {};
    if (!_db.data[userId]) _db.data[userId] = {};
    _db.data[userId][resource] = data; saveDB(_db);
  },
};

module.exports = db;
