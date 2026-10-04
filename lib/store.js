// 数据层：用户、房间（含 ACL）、消息、私聊、举报、禁言、审计日志、文件
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword } = require('./auth');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

const AUDIT_LIMIT = 2000;
const MESSAGE_LIMIT = 1000;      // 每房间保留上限
const DM_LIMIT = 1000;           // 每个会话保留上限
const ALLOWED_MIME = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

let db = {
  users: [],       // {id, username, pass, role, status, mutedUntil, createdAt, approvedAt, approvedBy}
  rooms: [],       // {id, name, type:'public'|'private', ownerId, members:[userId], announce, createdAt}
  messages: {},    // roomId -> [ {...} ]
  dms: {},         // convKey -> [ {id, fromId, toId, text, file, ts, recalled, recalledBy, readAt} ]
  blocks: [],      // {userId, blockedId, ts}
  reports: [],     // {id, kind:'room'|'dm', messageId, roomId, convKey, reporterId, reason, status, ...}
  audit: [],       // {id, ts, actorId, actorName, action, target, detail}
  mutes: [],       // {userId, roomId|null, until, by, reason, ts}
};

/** 私聊会话 key：双方 id 排序拼接，保证 A→B 与 B→A 落在同一会话 */
function convKey(a, b) {
  return [a, b].sort().join(':');
}

/** 从会话 key 解析出双方 id */
function convMembers(key) {
  return String(key).split(':');
}

/** 判断用户是否属于该会话 */
function inConv(key, userId) {
  return convMembers(key).includes(userId);
}

/** 取会话中的对方 id */
function peerOf(key, userId) {
  const [a, b] = convMembers(key);
  return a === userId ? b : a;
}

// ---------- 初始化与持久化 ----------
function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function load() {
  ensure();
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = { ...db, ...parsed };
    } catch (e) {
      console.error('[store] 读取失败，使用空库:', e.message);
    }
  }
  // 首次运行：创建默认房间
  if (!db.rooms.length) {
    const now = Date.now();
    for (const name of ['大厅', '技术', '闲聊']) {
      db.rooms.push({
        id: crypto.randomUUID(), name, type: 'public',
        ownerId: null, members: [], announce: '', createdAt: now,
      });
    }
  }
  for (const r of db.rooms) if (!Array.isArray(db.messages[r.id])) db.messages[r.id] = [];
  // 兼容旧库：补齐私聊相关字段
  if (!db.dms || typeof db.dms !== 'object') db.dms = {};
  if (!Array.isArray(db.blocks)) db.blocks = [];
  save();
}

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    ensure();
    fs.writeFile(DB_FILE, JSON.stringify(db), (err) => {
      if (err) console.error('[store] 写入失败:', err.message);
    });
  }, 250);
}

// ---------- 用户 ----------
const findUserByName = (username) =>
  db.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
const findUserById = (id) => db.users.find((u) => u.id === id);

/** 剔除敏感字段，用于返回给前端 */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, role: u.role, status: u.status,
    mutedUntil: u.mutedUntil || 0, createdAt: u.createdAt, approvedAt: u.approvedAt || null,
  };
}

function createUser({ username, password, role = 'user', status = 'pending', actor = null }) {
  const user = {
    id: crypto.randomUUID(),
    username: String(username).trim(),
    pass: hashPassword(password),
    role,
    status,                      // pending | active | banned
    mutedUntil: 0,
    createdAt: Date.now(),
    approvedAt: status === 'active' ? Date.now() : null,
    approvedBy: status === 'active' ? (actor ? actor.id : null) : null,
  };
  db.users.push(user);
  save();
  return user;
}

/** 系统首个用户自动成为管理员并激活 */
function isFirstUser() {
  return db.users.length === 0;
}

// ---------- 房间 ----------
const findRoom = (id) => db.rooms.find((r) => r.id === id);
const findRoomByName = (name) =>
  db.rooms.find((r) => r.name.toLowerCase() === String(name).toLowerCase());

