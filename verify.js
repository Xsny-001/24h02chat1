/**
 * 独立包集成验证：完全按真实协议走一遍主要链路。
 * 用法：node verify.js   （需先启动服务，PORT 默认 3000）
 */
const WebSocket = require('ws');
const http = require('http');
const PORT = Number(process.env.PORT || 3000);

function req(method, p, body, cookie) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const headers = {};
    if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers }, (x) => {
      let s = ''; x.on('data', (c) => (s += c));
      x.on('end', () => res({ status: x.statusCode, body: s, headers: x.headers }));
    });
    if (d) r.write(d);
    r.end();
  });
}
const cookieOf = (r) => (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
const J = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  \u2713 ' + n)) : (fail++, console.log('  \u2717 ' + n)); };

/** 打开一个已登录的 WS，返回 { ws, inbox, waitFor } */
function openWs(cookie) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: cookie } });
  const inbox = [];
  ws.on('message', (m) => { try { inbox.push(JSON.parse(m)); } catch {} });
  const waitFor = (pred, ms = 4000) => new Promise((res) => {
    const hit = inbox.find(pred);
    if (hit) return res(hit);
    const started = Date.now();
    const iv = setInterval(() => {
      const f = inbox.find(pred);
      if (f) { clearInterval(iv); res(f); }
      else if (Date.now() - started > ms) { clearInterval(iv); res(null); }
    }, 50);
  });
  return { ws, inbox, waitFor };
}

(async () => {
  console.log('\n【1】首次注册自动成为管理员');
  const r1 = await req('POST', '/api/register', { username: 'boss', password: 'Passw0rd!', nickname: '老板' });
  const b1 = J(r1);
  ok('首个账号注册成功', r1.status === 200 && !!b1 && b1.ok);
  ok('角色为 admin', b1 && b1.user && b1.user.role === 'admin');
  ok('状态为 active（无需审批）', b1 && b1.user && b1.user.status === 'active');
  const acookie = cookieOf(await req('POST', '/api/login', { username: 'boss', password: 'Passw0rd!' }));
  ok('管理员可登录', !!acookie);

  console.log('\n【2】后续注册需要管理员审批');
  const r2 = await req('POST', '/api/register', { username: 'tom', password: 'Passw0rd!', nickname: '汤姆' });
  const b2 = J(r2);
  ok('普通账号注册进入待审批', r2.status === 200 && !!b2 && b2.pending === true);
  ok('待审批用户登录被拒（403）', (await req('POST', '/api/login', { username: 'tom', password: 'Passw0rd!' })).status === 403);
  const ulist = J(await req('GET', '/api/admin/users', null, acookie));
  const tom = ulist && (ulist.users || []).find((u) => u.username === 'tom');
  ok('后台可见待审批用户', !!tom);
  ok('审批操作成功', (await req('POST', `/api/admin/users/${tom.id}/approve`, {}, acookie)).status === 200);
  const tl = await req('POST', '/api/login', { username: 'tom', password: 'Passw0rd!' });
  ok('审批后可正常登录', tl.status === 200);
  const tcookie = cookieOf(tl);

  console.log('\n【3】权限拦截');
  ok('普通用户访问后台被拒（403）', (await req('GET', '/api/admin/users', null, tcookie)).status === 403);
  ok('未登录访问接口被拒（401）', (await req('GET', '/api/rooms')).status === 401);

  console.log('\n【4】WebSocket 握手鉴权');
  await new Promise((r) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    ws.on('open', () => { ok('未登录 WS 应被拒绝', false); ws.close(); r(); });
    ws.on('error', (e) => { ok('未登录 WS 被拒（401）', /401/.test(e.message)); r(); });
  });

  console.log('\n【5】房间实时消息');
  const rooms = J(await req('GET', '/api/rooms', null, tcookie));
  const roomId = rooms.rooms[0].id;
  const A = openWs(tcookie);
  await waitFor2(A, 'open');
  A.ws.send(JSON.stringify({ type: 'join', roomId }));
  const init = await A.waitFor((m) => m.type === 'init');
  ok('加入房间收到 init（含历史与成员）', !!init && Array.isArray(init.history));
  A.ws.send(JSON.stringify({ type: 'message', roomId, text: '集成验证消息' }));
  const got = await A.waitFor((m) => m.type === 'message' && m.text === '集成验证消息');
  ok('房间消息实时广播正常', !!got && got.nick);
  A.ws.close();

  console.log('\n【6】私聊链路（走 WebSocket）');
  const users = J(await req('GET', '/api/users', null, tcookie));
  const bossUser = users && (users.users || []).find((u) => u.username === 'boss');
  ok('可拉取用户列表用于发起私聊', !!bossUser);

  const B = openWs(tcookie);            // tom
  const C = openWs(acookie);            // boss
  await waitFor2(B, 'open');
  await waitFor2(C, 'open');
  await B.waitFor((m) => m.type === 'hello');
  await C.waitFor((m) => m.type === 'hello');
  B.ws.send(JSON.stringify({ type: 'dm:message', peerId: bossUser.id, text: '私聊验证' }));
  const dmGot = await C.waitFor((m) => m.type === 'dm:message' && m.text === '私聊验证');
  ok('私聊消息送达对方', !!dmGot);
  // 已读回执不是独立消息类型：对方打开会话时服务端自动标记并回推 dm:read
  C.ws.send(JSON.stringify({ type: 'dm:open', peerId: dmGot.fromId }));
  const readGot = await B.waitFor((m) => m.type === 'dm:read');
  ok('已读回执回传正常', !!readGot);

  B.ws.send(JSON.stringify({ type: 'dm:typing', peerId: bossUser.id, active: true }));
  const typingGot = await C.waitFor((m) => m.type === 'dm:typing' && m.active === true);
  ok('输入状态推送正常', !!typingGot && !!typingGot.convKey);

  const conv = J(await req('GET', '/api/dm/conversations', null, tcookie));
  ok('私聊进入会话列表', (conv.conversations || []).length > 0);
  ok('会话列表带未读/最后一条', !!(conv.conversations || [])[0]);
  B.ws.close(); C.ws.close();

  console.log('\n【7】数据落盘');
  await wait(700);
  const db = JSON.parse(require('fs').readFileSync(__dirname + '/data/store.json', 'utf8'));
  ok('用户已持久化', db.users.length >= 2);
  ok('房间消息已持久化', Object.values(db.messages || {}).some((a) => a.length > 0));
  ok('私聊已持久化', Object.keys(db.dms || {}).length > 0);
  ok('审计日志已记录', (db.audit || []).length > 0);

  console.log(`\n===== 通过 ${pass} 项，失败 ${fail} 项 =====\n`);
  process.exit(fail > 0 ? 1 : 0);
})();

function waitFor2(conn, evt) {
  return new Promise((res) => {
    if (conn.ws.readyState === 1) return res();
    conn.ws.once('open', res);
    setTimeout(res, 3000);
  });
}
