const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const auth = require('./lib/auth');
const store = require('./lib/store');
const { buildRoutes, currentUser, COOKIE } = require('./lib/routes');

const PORT = process.env.PORT || 3000;
const HISTORY_LIMIT = 200;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// 允许路由层主动向某个用户推送通知（如禁言/解禁即时生效）
app.locals.notifyUser = (userId, payload) => {
  for (const c of clients.values()) {
    if (c.user.id === userId) send(c.ws, payload);
  }
};
// 允许路由层向私聊双方广播（如管理员撤回私聊消息）
app.locals.notifyConv = (key, payload) => {
  for (const c of clients.values()) {
    if (store.inConv(key, c.user.id)) send(c.ws, payload);
  }
};
app.use(buildRoutes());

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: store.db.rooms.length,
    users: store.db.users.length,
    online: clients.size,
    sessions: auth.sessionCount(),
    uptime: process.uptime(),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// clientId -> { ws, user, roomId }
const clients = new Map();

// ---------- 升级握手：必须先通过会话鉴权 ----------
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const token = auth.parseCookies(req.headers.cookie)[COOKIE];
  const session = auth.getSession(token);
  const user = session ? store.findUserById(session.userId) : null;

  if (!user || user.status !== 'active') {
    // 握手阶段直接拒绝，未登录者拿不到 socket
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
});

// ---------- 工具 ----------
function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function broadcast(roomId, payload, { except } = {}) {
  const raw = JSON.stringify(payload);
  for (const c of clients.values()) {
    if (c.roomId !== roomId) continue;
    if (except && c.ws === except) continue;
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
  }
}
function roomMembers(roomId) {
  return [...clients.values()].filter((c) => c.roomId === roomId).map((c) => c.user.username);
}
function pushPresence(roomId) {
  const users = roomMembers(roomId);
  broadcast(roomId, { type: 'presence', roomId, users, count: users.length });
}
function visibleRooms(user) {
  return store.db.rooms
    .filter((room) => store.canEnterRoom(user, room))
    .map((room) => ({
      id: room.id, name: room.name, type: room.type,
      online: [...clients.values()].filter((c) => c.roomId === room.id).length,
    }));
}
function pushRoomList() {
  for (const c of clients.values()) send(c.ws, { type: 'rooms', rooms: visibleRooms(c.user) });
}

/** 向某个用户的所有在线连接推送（同一账号可能多端登录） */
function sendToUser(userId, payload) {
  let n = 0;
  for (const c of clients.values()) {
    if (c.user.id === userId) { send(c.ws, payload); n++; }
  }
  return n;
}

/** 用户是否在线（用于私聊在线状态） */
function isOnline(userId) {
  for (const c of clients.values()) if (c.user.id === userId) return true;
  return false;
}

/** 推送未读私聊总数 */
function pushUnread(userId) {
  const counts = store.unreadCounts(userId);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  sendToUser(userId, { type: 'unread', counts, total });
}

const clean = (v, max = 2000) => String(v ?? '').replace(/\s+$/g, '').slice(0, max);