/** 用户能否进入某房间 */
function canEnterRoom(user, room) {
  if (!room) return false;
  if (user.role === 'admin') return true;        // 管理员可进所有房间
  if (room.type === 'public') return true;
  return Array.isArray(room.members) && room.members.includes(user.id);
}

function createRoom({ name, type = 'public', ownerId = null, actor = null }) {
  const room = {
    id: crypto.randomUUID(), name: String(name).trim(), type,
    ownerId, members: [], announce: '', createdAt: Date.now(),
  };
  db.rooms.push(room);
  db.messages[room.id] = [];
  save();
  return room;
}

// ---------- 消息 ----------
function addMessage(roomId, user, text) {
  const rec = {
    id: crypto.randomUUID(), userId: user.id, nick: user.username,
    text, ts: Date.now(), recalled: false, recalledBy: null,
  };
  if (!db.messages[roomId]) db.messages[roomId] = [];
  db.messages[roomId].push(rec);
  if (db.messages[roomId].length > MESSAGE_LIMIT) {
    db.messages[roomId] = db.messages[roomId].slice(-MESSAGE_LIMIT);
  }
  save();
  return rec;
}

const findMessage = (roomId, messageId) =>
  (db.messages[roomId] || []).find((m) => m.id === messageId);

// ---------- 私聊 ----------
function getConv(key) {
  if (!db.dms[key]) db.dms[key] = [];
  return db.dms[key];
}

function addDm({ fromId, toId, text = '', file = null, nick }) {
  const key = convKey(fromId, toId);
  const rec = {
    id: crypto.randomUUID(), convKey: key,
    fromId, toId, nick,
    text, file, ts: Date.now(),
    recalled: false, recalledBy: null, readAt: null,
  };
  const list = getConv(key);
  list.push(rec);
  if (list.length > DM_LIMIT) db.dms[key] = list.slice(-DM_LIMIT);
  save();
  return rec;
}

const findDm = (key, messageId) =>
  (db.dms[key] || []).find((m) => m.id === messageId);

/** 标记某会话中发给我的消息为已读，返回被标记的数量 */
function markConvRead(key, userId) {
  const list = db.dms[key] || [];
  let n = 0;
  for (const m of list) {
    if (m.toId === userId && !m.readAt && !m.recalled) { m.readAt = Date.now(); n++; }
  }
  if (n) save();
  return n;
}

/** 未读数：userId 在每个会话中未读的消息数 */
function unreadCounts(userId) {
  const out = {};
  for (const [key, list] of Object.entries(db.dms)) {
    if (!inConv(key, userId)) continue;
    const n = list.filter((m) => m.toId === userId && !m.readAt && !m.recalled).length;
    if (n) out[key] = n;
  }
  return out;
}

/** 会话列表：返回与我相关的会话概要，按最后消息时间倒序 */
function listConvs(userId, q = '') {
  const needle = String(q || '').trim().toLowerCase();
  const out = [];
  for (const [key, list] of Object.entries(db.dms)) {
    if (!inConv(key, userId)) continue;
    const peerId = peerOf(key, userId);
    const peer = findUserById(peerId);
    if (!peer) continue;
    const last = list[list.length - 1];
    const unread = list.filter((m) => m.toId === userId && !m.readAt && !m.recalled).length;

    // 搜索命中：对方用户名 或 会话内任一消息内容
    if (needle) {
      const hitPeer = peer.username.toLowerCase().includes(needle);
      const hitMsg = list.some((m) => !m.recalled && m.text &&
        m.text.toLowerCase().includes(needle));
      if (!hitPeer && !hitMsg) continue;
    }
    out.push({
      convKey: key, peerId, peerName: peer.username,
      lastText: last ? (last.recalled ? '（已撤回）' : (last.text || (last.file ? '[文件]' : ''))) : '',
      lastTs: last ? last.ts : 0,
      unread,
      blocked: isBlocked(userId, peerId),
    });
  }
  return out.sort((a, b) => b.lastTs - a.lastTs);
}

// ---------- 拉黑 ----------
const isBlocked = (userId, blockedId) =>
  db.blocks.some((b) => b.userId === userId && b.blockedId === blockedId);

