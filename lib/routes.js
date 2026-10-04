// HTTP 路由：认证、聊天室 API、管理后台 API
const express = require('express');
const path = require('path');
const fs = require('fs');
const auth = require('./auth');
const store = require('./store');

const COOKIE = 'sid';

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** 从请求中解析当前登录用户 */
function currentUser(req) {
  const token = auth.parseCookies(req.headers.cookie)[COOKIE];
  const s = auth.getSession(token);
  if (!s) return null;
  const u = store.findUserById(s.userId);
  if (!u || u.status !== 'active') return null;
  return u;
}

/** 需要登录 */
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '请先登录' });
  req.user = u;
  next();
}

/** 需要指定权限点 */
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '请先登录' });
    if (!auth.can(req.user, perm)) {
      return res.status(403).json({ error: `权限不足：需要 ${perm}` });
    }
    next();
  };
}

const s = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function buildRoutes() {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));

  // ==================== 认证 ====================
  r.post('/api/register', (req, res) => {
    const username = s(req.body.username, 20);
    const password = String(req.body.password || '');

    if (username.length < 2) return res.status(400).json({ error: '用户名至少 2 个字符' });
    if (!/^[\w\u4e00-\u9fa5-]+$/.test(username)) {
      return res.status(400).json({ error: '用户名只能包含中英文、数字、下划线或短横线' });
    }
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (store.findUserByName(username)) return res.status(409).json({ error: '该用户名已被注册' });

    // 首个注册用户自动成为管理员并直接激活，避免系统锁死无人可审批
    const first = store.isFirstUser();
    const user = store.createUser({
      username, password,
      role: first ? 'admin' : 'user',
      status: first ? 'active' : 'pending',
    });
    store.audit(user, first ? 'user.register.first-admin' : 'user.register',
      user.username, first ? '首个用户，自动成为管理员' : '待审批');

    if (first) {
      const token = auth.createSession(user.id);
      setSessionCookie(res, token);
      return res.json({ ok: true, user: store.publicUser(user), message: '注册成功，已自动成为管理员' });
    }
    res.json({ ok: true, pending: true, message: '注册成功，请等待管理员审批后登录' });
  });

  r.post('/api/login', (req, res) => {
    const username = s(req.body.username, 20);
    const password = String(req.body.password || '');
    const user = store.findUserByName(username);

    // 统一错误信息，不泄露用户是否存在
    if (!user || !auth.verifyPassword(password, user.pass)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (user.status === 'pending') {
      return res.status(403).json({ error: '账号尚未通过审批，请等待管理员处理' });
    }
    if (user.status === 'banned') {
      return res.status(403).json({ error: '账号已被封禁' });
    }

    const token = auth.createSession(user.id);
    setSessionCookie(res, token);
    store.audit(user, 'user.login', user.username);
    res.json({ ok: true, user: store.publicUser(user) });
  });

  r.post('/api/logout', (req, res) => {
    const token = auth.parseCookies(req.headers.cookie)[COOKIE];
    const u = currentUser(req);
    if (u) store.audit(u, 'user.logout', u.username);
    auth.destroySession(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.get('/api/me', (req, res) => {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: '未登录' });
    res.json({
      user: store.publicUser(u),
      permissions: Object.entries(auth.PERMISSIONS)
        .filter(([, role]) => auth.hasRole(u, role))
        .map(([perm]) => perm),
    });
  });

  // ==================== 房间 ====================
  r.get('/api/rooms', requireAuth, (req, res) => {
    const rooms = store.db.rooms
      .filter((room) => store.canEnterRoom(req.user, room))
      .map((room) => ({
        id: room.id, name: room.name, type: room.type,
        announce: room.announce || '',
        memberCount: room.members.length,
      }));
    res.json({ rooms });
  });

  r.post('/api/rooms', requireAuth, requirePerm('room.create'), (req, res) => {
    const name = s(req.body.name, 24);
    const type = req.body.type === 'private' ? 'private' : 'public';
    if (name.length < 1) return res.status(400).json({ error: '房间名不能为空' });
    if (store.findRoomByName(name)) return res.status(409).json({ error: '房间名已存在' });

    const room = store.createRoom({ name, type, ownerId: req.user.id, actor: req.user });
    if (type === 'private') room.members.push(req.user.id);
    store.audit(req.user, 'room.create', name, `类型=${type}`);
    res.json({ ok: true, room: { id: room.id, name: room.name, type: room.type } });
  });

  // ==================== 私聊 ====================
  // 会话列表（支持搜索：对方用户名或消息内容）
  r.get('/api/dm/conversations', requireAuth, (req, res) => {
    const convs = store.listConvs(req.user.id, req.query.q || '');
    res.json({ conversations: convs });
  });

  // 可发起私聊的用户列表（排除自己、待审批与被封禁账号）
  r.get('/api/users', requireAuth, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const users = store.db.users
      .filter((u) => u.id !== req.user.id && u.status === 'active')
      .filter((u) => !q || u.username.toLowerCase().includes(q))
      .map((u) => ({
        ...store.publicUser(u),
        blocked: store.isBlocked(req.user.id, u.id),
        blockedMe: store.isBlocked(u.id, req.user.id),
      }));
    res.json({ users });
  });

  // 打开与某人的会话：返回历史 + 对方信息 + 关系状态
  r.get('/api/dm/:peerId', requireAuth, (req, res) => {
    const peer = store.findUserById(req.params.peerId);
    if (!peer) return res.status(404).json({ error: '用户不存在' });
    if (peer.id === req.user.id) return res.status(400).json({ error: '不能与自己私聊' });

    const key = store.convKey(req.user.id, peer.id);
    const history = (store.getConv(key)).slice(-200);
    // 打开会话即视为已读
    const readCount = store.markConvRead(key, req.user.id);

    res.json({
      convKey: key,
      peer: store.publicUser(peer),
      history,
      readCount,
      blocked: store.isBlocked(req.user.id, peer.id),
      blockedMe: store.isBlocked(peer.id, req.user.id),
    });
  });

  // 拉黑 / 解除拉黑
  r.post('/api/dm/:peerId/block', requireAuth, (req, res) => {
    const peer = store.findUserById(req.params.peerId);
    if (!peer) return res.status(404).json({ error: '用户不存在' });
    if (peer.id === req.user.id) return res.status(400).json({ error: '不能拉黑自己' });

    const on = req.body.blocked !== false;
    if (on) {
      store.blockUser(req.user.id, peer.id);
      store.audit(req.user, 'dm.block', peer.username);
    } else {
      store.unblockUser(req.user.id, peer.id);
      store.audit(req.user, 'dm.unblock', peer.username);
    }
    res.json({ ok: true, blocked: on });
  });

  r.get('/api/dm/blocks/list', requireAuth, (req, res) => {
    res.json({ blocks: store.listBlocked(req.user.id) });
  });

  // 文件上传（私聊附件）
  r.post('/api/upload', requireAuth, express.raw({
    type: () => true, limit: store.MAX_FILE_SIZE + 1024,
  }), (req, res) => {
    if (!req.body || !req.body.length) return res.status(400).json({ error: '文件为空' });
    const originalName = decodeURIComponent(req.headers['x-file-name'] || 'file');
    const mime = String(req.headers['content-type'] || '').split(';')[0];

    try {
      const file = store.saveUpload({ buffer: req.body, originalName, mime });
      store.audit(req.user, 'file.upload', file.name, `${(file.size / 1024).toFixed(1)}KB`);
      res.json({ ok: true, file });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 附件下载/预览：仅会话双方与管理员可访问
  r.get('/api/files/:stored', requireAuth, (req, res) => {
    const stored = path.basename(String(req.params.stored));
    const full = store.uploadPath(stored);
    if (!fs.existsSync(full)) return res.status(404).json({ error: '文件不存在' });

    // 校验该文件确实属于当前用户可访问的消息
    const owners = [];
    for (const list of Object.values(store.db.dms)) {
      for (const m of list) {
        if (m.file && m.file.stored === stored) owners.push({ fromId: m.fromId, toId: m.toId });
      }
    }
    const isAdmin = auth.can(req.user, 'dm.view');
    const allowed = isAdmin || owners.some(
      (o) => o.fromId === req.user.id || o.toId === req.user.id
    );
    if (!allowed) return res.status(403).json({ error: '无权访问该文件' });

    res.sendFile(full, { headers: { 'Cache-Control': 'private, max-age=3600' } });
  });

  // ==================== 后台：私聊审计 ====================
  // 管理员可查看全部私聊，支持按用户名/内容搜索
  r.get('/api/admin/dms', requireAuth, requirePerm('dm.view'), (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const out = [];

    for (const [key, list] of Object.entries(store.db.dms)) {
      const [a, b] = store.convMembers(key);
      const ua = store.findUserById(a), ub = store.findUserById(b);
      const names = [ua ? ua.username : '(已注销)', ub ? ub.username : '(已注销)'];
      for (const m of list) {
        if (q) {
          const hay = (m.text || '').toLowerCase() + ' ' + names.join(' ').toLowerCase();
          if (!hay.includes(q)) continue;
        }
        out.push({
          ...m, convKey: key, members: names,
          fromName: (store.findUserById(m.fromId) || {}).username || '(已注销)',
          toName: (store.findUserById(m.toId) || {}).username || '(已注销)',
        });
      }
    }
    out.sort((x, y) => y.ts - x.ts);
    // 记录管理员查阅私聊的审计线索
    if (q) store.audit(req.user, 'dm.inspect', q, `搜索私聊内容，命中 ${out.length} 条`);
    res.json({ messages: out.slice(0, limit), total: out.length });
  });

  // 管理员撤回私聊消息
  r.post('/api/admin/dms/recall', requireAuth, requirePerm('chat.recall.any'), (req, res) => {
    const { convKey: key, messageId } = req.body;
    const m = store.findDm(key, messageId);
    if (!m) return res.status(404).json({ error: '消息不存在' });
    if (m.recalled) return res.status(400).json({ error: '该消息已被撤回' });
    m.recalled = true;
    m.recalledBy = req.user.username;
    m.text = '';
    store.save();
    store.audit(req.user, 'message.recall', '私聊', messageId);
    // 通知会话双方实时更新
    if (req.app.locals.notifyConv) {
      req.app.locals.notifyConv(key, {
        type: 'dm:recalled', convKey: key, messageId: m.id, by: req.user.username,
      });
    }
    res.json({ ok: true });
  });

  // ==================== 后台：用户管理 ====================
  r.get('/api/admin/users', requireAuth, requirePerm('user.manage'), (req, res) => {
    const users = store.db.users.map((u) => ({
      ...store.publicUser(u),
      mute: store.activeMute(u.id, null),
    }));
    res.json({ users });
  });

  r.post('/api/admin/users/:id/approve', requireAuth, requirePerm('user.approve'), (req, res) => {
    const u = store.findUserById(req.params.id);
    if (!u) return res.status(404).json({ error: '用户不存在' });
    if (u.status !== 'pending') return res.status(400).json({ error: '该用户无需审批' });
    u.status = 'active';
    u.approvedAt = Date.now();
    u.approvedBy = req.user.id;
    store.save();
    store.audit(req.user, 'user.approve', u.username);
    res.json({ ok: true });
  });

  r.post('/api/admin/users/:id/reject', requireAuth, requirePerm('user.approve'), (req, res) => {
    const u = store.findUserById(req.params.id);
    if (!u) return res.status(404).json({ error: '用户不存在' });
    store.db.users = store.db.users.filter((x) => x.id !== u.id);
    store.save();
    store.audit(req.user, 'user.reject', u.username, '注册申请被拒绝，账号已删除');
    res.json({ ok: true });
  });

  r.post('/api/admin/users/:id/role', requireAuth, requirePerm('user.manage'), (req, res) => {
    const u = store.findUserById(req.params.id);
    const role = req.body.role;
    if (!u) return res.status(404).json({ error: '用户不存在' });
    if (!['user', 'mod', 'admin'].includes(role)) return res.status(400).json({ error: '非法角色' });
    if (u.id === req.user.id) return res.status(400).json({ error: '不能修改自己的角色' });

    // 防止把最后一个管理员降级导致系统失控
    if (u.role === 'admin' && role !== 'admin') {
      const admins = store.db.users.filter((x) => x.role === 'admin' && x.status === 'active');
      if (admins.length <= 1) return res.status(400).json({ error: '不能降级最后一个管理员' });
    }
    const old = u.role;
    u.role = role;
    store.save();
    store.audit(req.user, 'user.role', u.username, `${old} -> ${role}`);
    res.json({ ok: true });
  });

  r.post('/api/admin/users/:id/status', requireAuth, requirePerm('user.manage'), (req, res) => {
    const u = store.findUserById(req.params.id);
    const status = req.body.status;
    if (!u) return res.status(404).json({ error: '用户不存在' });
    if (!['active', 'banned'].includes(status)) return res.status(400).json({ error: '非法状态' });
    if (u.id === req.user.id) return res.status(400).json({ error: '不能封禁自己' });
    if (u.role === 'admin' && status === 'banned') {
      const admins = store.db.users.filter((x) => x.role === 'admin' && x.status === 'active');
      if (admins.length <= 1) return res.status(400).json({ error: '不能封禁最后一个管理员' });
    }

    u.status = status;
    store.save();
    // 封禁后立即踢掉其所有会话
    if (status === 'banned') auth.destroyUserSessions(u.id);
    store.audit(req.user, 'user.status', u.username, status);
    res.json({ ok: true, kicked: status === 'banned' });
  });

  r.post('/api/admin/users/:id/mute', requireAuth, requirePerm('user.mute'), (req, res) => {
    const u = store.findUserById(req.params.id);
    if (!u) return res.status(404).json({ error: '用户不存在' });
    const minutes = Math.min(Math.max(parseInt(req.body.minutes, 10) || 10, 1), 60 * 24 * 7);
    const roomId = req.body.roomId || null;
    if (roomId && !store.findRoom(roomId)) return res.status(404).json({ error: '房间不存在' });

    store.muteUser({ userId: u.id, roomId, minutes, by: req.user, reason: s(req.body.reason, 100) });
    store.audit(req.user, 'user.mute', u.username, `${minutes} 分钟${roomId ? '（单房间）' : '（全站）'}`);
    if (req.app.locals.notifyUser) {
      const rec = store.activeMute(u.id, roomId);
      req.app.locals.notifyUser(u.id, {
        type: 'muted', until: rec ? rec.until : Date.now() + minutes * 60000,
      });
    }
    res.json({ ok: true });
  });

  r.post('/api/admin/users/:id/unmute', requireAuth, requirePerm('user.mute'), (req, res) => {
    const u = store.findUserById(req.params.id);
    if (!u) return res.status(404).json({ error: '用户不存在' });
    store.unmuteUser(u.id);
    store.audit(req.user, 'user.unmute', u.username);
    // 通知被解禁的用户即时恢复输入框
    if (req.app.locals.notifyUser) {
      req.app.locals.notifyUser(u.id, { type: 'unmuted' });
    }
    res.json({ ok: true });
  });

  // ==================== 后台：房间管理 ====================
  r.get('/api/admin/rooms', requireAuth, requirePerm('room.manage'), (req, res) => {
    res.json({
      rooms: store.db.rooms.map((room) => ({
        id: room.id, name: room.name, type: room.type,
        announce: room.announce || '',
        memberCount: room.members.length,
        messageCount: (store.db.messages[room.id] || []).length,
        createdAt: room.createdAt,
      })),
    });
  });

  r.delete('/api/admin/rooms/:id', requireAuth, requirePerm('room.manage'), (req, res) => {
    const room = store.findRoom(req.params.id);
    if (!room) return res.status(404).json({ error: '房间不存在' });
    if (store.db.rooms.length <= 1) return res.status(400).json({ error: '至少保留一个房间' });

    store.db.rooms = store.db.rooms.filter((x) => x.id !== room.id);
    delete store.db.messages[room.id];
    store.save();
    store.audit(req.user, 'room.delete', room.name);
    res.json({ ok: true });
  });

  r.post('/api/admin/rooms/:id/announce', requireAuth, requirePerm('chat.announce'), (req, res) => {
    const room = store.findRoom(req.params.id);
    if (!room) return res.status(404).json({ error: '房间不存在' });
    room.announce = s(req.body.text, 300);
    store.save();
    store.audit(req.user, 'room.announce', room.name, room.announce.slice(0, 60));
    res.json({ ok: true, announce: room.announce });
  });

  r.post('/api/admin/rooms/:id/members', requireAuth, requirePerm('room.manage'), (req, res) => {
    const room = store.findRoom(req.params.id);
    const u = store.findUserById(req.body.userId);
    if (!room) return res.status(404).json({ error: '房间不存在' });
    if (!u) return res.status(404).json({ error: '用户不存在' });
    const on = req.body.member !== false;

    room.members = room.members.filter((x) => x !== u.id);
    if (on) room.members.push(u.id);
    store.save();
    store.audit(req.user, on ? 'room.member.add' : 'room.member.remove', room.name, u.username);
    res.json({ ok: true });
  });

  // ==================== 后台：消息管理 ====================
  r.get('/api/admin/messages', requireAuth, requirePerm('chat.delete.any'), (req, res) => {
    const { roomId, q, limit = 100 } = req.query;
    let out = [];
    const rooms = roomId ? [store.findRoom(String(roomId))].filter(Boolean) : store.db.rooms;
    for (const room of rooms) {
      for (const m of store.db.messages[room.id] || []) {
        if (q && !m.text.includes(String(q))) continue;
        out.push({ ...m, roomId: room.id, roomName: room.name });
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    res.json({ messages: out.slice(0, Math.min(+limit || 100, 500)) });
  });

  r.post('/api/admin/messages/recall', requireAuth, requirePerm('chat.recall.any'), (req, res) => {
    const { roomId, messageId } = req.body;
    const room = store.findRoom(roomId);
    if (!room) return res.status(404).json({ error: '房间不存在' });
    const m = store.findMessage(roomId, messageId);
    if (!m) return res.status(404).json({ error: '消息不存在' });
    if (m.recalled) return res.status(400).json({ error: '该消息已被撤回' });

    m.recalled = true;
    m.recalledBy = req.user.username;
    m.text = '';
    store.save();
    store.audit(req.user, 'message.recall', room.name, messageId);
    res.json({ ok: true });
  });

  r.delete('/api/admin/messages', requireAuth, requirePerm('chat.delete.any'), (req, res) => {
    const { roomId, messageId } = req.body;
    const room = store.findRoom(roomId);
    if (!room) return res.status(404).json({ error: '房间不存在' });
    const before = (store.db.messages[roomId] || []).length;
    store.db.messages[roomId] = (store.db.messages[roomId] || []).filter((m) => m.id !== messageId);
    if (store.db.messages[roomId].length === before) {
      return res.status(404).json({ error: '消息不存在' });
    }
    store.save();
    store.audit(req.user, 'message.delete', room.name, messageId);
    res.json({ ok: true });
  });

  // ==================== 举报 ====================
  r.post('/api/reports', requireAuth, requirePerm('chat.report'), (req, res) => {
    const { roomId, messageId } = req.body;
    const room = store.findRoom(roomId);
    if (!room) return res.status(404).json({ error: '房间不存在' });
    if (!store.findMessage(roomId, messageId)) return res.status(404).json({ error: '消息不存在' });
    if (!store.canEnterRoom(req.user, room)) return res.status(403).json({ error: '无权访问该房间' });

    const dup = store.db.reports.find(
      (x) => x.messageId === messageId && x.reporterId === req.user.id && x.status === 'open'
    );
    if (dup) return res.status(409).json({ error: '你已举报过该消息，正在处理中' });

    const rec = store.addReport({
      messageId, roomId, reporterId: req.user.id, reason: s(req.body.reason, 500),
    });
    store.audit(req.user, 'report.create', room.name, rec.reason.slice(0, 60));
    res.json({ ok: true, id: rec.id });
  });

  r.get('/api/admin/reports', requireAuth, requirePerm('report.handle'), (req, res) => {
    const reports = store.db.reports
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((x) => {
        const isDm = x.kind === 'dm';
        const msg = isDm
          ? store.findDm(x.convKey || '', x.messageId)
          : store.findMessage(x.roomId, x.messageId);
        return {
          ...x,
          reporterName: (store.findUserById(x.reporterId) || {}).username || '(已注销)',
          roomName: isDm ? null : (store.findRoom(x.roomId) || {}).name || '(已删除)',
          convMembers: isDm
            ? store.convMembers(x.convKey || '').map(
                (id) => (store.findUserById(id) || {}).username || '(已注销)')
            : null,
          message: msg || null,
        };
      });
    res.json({ reports });
  });

  r.post('/api/admin/reports/:id', requireAuth, requirePerm('report.handle'), (req, res) => {
    const rep = store.db.reports.find((x) => x.id === req.params.id);
    if (!rep) return res.status(404).json({ error: '举报不存在' });
    const status = req.body.status;
    if (!['resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: '状态需为 resolved 或 dismissed' });
    }
    rep.status = status;
    rep.handledBy = req.user.username;
    rep.handledAt = Date.now();
    store.save();
    store.audit(req.user, 'report.handle', rep.id, status);
    res.json({ ok: true });
  });

  // ==================== 审计日志 ====================
  r.get('/api/admin/audit', requireAuth, requirePerm('audit.view'), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    res.json({ logs: store.db.audit.slice(-limit).reverse() });
  });

  return r;
}

module.exports = { buildRoutes, currentUser, requireAuth, requirePerm, COOKIE };
