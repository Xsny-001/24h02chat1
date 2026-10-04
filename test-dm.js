// 私聊功能的端到端测试
const WebSocket = require('ws');

const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function jar() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async req(method, url, body, raw) {
      const headers = {};
      if (!raw) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      if (raw) Object.assign(headers, raw.headers || {});
      const res = await fetch(BASE + url, {
        method, headers,
        body: raw ? raw.body : (body ? JSON.stringify(body) : undefined),
      });
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const kv = c.split(';')[0];
        if (kv.startsWith('sid=')) cookie = kv === 'sid=' ? '' : kv;
      }
      let data = null;
      const ct = res.headers.get('content-type') || '';
      try { data = ct.includes('json') ? await res.json() : await res.text(); } catch {}
      return { status: res.status, data, headers: res.headers };
    },
  };
}

function wsConnect(cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:3000/ws', { headers: { Cookie: cookie } });
    const seen = [];
    ws.on('message', (d) => seen.push(JSON.parse(d)));
    ws.on('open', () => setTimeout(() => resolve({ ws, seen }), 250));
    ws.on('unexpected-response', (_r, res) => resolve({ ws: null, status: res.statusCode }));
    setTimeout(() => resolve({ ws, seen }), 1500);
  });
}
const of = (c, type) => c.seen.filter((m) => m.type === type);