wss.on('connection', (ws, req, user) => {
  const client = { ws, user, roomId: null };
  clients.set(ws, client);
  console.log(`[ws] ${user.username}(${user.role}) 已连接，在线 ${clients.size}`);

  send(ws, {
    type: 'hello',
    user: store.publicUser(user),
    permissions: Object.entries(auth.PERMISSIONS)
      .filter(([, role]) => auth.hasRole(user, role)).map(([p]) => p),
    rooms: visibleRooms(user),
  });

  // 下发未读私聊统计
  pushUnread(user.id);
  // 通知有会话往来的用户：我已上线
  for (const c of clients.values()) {
    if (c.ws !== ws && store.db.dms[store.convKey(c.user.id, user.id)]) {
      send(c.ws, { type: 'dm:presence', userId: user.id, online: true });
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      return send(ws, { type: 'error', message: '消息格式错误' });
    }

    // 每处理一条消息都重新载入用户，确保角色/封禁变更即时生效
    const fresh = store.findUserById(user.id);
    if (!fresh || fresh.status !== 'active') {
      send(ws, { type: 'kicked', message: '账号状态已变更，连接即将关闭' });
      return ws.close();
    }
    client.user = user = fresh;

    switch (msg.type) {
      case 'join': {
        const room = store.findRoom(msg.roomId);
        if (!room) return send(ws, { type: 'error', message: '房间不存在' });
        if (!store.canEnterRoom(user, room)) {
          return send(ws, { type: 'error', message: '你没有权限进入该房间' });
        }

        const prev = store.findRoom(client.roomId);
        client.roomId = room.id;

        if (prev && prev.id !== room.id) {
          broadcast(prev.id, { type: 'system', roomId: prev.id, text: `${user.username} 离开了房间`, ts: Date.now() });
          pushPresence(prev.id);
        }

        send(ws, {
          type: 'init', roomId: room.id, roomName: room.name,
          announce: room.announce || '',
          users: roomMembers(room.id),
          history: (store.db.messages[room.id] || []).slice(-HISTORY_LIMIT),
          mute: store.activeMute(user.id, room.id)
            ? { until: store.activeMute(user.id, room.id).until } : null,
        });
        broadcast(room.id, { type: 'system', roomId: room.id, text: `${user.username} 加入了房间`, ts: Date.now() }, { except: ws });
        pushPresence(room.id);
        pushRoomList();
        break;
      }

      case 'message': {
        if (!client.roomId) return send(ws, { type: 'error', message: '请先加入房间' });
        if (!auth.can(user, 'chat.send')) return send(ws, { type: 'error', message: '你没有发言权限' });

        const mute = store.activeMute(user.id, client.roomId);
        if (mute) {
          const mins = Math.ceil((mute.until - Date.now()) / 60000);
          return send(ws, { type: 'error', message: `你已被禁言，剩余约 ${mins} 分钟` });
        }

        const text = clean(msg.text);
        if (!text) return;
        const rec = store.addMessage(client.roomId, user, text);
        broadcast(client.roomId, { type: 'message', ...rec });
        break;
      }

      case 'typing': {
        if (!client.roomId) return;
        broadcast(client.roomId, {
          type: 'typing', roomId: client.roomId, nick: user.username, active: !!msg.active,
        }, { except: ws });
        break;
      }

      // 撤回自己的消息
      case 'recall': {
        if (!client.roomId) return;
        const m = store.findMessage(client.roomId, msg.messageId);
        if (!m) return send(ws, { type: 'error', message: '消息不存在' });
        if (m.userId !== user.id && !auth.can(user, 'chat.recall.any')) {
          return send(ws, { type: 'error', message: '只能撤回自己的消息' });
        }
        if (m.recalled) return;
        m.recalled = true;
        m.recalledBy = user.username;
        m.text = '';
        store.save();
        // 仅记录“越权撤回他人消息”，自己撤回自己不必留痕
        if (m.userId !== user.id) {
          const room = store.findRoom(client.roomId);
          store.audit(user, 'message.recall', room ? room.name : client.roomId,
            `撤回 ${m.nick} 的消息`);
        }
        broadcast(client.roomId, { type: 'recalled', roomId: client.roomId, messageId: m.id, by: user.username });
        break;
      }

      // 举报消息
      case 'report': {
        if (!client.roomId) return;
        const m = store.findMessage(client.roomId, msg.messageId);
        if (!m) return send(ws, { type: 'error', message: '消息不存在' });
        const dup = store.db.reports.find(
          (x) => x.messageId === m.id && x.reporterId === user.id && x.status === 'open'
        );
        if (dup) return send(ws, { type: 'error', message: '你已举报过该消息' });

        store.addReport({
          messageId: m.id, roomId: client.roomId,
          reporterId: user.id, reason: clean(msg.reason, 500),
        });
        store.audit(user, 'report.create', client.roomId, m.id);
        send(ws, { type: 'reported', message: '举报已提交，管理员会尽快处理' });

        // 通知在线版主/管理员
        for (const c of clients.values()) {
          if (auth.can(c.user, 'report.handle')) {
            send(c.ws, { type: 'report:new', nick: user.username, roomId: client.roomId });
          }
        }
        break;
      }

      // ==================== 私聊 ====================
      // 打开会话：返回历史并标记已读
      case 'dm:open': {
        const peer = store.findUserById(msg.peerId);
        if (!peer) return send(ws, { type: 'error', message: '用户不存在' });
        if (peer.id === user.id) return send(ws, { type: 'error', message: '不能与自己私聊' });

        const key = store.convKey(user.id, peer.id);
        client.dmKey = key;

        const marked = store.markConvRead(key, user.id);
        send(ws, {
          type: 'dm:init', convKey: key, peer: store.publicUser(peer),
          online: isOnline(peer.id),
          blocked: store.isBlocked(user.id, peer.id),
          blockedMe: store.isBlocked(peer.id, user.id),
          history: store.getConv(key).slice(-200),
        });
        if (marked) {
          // 告知对方：他的消息已被读
          sendToUser(peer.id, { type: 'dm:read', convKey: key, by: user.id, count: marked });
          pushUnread(user.id);
        }
        break;
      }

      // 发送私聊消息
      case 'dm:message': {
        if (!auth.can(user, 'dm.send')) {
          return send(ws, { type: 'error', message: '你没有私聊权限' });
        }
        const peer = store.findUserById(msg.peerId);
        if (!peer) return send(ws, { type: 'error', message: '用户不存在' });
        if (peer.status !== 'active') return send(ws, { type: 'error', message: '对方账号不可用' });
        if (peer.id === user.id) return send(ws, { type: 'error', message: '不能给自己发私聊' });

        const mute = store.activeMute(user.id, null);
        if (mute) {
          const mins = Math.ceil((mute.until - Date.now()) / 60000);
          return send(ws, { type: 'error', message: `你已被禁言，剩余约 ${mins} 分钟` });
        }

        // 任一方拉黑即不可发送
        if (store.blockBetween(user.id, peer.id)) {
          return send(ws, { type: 'error', message: '无法发送：你们之间存在拉黑关系' });
        }

        const text = clean(msg.text);
        if (!text && !msg.file) return;

        const rec = store.addDm({
          fromId: user.id, toId: peer.id, nick: user.username,
          text, file: msg.file ? {
            id: String(msg.file.id || ''),
            stored: path.basename(String(msg.file.stored || '')),
            name: String(msg.file.name || '文件').slice(0, 120),
            size: Number(msg.file.size) || 0,
            mime: String(msg.file.mime || ''),
          } : null,
        });

        // 回给发送者（含自己的多端）
        sendToUser(user.id, { type: 'dm:message', ...rec });
        // 推给接收者
        if (peer.id !== user.id) sendToUser(peer.id, { type: 'dm:message', ...rec });
        pushUnread(peer.id);
        break;
      }

      // 私聊输入状态
      case 'dm:typing': {
        const peer = store.findUserById(msg.peerId);
        if (!peer) return;
        sendToUser(peer.id, {
          type: 'dm:typing',
          convKey: store.convKey(user.id, peer.id),
          fromId: user.id, nick: user.username, active: !!msg.active,
        });
        break;
      }

      // 撤回私聊消息
      case 'dm:recall': {
        const key = msg.convKey;
        if (!key || !store.inConv(key, user.id)) {
          return send(ws, { type: 'error', message: '无权操作该会话' });
        }
        const m = store.findDm(key, msg.messageId);
        if (!m) return send(ws, { type: 'error', message: '消息不存在' });
        if (m.fromId !== user.id && !auth.can(user, 'chat.recall.any')) {
          return send(ws, { type: 'error', message: '只能撤回自己的消息' });
        }
        if (m.recalled) return;

        m.recalled = true;
        m.recalledBy = user.username;
        m.text = '';
        store.save();
        if (m.fromId !== user.id) {
          store.audit(user, 'message.recall', '私聊', `撤回 ${m.nick} 的消息`);
        }
        const payload = { type: 'dm:recalled', convKey: key, messageId: m.id, by: user.username };
        sendToUser(m.fromId, payload);
        sendToUser(m.toId, payload);
        break;
      }

      // 举报私聊消息
      case 'dm:report': {
        const key = msg.convKey;
        if (!key || !store.inConv(key, user.id)) {
          return send(ws, { type: 'error', message: '无权操作该会话' });
        }
        const m = store.findDm(key, msg.messageId);
        if (!m) return send(ws, { type: 'error', message: '消息不存在' });
        if (m.fromId === user.id) {
          return send(ws, { type: 'error', message: '不能举报自己的消息' });
        }
        const dup = store.db.reports.find(
          (x) => x.messageId === m.id && x.reporterId === user.id && x.status === 'open'
        );
        if (dup) return send(ws, { type: 'error', message: '你已举报过该消息' });

        store.addReport({
          kind: 'dm', messageId: m.id, convKey: key,
          reporterId: user.id, reason: clean(msg.reason, 500),
        });
        store.audit(user, 'report.create', '私聊', `${m.nick} 的消息`);
        send(ws, { type: 'reported', message: '举报已提交，管理员会尽快处理' });
        // 通知在线版主/管理员
        for (const c of clients.values()) {
          if (auth.can(c.user, 'report.handle')) {
            send(c.ws, { type: 'report:new', nick: user.username, kind: 'dm' });
          }
        }
        break;
      }

      default:
        send(ws, { type: 'error', message: `未知消息类型: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (client.roomId) {
      broadcast(client.roomId, {
        type: 'system', roomId: client.roomId,
        text: `${user.username} 离开了房间`, ts: Date.now(),
      });
      pushPresence(client.roomId);
      pushRoomList();
    }
    // 该用户已完全离线时，通知所有与其有会话的人更新在线状态
    if (!isOnline(user.id)) {
      for (const c of clients.values()) {
        if (store.db.dms[store.convKey(c.user.id, user.id)]) {
          send(c.ws, { type: 'dm:presence', userId: user.id, online: false });
        }
      }
    }
    console.log(`[ws] ${user.username} 已断开，在线 ${clients.size}`);
  });

  ws.on('error', (err) => console.error('[ws] 异常:', err.message));
});

// 定期强制定下线：账号被封禁/删除时立刻断开其 WebSocket
setInterval(() => {
  for (const [ws, c] of clients) {
    const u = store.findUserById(c.user.id);
    if (!u || u.status !== 'active') {
      send(ws, { type: 'kicked', message: '账号状态已变更' });
      ws.close();
    }
  }
}, 5000).unref();

store.load();
server.listen(PORT, () => {
  console.log(`聊天服务已启动: http://localhost:${PORT}`);
  console.log(`WebSocket 端点:  ws://localhost:${PORT}/ws（需登录）`);
  if (store.isFirstUser()) {
    console.log('提示：尚无任何账号，首个注册的用户将自动成为管理员');
  }
});