/** 任一方拉黑即不可互发 */
const blockBetween = (a, b) => isBlocked(a, b) || isBlocked(b, a);

function blockUser(userId, blockedId) {
  if (isBlocked(userId, blockedId)) return false;
  db.blocks.push({ userId, blockedId, ts: Date.now() });
  save();
  return true;
}

function unblockUser(userId, blockedId) {
  const before = db.blocks.length;
  db.blocks = db.blocks.filter((b) => !(b.userId === userId && b.blockedId === blockedId));
  if (db.blocks.length !== before) { save(); return true; }
  return false;
}

const listBlocked = (userId) =>
  db.blocks.filter((b) => b.userId === userId)
    .map((b) => ({ user: publicUser(findUserById(b.blockedId)), ts: b.ts }))
    .filter((x) => x.user);

// ---------- 文件 ----------
/** 保存上传文件到磁盘，返回文件元数据 */
function saveUpload({ buffer, originalName, mime }) {
  ensure();
  if (!ALLOWED_MIME.includes(mime)) {
    throw new Error('不支持的文件类型：' + mime);
  }
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`文件超过 ${MAX_FILE_SIZE / 1024 / 1024}MB 限制`);
  }
  const ext = path.extname(originalName).slice(0, 10);
  const id = crypto.randomUUID();
  const stored = id + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer);
  return {
    id, stored,
    name: String(originalName).slice(0, 120) || ('文件' + ext),
    size: buffer.length, mime,
  };
}

const uploadPath = (stored) => path.join(UPLOAD_DIR, path.basename(stored));

// ---------- 禁言 ----------
function activeMute(userId, roomId) {
  const now = Date.now();
  return db.mutes.find(
    (m) => m.userId === userId && m.until > now && (!m.roomId || m.roomId === roomId)
  ) || null;
}

function muteUser({ userId, roomId = null, minutes = 10, by, reason = '' }) {
  const rec = {
    userId, roomId, until: Date.now() + minutes * 60 * 1000,
    by: by ? by.id : null, byName: by ? by.username : 'system',
    reason, ts: Date.now(),
  };
  db.mutes.push(rec);
  const u = findUserById(userId);
  if (u && !roomId) u.mutedUntil = rec.until; // 全站禁言同步到用户对象
  save();
  return rec;
}

function unmuteUser(userId) {
  db.mutes = db.mutes.filter((m) => m.userId !== userId || m.until <= Date.now());
  const u = findUserById(userId);
  if (u) u.mutedUntil = 0;
  save();
}

// ---------- 举报 ----------
// kind: 'room' 房间消息 | 'dm' 私聊消息
function addReport({ messageId, roomId = null, convKey: ck = null, reporterId, reason, kind = 'room' }) {
  const rec = {
    id: crypto.randomUUID(), kind, messageId,
    roomId, convKey: ck, reporterId,
    reason: String(reason || '').slice(0, 500),
    status: 'open', handledBy: null, handledAt: null, createdAt: Date.now(),
  };
  db.reports.push(rec);
  save();
  return rec;
}

// ---------- 审计日志 ----------
function audit(actor, action, target = '', detail = '') {
  db.audit.push({
    id: crypto.randomUUID(), ts: Date.now(),
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.username : 'system',
    action, target, detail,
  });
  if (db.audit.length > AUDIT_LIMIT) db.audit = db.audit.slice(-AUDIT_LIMIT);
  save();
}

module.exports = {
  get db() { return db; },
  load, save,
  findUserByName, findUserById, publicUser, createUser, isFirstUser,
  findRoom, findRoomByName, canEnterRoom, createRoom,
  addMessage, findMessage,
  // 私聊
  convKey, convMembers, inConv, peerOf,
  addDm, findDm, markConvRead, unreadCounts, listConvs, getConv,
  isBlocked, blockBetween, blockUser, unblockUser, listBlocked,
  // 文件
  saveUpload, uploadPath, ALLOWED_MIME, MAX_FILE_SIZE,
  activeMute, muteUser, unmuteUser,
  addReport, audit,
  MESSAGE_LIMIT, DM_LIMIT, UPLOAD_DIR,
};