(async () => {
  // ---------- 准备账号 ----------
  const admin = jar();
  await admin.req('POST', '/api/register', { username: 'admin', password: 'admin12345' });

  const mk = async (name) => {
    const j = jar();
    await j.req('POST', '/api/register', { username: name, password: name + '12345' });
    return j;
  };
  const alice = await mk('alice');
  const bob = await mk('bob');
  const carol = await mk('carol');

  const users = (await admin.req('GET', '/api/admin/users')).data.users;
  for (const n of ['alice', 'bob', 'carol']) {
    const u = users.find((x) => x.username === n);
    await admin.req('POST', `/api/admin/users/${u.id}/approve`);
  }
  await alice.req('POST', '/api/login', { username: 'alice', password: 'alice12345' });
  await bob.req('POST', '/api/login', { username: 'bob', password: 'bob12345' });
  await carol.req('POST', '/api/login', { username: 'carol', password: 'carol12345' });

  const idOf = (n) => users.find((x) => x.username === n).id;
  const aliceId = idOf('alice'), bobId = idOf('bob'), carolId = idOf('carol');

  console.log('\n===== 1. 用户列表与权限 =====');
  let r = await alice.req('GET', '/api/users');
  check('可获取可私聊用户列表', r.status === 200 && r.data.users.length >= 2);
  check('列表中不含自己', !r.data.users.some((u) => u.id === aliceId));
  r = await alice.req('GET', '/api/dm/conversations');
  check('初始无会话', r.status === 200 && r.data.conversations.length === 0);

  console.log('\n===== 2. 发起私聊与实时投递 =====');
  const A = await wsConnect(alice.cookie);
  const B = await wsConnect(bob.cookie);
  const C = await wsConnect(carol.cookie);

  A.ws.send(JSON.stringify({ type: 'dm:open', peerId: bobId }));
  await wait(400);
  const init = of(A, 'dm:init')[0];
  check('打开会话返回 dm:init', !!init);
  check('返回会话 key', !!init?.convKey);
  check('返回对方信息', init?.peer?.username === 'bob');
  check('对方在线状态正确', init?.online === true);

  A.ws.send(JSON.stringify({ type: 'dm:message', peerId: bobId, text: '你好 Bob，这是私聊' }));
  await wait(400);
  check('发送者收到自己的消息回执',
    of(A, 'dm:message').some((m) => m.text === '你好 Bob，这是私聊'));
  check('接收者实时收到私聊',
    of(B, 'dm:message').some((m) => m.text === '你好 Bob，这是私聊'));

  const dmMsg = of(B, 'dm:message')[0];
  check('私聊消息带 convKey', !!dmMsg?.convKey);

  console.log('\n===== 3. 未读与已读回执 =====');
  let unread = of(B, 'unread').pop();
  check('接收者收到未读统计', unread && unread.total >= 1, `total=${unread?.total}`);

  B.ws.send(JSON.stringify({ type: 'dm:open', peerId: aliceId }));
  await wait(500);
  const initB = of(B, 'dm:init')[0];
  check('接收者打开会话后看到历史', initB?.history?.length >= 1);
  check('已读回执发给发送者',
    of(A, 'dm:read').some((m) => m.convKey === initB.convKey));

  console.log('\n===== 4. 双向会话 key 一致 =====');
  check('A→B 与 B→A 落在同一会话',
    init.convKey === initB.convKey, `${init.convKey} vs ${initB.convKey}`);

  console.log('\n===== 5. 会话列表与搜索 =====');
  B.ws.send(JSON.stringify({ type: 'dm:message', peerId: aliceId, text: '收到，我是 Bob' }));
  await wait(400);

  r = await alice.req('GET', '/api/dm/conversations');
  check('会话列表出现该会话', r.data.conversations.length === 1);
  check('会话带对方用户名', r.data.conversations[0].peerName === 'bob');
  check('会话带最后一条消息',
    r.data.conversations[0].lastText === '收到，我是 Bob', r.data.conversations[0].lastText);

  r = await alice.req('GET', '/api/dm/conversations?q=Bob');
  check('按对方用户名搜索命中', r.data.conversations.length === 1);
  r = await alice.req('GET', '/api/dm/conversations?q=不存在的关键词');
  check('搜索无结果时不返回会话', r.data.conversations.length === 0);
  r = await alice.req('GET', '/api/dm/conversations?q=私聊');
  check('按消息内容搜索命中', r.data.conversations.length === 1);

  console.log('\n===== 6. 会话隔离 =====');
  const carolConvs = (await carol.req('GET', '/api/dm/conversations')).data.conversations;
  check('无关用户看不到他人会话', carolConvs.length === 0);
  C.ws.send(JSON.stringify({ type: 'dm:open', peerId: aliceId }));
  await wait(400);
  const carolInit = of(C, 'dm:init')[0];
  check('无关用户打开他人会话时的历史为空', !carolInit?.history?.length);

  r = await carol.req('GET', `/api/dm/${aliceId}`);
  check('直接请求他人会话只返回自己的会话', r.data.history.length === 0);

  console.log('\n===== 7. 撤回 =====');
  const target = of(B, 'dm:message').find((m) => m.text === '收到，我是 Bob');
  B.ws.send(JSON.stringify({ type: 'dm:recall', convKey: initB.convKey, messageId: target.id }));
  await wait(400);
  check('撤回者收到 dm:recalled',
    of(B, 'dm:recalled').some((m) => m.messageId === target.id));
  check('对方同步收到 dm:recalled',
    of(A, 'dm:recalled').some((m) => m.messageId === target.id));

  // 对方不能撤回我的消息
  const m2 = of(A, 'dm:message').find((m) => m.text === '你好 Bob，这是私聊');
  B.ws.send(JSON.stringify({ type: 'dm:recall', convKey: initB.convKey, messageId: m2.id }));
  await wait(400);
  check('普通用户不能撤回对方私聊消息',
    of(B, 'error').some((m) => m.message.includes('只能撤回自己')));

  console.log('\n===== 8. 举报 =====');
  B.ws.send(JSON.stringify({ type: 'dm:report', convKey: initB.convKey, messageId: m2.id, reason: '私聊骚扰' }));
  await wait(400);
  check('私聊举报提交成功', of(B, 'reported').some((m) => m.message.includes('已提交')));
  check('不能举报自己的消息',
    await (async () => {
      A.ws.send(JSON.stringify({ type: 'dm:report', convKey: init.convKey, messageId: m2.id, reason: 'x' }));
      await wait(300);
      return of(A, 'error').some((m) => m.message.includes('不能举报自己'));
    })());

  const reports = (await admin.req('GET', '/api/admin/reports')).data.reports;
  check('管理员看到私聊举报', reports.length >= 1);
  check('举报标记为私聊类型', reports[0]?.kind === 'dm', reports[0]?.kind);

  console.log('\n===== 9. 拉黑 =====');
  r = await alice.req('POST', `/api/dm/${bobId}/block`, { blocked: true });
  check('拉黑成功', r.status === 200);
  await wait(200);

  A.ws.send(JSON.stringify({ type: 'dm:message', peerId: bobId, text: '拉黑后尝试发送' }));
  await wait(400);
  check('拉黑后无法发送',
    of(A, 'error').some((m) => m.message.includes('拉黑')));

  B.ws.send(JSON.stringify({ type: 'dm:message', peerId: aliceId, text: '反向尝试发送' }));
  await wait(400);
  check('被拉黑方也无法发送',
    of(B, 'error').some((m) => m.message.includes('拉黑')));

  r = await alice.req('GET', '/api/dm/blocks/list');
  check('黑名单列表可见', r.data.blocks.length === 1 && r.data.blocks[0].user.username === 'bob');

  r = await alice.req('POST', `/api/dm/${bobId}/block`, { blocked: false });
  check('解除拉黑成功', r.status === 200);
  await wait(200);
  A.ws.send(JSON.stringify({ type: 'dm:message', peerId: bobId, text: '解除拉黑后可以发' }));
  await wait(400);
  check('解除拉黑后可正常发送',
    of(A, 'dm:message').some((m) => m.text === '解除拉黑后可以发'));

  r = await alice.req('POST', `/api/dm/${aliceId}/block`, { blocked: true });
  check('不能拉黑自己', r.status === 400);

  console.log('\n===== 10. 文件上传 =====');
  const content = Buffer.from('这是一个测试文档的内容 Hello');
  r = await alice.req('POST', '/api/upload', null, {
    body: content,
    headers: {
      'Content-Type': 'text/plain',
      'X-File-Name': encodeURIComponent('测试文档.txt'),
    },
  });
  check('上传文本文件成功', r.status === 200 && r.data?.file?.id, JSON.stringify(r.data));
  const upFile = r.data?.file;

  r = await alice.req('POST', '/api/upload', null, {
    body: Buffer.from('bad'),
    headers: { 'Content-Type': 'application/x-msdownload', 'X-File-Name': 'evil.exe' },
  });
  check('拒绝不允许的文件类型', r.status === 400, r.data?.error);

  console.log('\n===== 11. 文件消息与访问控制 =====');
  A.ws.send(JSON.stringify({
    type: 'dm:message', peerId: bobId, text: '', file: upFile,
  }));
  await wait(400);
  const fileMsg = of(B, 'dm:message').find((m) => m.file);
  check('文件消息送达对方', !!fileMsg);
  check('文件消息带元数据', fileMsg?.file?.name === '测试文档.txt');

  r = await bob.req('GET', `/api/files/${upFile.stored}`);
  check('会话双方可下载文件', r.status === 200 && String(r.data).includes('测试文档'));

  r = await carol.req('GET', `/api/files/${upFile.stored}`);
  check('无关用户无法下载文件', r.status === 403, `status=${r.status}`);

  r = await admin.req('GET', `/api/files/${upFile.stored}`);
  check('管理员可下载文件', r.status === 200);

  console.log('\n===== 12. 管理员查看私聊 =====');
  r = await admin.req('GET', '/api/admin/dms');
  check('管理员可列出私聊', r.status === 200 && r.data.messages.length >= 1);
  check('私聊列表带双方姓名',
    r.data.messages[0]?.members?.includes('alice') && r.data.messages[0]?.members?.includes('bob'));

  r = await admin.req('GET', '/api/admin/dms?q=私聊');
  check('管理员可按内容搜索私聊', r.data.total >= 1);
  r = await admin.req('GET', '/api/admin/dms?q=完全不存在的内容xyz');
  check('搜索无结果时返回空', r.data.total === 0);

  r = await alice.req('GET', '/api/admin/dms');
  check('普通用户无法查看他人私聊', r.status === 403, `status=${r.status}`);

  console.log('\n===== 13. 管理员撤回私聊 =====');
  const rest = (await admin.req('GET', '/api/admin/dms?q=解除拉黑')).data.messages[0];
  if (rest) {
    r = await admin.req('POST', '/api/admin/dms/recall',
      { convKey: rest.convKey, messageId: rest.id });
    check('管理员可撤回私聊消息', r.status === 200);
    await wait(400);
    check('撤回实时通知到双方',
      of(A, 'dm:recalled').some((m) => m.messageId === rest.id) ||
      of(B, 'dm:recalled').some((m) => m.messageId === rest.id));
  } else {
    check('管理员可撤回私聊消息', false, '未找到目标消息');
  }

  console.log('\n===== 14. 在线状态 =====');
  check('打开会话时返回在线状态', typeof init.online === 'boolean');
  B.ws.close();
  await wait(600);
  check('对方下线时推送 dm:presence',
    of(A, 'dm:presence').some((m) => m.userId === bobId && m.online === false));

  console.log('\n===== 15. 禁言作用于私聊 =====');
  r = await admin.req('POST', `/api/admin/users/${carolId}/mute`, { minutes: 5 });
  check('禁言 carol', r.status === 200);
  await wait(400);
  C.ws.send(JSON.stringify({ type: 'dm:message', peerId: aliceId, text: '禁言期间私聊' }));
  await wait(400);
  check('被禁言用户无法发送私聊',
    of(C, 'error').some((m) => m.message.includes('禁言')));
  await admin.req('POST', `/api/admin/users/${carolId}/unmute`);

  console.log('\n===== 16. 边界情况 =====');
  A.ws.send(JSON.stringify({ type: 'dm:message', peerId: aliceId, text: '给自己发' }));
  await wait(300);
  check('不能给自己发私聊', of(A, 'error').some((m) => m.message.includes('不能给自己')));

  A.ws.send(JSON.stringify({ type: 'dm:message', peerId: 'no-such-user', text: 'x' }));
  await wait(300);
  check('不存在的用户被拒绝', of(A, 'error').some((m) => m.message.includes('用户不存在')));

  C.ws.send(JSON.stringify({ type: 'dm:recall', convKey: init.convKey, messageId: 'whatever' }));
  await wait(300);
  check('无权操作他人会话被拒',
    of(C, 'error').some((m) => m.message.includes('无权操作')));

  const anonWs = await wsConnect('sid=invalid');
  check('未登录无法建立 WebSocket', anonWs.status === 401 || anonWs.ws === null);

  console.log(`\n${'='.repeat(46)}\n通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(46)}`);
  [A, B, C].forEach((c) => c.ws && c.ws.close && c.ws.close());
  process.exit(fail ? 1 : 0);
})();
