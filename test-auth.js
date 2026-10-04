// 权限与认证的端到端测试
const BASE = 'http://localhost:3000';
const WebSocket = require('ws');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
}

function jar() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async req(method, url, body) {
      const res = await fetch(BASE + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of set) {
        const kv = c.split(';')[0];
        if (kv.startsWith('sid=')) cookie = kv === 'sid=' ? '' : kv;
      }
      let data = null;
      try { data = await res.json(); } catch {}
      return { status: res.status, data };
    },
  };
}

function wsConnect(cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:3000/ws', { headers: { Cookie: cookie } });
    const seen = [];
    ws.on('message', (d) => seen.push(JSON.parse(d)));
    ws.on('open', () => setTimeout(() => resolve({ ws, seen }), 250));
    ws.on('error', () => {});
    ws.on('unexpected-response', (_r, res) => resolve({ ws: null, status: res.statusCode }));
    setTimeout(() => resolve({ ws, seen }), 1500);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n===== 1. 注册与首个用户自动成为管理员 =====');
  const admin = jar();
  let r = await admin.req('POST', '/api/register', { username: 'admin', password: 'admin123' });
  check('首个用户注册成功', r.status === 200, JSON.stringify(r.data));
  check('首个用户自动成为 admin', r.data?.user?.role === 'admin', r.data?.user?.role);
  check('首个用户状态为 active', r.data?.user?.status === 'active');

  console.log('\n===== 2. 密码安全 =====');
  const dup = await admin.req('POST', '/api/register', { username: 'admin', password: 'other123' });
  check('重复用户名被拒绝', dup.status === 409, dup.data?.error);
  const short = await admin.req('POST', '/api/register', { username: 'abc', password: '123' });
  check('弱密码被拒绝', short.status === 400, short.data?.error);
  const badName = await admin.req('POST', '/api/register', { username: 'a b<script>', password: 'valid123' });
  check('非法用户名被拒绝', badName.status === 400, badName.data?.error);

  // store 采用防抖落盘，等待写入完成后再读磁盘
  await wait(500);
  const onDisk = JSON.parse(require('fs').readFileSync('/workspace/chat-app/data/store.json', 'utf8'));
  const stored = onDisk.users.find((u) => u.username === 'admin');
  check('密码为 scrypt 哈希存储', !!stored && stored.pass.startsWith('scrypt$'));
  check('明文密码未落盘', !JSON.stringify(onDisk).includes('admin123'));

  console.log('\n===== 3. 注册需审批 =====');
  const alice = jar();
  r = await alice.req('POST', '/api/register', { username: 'alice', password: 'alice123' });
  check('普通用户注册成功', r.status === 200);
  check('返回 pending 标记', r.data?.pending === true);

  r = await alice.req('POST', '/api/login', { username: 'alice', password: 'alice123' });
  check('未审批用户无法登录', r.status === 403, r.data?.error);

  const bob = jar();
  await bob.req('POST', '/api/register', { username: 'bob', password: 'bob12345' });
  const carol = jar();
  await carol.req('POST', '/api/register', { username: 'carol', password: 'carol123' });

  console.log('\n===== 4. 未登录拦截 =====');
  const anon = jar();
  r = await anon.req('GET', '/api/rooms');
  check('未登录访问 /api/rooms 返回 401', r.status === 401);
  r = await anon.req('GET', '/api/admin/users');
  check('未登录访问管理接口返回 401', r.status === 401);

  const anonWs = await wsConnect('sid=fake-invalid-token');
  check('无效会话的 WebSocket 握手被拒绝', anonWs.status === 401 || anonWs.ws === null);

  console.log('\n===== 5. 管理员审批 =====');
  const users = (await admin.req('GET', '/api/admin/users')).data.users;
  const aliceId = users.find((u) => u.username === 'alice').id;
  const bobId = users.find((u) => u.username === 'bob').id;
  r = await admin.req('POST', `/api/admin/users/${aliceId}/approve`);
  check('管理员审批通过 alice', r.status === 200);
  await admin.req('POST', `/api/admin/users/${bobId}/approve`);

  r = await alice.req('POST', '/api/login', { username: 'alice', password: 'alice123' });
  check('审批后 alice 可登录', r.status === 200);
  check('会话 Cookie 已下发', alice.cookie.startsWith('sid='));

  console.log('\n===== 6. 普通用户越权访问 =====');
  r = await alice.req('GET', '/api/admin/users');
  check('普通用户访问用户管理被拒 403', r.status === 403, r.data?.error);
  r = await alice.req('POST', '/api/rooms', { name: '越权房间' });
  check('普通用户创建房间被拒 403', r.status === 403, r.data?.error);
  r = await alice.req('GET', '/api/admin/audit');
  check('普通用户查看审计日志被拒 403', r.status === 403);

  console.log('\n===== 7. 消息收发与撤回 =====');
  const rooms = (await alice.req('GET', '/api/rooms')).data.rooms;
  const lobby = rooms.find((x) => x.name === '大厅');
  const c1 = await wsConnect(alice.cookie);
  c1.ws.send(JSON.stringify({ type: 'join', roomId: lobby.id }));
  await wait(300);

  c1.ws.send(JSON.stringify({ type: 'message', text: '大家好，我是 alice' }));
  await wait(300);
  let mine = c1.seen.filter((m) => m.type === 'message');
  check('消息发送成功', mine.length === 1 && mine[0].text === '大家好，我是 alice');

  const msgId = mine[0].id;
  c1.ws.send(JSON.stringify({ type: 'recall', messageId: msgId }));
  await wait(300);
  check('撤回自己的消息成功', c1.seen.some((m) => m.type === 'recalled' && m.messageId === msgId));

  console.log('\n===== 8. 撤回他人消息 =====');
  // bob 此时仍是普通用户，用来验证“不能撤回他人消息”
  const bobC = jar();
  await bobC.req('POST', '/api/login', { username: 'bob', password: 'bob12345' });

  // alice 发一条，管理员来撤回 —— 这才是需要审计的越权操作
  c1.ws.send(JSON.stringify({ type: 'message', text: '待管理员撤回的消息' }));
  await wait(300);
  const aliceMsg = c1.seen.filter((m) => m.type === 'message').pop();

  const bobWs0 = await wsConnect(bobC.cookie);
  bobWs0.ws.send(JSON.stringify({ type: 'join', roomId: lobby.id }));
  await wait(200);
  check('普通用户不能撤回他人消息',
    await (async () => {
      bobWs0.ws.send(JSON.stringify({ type: 'recall', messageId: aliceMsg.id }));
      await wait(300);
      return bobWs0.seen.some((m) => m.type === 'error' && m.message.includes('只能撤回自己'));
    })());

  const adminWs = await wsConnect(admin.cookie);
  adminWs.ws.send(JSON.stringify({ type: 'join', roomId: lobby.id }));
  await wait(200);
  adminWs.ws.send(JSON.stringify({ type: 'recall', messageId: aliceMsg.id }));
  await wait(300);
  check('管理员可撤回他人消息', adminWs.seen.some((m) => m.type === 'recalled' && m.messageId === aliceMsg.id));

  console.log('\n===== 9. 禁言 =====');
  r = await admin.req('POST', `/api/admin/users/${aliceId}/mute`, { minutes: 5, reason: '测试' });
  check('管理员禁言 alice', r.status === 200);

  const c2 = await wsConnect(alice.cookie);
  c2.ws.send(JSON.stringify({ type: 'join', roomId: lobby.id }));
  await wait(250);
  const before = c2.seen.filter((m) => m.type === 'message').length;
  c2.ws.send(JSON.stringify({ type: 'message', text: '禁言期间发言' }));
  await wait(300);
  const after = c2.seen.filter((m) => m.type === 'message').length;
  check('被禁言用户无法发言', before === after);
  check('返回禁言提示', c2.seen.some((m) => m.type === 'error' && m.message.includes('禁言')));

  await admin.req('POST', `/api/admin/users/${aliceId}/unmute`);
  c2.ws.send(JSON.stringify({ type: 'message', text: '解禁后发言' }));
  await wait(300);
  check('解禁后可正常发言', c2.seen.filter((m) => m.type === 'message').length > before);

  console.log('\n===== 10. 私有房间权限 =====');
  const modUser = (await admin.req('GET', '/api/admin/users')).data.users.find((u) => u.username === 'bob');
  await admin.req('POST', `/api/admin/users/${modUser.id}/role`, { role: 'mod' });
  // bobC 的会话已存在，权限变更即时生效，无需重新登录
  r = await bobC.req('GET', '/api/me');
  check('版主权限已生效（含 room.create）', r.data?.permissions?.includes('room.create'));

  r = await bobC.req('POST', '/api/rooms', { name: '机密室', type: 'private' });
  check('版主可创建私有房间', r.status === 200, JSON.stringify(r.data));
  const secretId = r.data?.room?.id;

  const aliceRooms = (await alice.req('GET', '/api/rooms')).data.rooms;
  check('普通用户看不到私有房间', !aliceRooms.some((x) => x.id === secretId));

  const c3 = await wsConnect(alice.cookie);
  c3.ws.send(JSON.stringify({ type: 'join', roomId: secretId }));
  await wait(300);
  check('普通用户直接进私有房间被拒', c3.seen.some((m) => m.type === 'error' && m.message.includes('权限')));

  await admin.req('POST', `/api/admin/rooms/${secretId}/members`, { userId: aliceId, member: true });
  const c4 = await wsConnect(alice.cookie);
  c4.ws.send(JSON.stringify({ type: 'join', roomId: secretId }));
  await wait(300);
  check('加入白名单后可进入私有房间', c4.seen.some((m) => m.type === 'init'));

  console.log('\n===== 11. 举报流程 =====');
  c4.ws.send(JSON.stringify({ type: 'message', text: '违规内容测试' }));
  await wait(300);
  const badMsg = c4.seen.filter((m) => m.type === 'message').pop();
  c4.ws.send(JSON.stringify({ type: 'report', messageId: badMsg.id, reason: '垃圾广告' }));
  await wait(300);
  check('举报提交成功', c4.seen.some((m) => m.type === 'reported'));

  const reports = (await admin.req('GET', '/api/admin/reports')).data.reports;
  check('管理员能看到举报', reports.length >= 1 && reports[0].reason === '垃圾广告');
  check('举报带出举报人', reports[0]?.reporterName === 'alice');

  r = await admin.req('POST', `/api/admin/reports/${reports[0].id}`, { status: 'resolved' });
  check('管理员可处理举报', r.status === 200);

  console.log('\n===== 12. 审计日志 =====');
  const logs = (await admin.req('GET', '/api/admin/audit')).data.logs;
  const actions = logs.map((l) => l.action);
  check('记录了登录', actions.includes('user.login'));
  check('记录了审批', actions.includes('user.approve'));
  check('记录了改角色', actions.includes('user.role'));
  check('记录了禁言', actions.includes('user.mute'));
  check('记录了撤回', actions.includes('message.recall'));
  check('记录含操作者', logs[0]?.actorName === 'admin');

  console.log('\n===== 13. 封禁与踢下线 =====');
  const carolId = (await admin.req('GET', '/api/admin/users')).data.users.find((u) => u.username === 'carol').id;
  r = await admin.req('POST', `/api/admin/users/${carolId}/status`, { status: 'banned' });
  check('封禁接口成功', r.status === 200);

  const adminSelf = (await admin.req('GET', '/api/admin/users')).data.users.find((u) => u.username === 'admin');
  r = await admin.req('POST', `/api/admin/users/${adminSelf.id}/status`, { status: 'banned' });
  check('不能封禁自己', r.status === 400, r.data?.error);
  r = await admin.req('POST', `/api/admin/users/${adminSelf.id}/role`, { role: 'user' });
  check('不能降级自己', r.status === 400, r.data?.error);

  console.log('\n===== 14. 登出 =====');
  r = await alice.req('POST', '/api/logout');
  check('登出成功', r.status === 200);
  r = await alice.req('GET', '/api/me');
  check('登出后会话失效', r.status === 401);

  console.log(`\n${'='.repeat(46)}\n通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(46)}`);
  [c1, c2, c3, c4, adminWs, bobWs0].forEach((c) => c && c.ws && c.ws.close());
  process.exit(fail ? 1 : 0);
})();
