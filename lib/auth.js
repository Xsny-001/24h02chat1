// 认证与授权核心：密码哈希、会话管理、权限判定
const crypto = require('crypto');

// ---------- 密码哈希（scrypt，Node 内置，无需第三方依赖）----------
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = crypto.scryptSync(password, salt, expected.length, {
      N: +N, r: +r, p: +p,
    });
    // 定长比较，防时序攻击
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ---------- 角色与权限 ----------
// 角色等级：数值越大权限越高
const ROLE_LEVEL = { user: 1, mod: 2, admin: 3 };

// 权限点定义：每个权限声明所需的最低角色
const PERMISSIONS = {
  'chat.send': 'user',
  'chat.delete.own': 'user',
  'chat.report': 'user',
  'dm.send': 'user',
  'dm.block': 'user',
  'room.create': 'mod',
  'chat.delete.any': 'mod',
  'chat.recall.any': 'mod',
  'user.mute': 'mod',
  'chat.announce': 'mod',
  'report.handle': 'mod',
  'user.manage': 'admin',
  'user.approve': 'admin',
  'room.manage': 'admin',
  'audit.view': 'admin',
  'dm.view': 'admin',
};

const hasRole = (user, minRole) =>
  !!user && ROLE_LEVEL[user.role] >= ROLE_LEVEL[minRole];

/**
 * 判定用户是否拥有某权限
 * @param {object} user 用户对象，需含 role
 * @param {string} perm 权限点，如 'user.manage'
 */
function can(user, perm) {
  const need = PERMISSIONS[perm];
  if (!need) return false;
  return hasRole(user, need);
}

// ---------- 会话管理 ----------
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 天
const sessions = new Map(); // token -> { userId, createdAt, lastSeen }

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, createdAt: Date.now(), lastSeen: Date.now() });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  s.lastSeen = Date.now();
  return s;
}

function destroySession(token) {
  return sessions.delete(token);
}

function destroyUserSessions(userId) {
  let n = 0;
  for (const [token, s] of sessions) {
    if (s.userId === userId) { sessions.delete(token); n++; }
  }
  return n;
}

function sessionCount() {
  return sessions.size;
}

// ---------- Cookie 解析 ----------
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

module.exports = {
  hashPassword, verifyPassword,
  ROLE_LEVEL, PERMISSIONS, hasRole, can,
  createSession, getSession, destroySession, destroyUserSessions, sessionCount,
  parseCookies,
};
