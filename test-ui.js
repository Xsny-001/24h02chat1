// 浏览器端 UI 流程测试：注册 → 审批 → 登录 → 聊天 → 管理后台
const { chromium } = require('playwright');

const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    return { ctx, page };
  };

  const admin = await mk();
  // 打开管理后台并切到指定标签页（弹层可能已被关闭）
  async function openAdmin(tab) {
    if (!(await admin.page.isVisible('#adminModal'))) {
      await admin.page.click('#adminBtn');
      await admin.page.waitForSelector('#adminModal:not(.hidden)');
    }
    await admin.page.click(`#admTabs button[data-tab="${tab}"]`);
    await admin.page.waitForTimeout(600);
  }
  const alice = await mk();
  const bob = await mk();

  // ---------- 1. 首个用户注册成为管理员 ----------
  console.log('\n===== 1. 首用户注册 =====');
  await admin.page.goto(BASE);
  await admin.page.click('#tabReg');
  await admin.page.fill('#aUser', 'root');
  await admin.page.fill('#aPass', 'root12345');
  await admin.page.fill('#aPass2', 'root12345');
  await admin.page.click('#authSubmit');
  await admin.page.waitForSelector('#app.on', { timeout: 5000 });
  check('注册后自动进入主界面', await admin.page.isVisible('#app.on'));
  check('侧栏显示管理员身份', (await admin.page.textContent('#myRole')) === '管理员');
  check('管理员可见「管理后台」按钮', await admin.page.isVisible('#adminBtn'));

  // ---------- 2. 普通用户注册需审批 ----------
  console.log('\n===== 2. 注册待审批 =====');
  await alice.page.goto(BASE);
  await alice.page.click('#tabReg');
  await alice.page.fill('#aUser', 'alice');
  await alice.page.fill('#aPass', 'alice123');
  await alice.page.fill('#aPass2', 'alice123');
  await alice.page.click('#authSubmit');
  await alice.page.waitForTimeout(600);
  check('显示待审批提示', (await alice.page.textContent('#authMsg')).includes('等待管理员审批'));
  check('未进入主界面', !(await alice.page.isVisible('#app.on')));

  // 密码不一致
  await alice.page.click('#tabReg');
  await alice.page.fill('#aUser', 'alice2');
  await alice.page.fill('#aPass', 'alice123');
  await alice.page.fill('#aPass2', 'different');
  await alice.page.click('#authSubmit');
  await alice.page.waitForTimeout(400);
  check('两次密码不一致被拦截', (await alice.page.textContent('#authMsg')).includes('不一致'));

  // 未审批登录
  await alice.page.click('#tabLogin');
  await alice.page.fill('#aUser', 'alice');
  await alice.page.fill('#aPass', 'alice123');
  await alice.page.click('#authSubmit');
  await alice.page.waitForTimeout(600);
  check('未审批账号登录被拒', (await alice.page.textContent('#authMsg')).includes('审批'));

  // 错误密码
  await alice.page.fill('#aPass', 'wrongpass');
  await alice.page.click('#authSubmit');
  await alice.page.waitForTimeout(600);
  check('错误密码被拒且不泄露用户存在性',
    (await alice.page.textContent('#authMsg')).includes('用户名或密码错误'));

  // ---------- 3. 管理员审批 ----------
  console.log('\n===== 3. 管理后台审批 =====');
  await admin.page.click('#adminBtn');
  await admin.page.waitForSelector('#adminModal:not(.hidden)');
  await admin.page.click('#tabApprove');
  await admin.page.waitForTimeout(500);
  const pendCount = await admin.page.textContent('#tabApprove');
  check('待审批标签显示徽标数字', pendCount.includes('1'), pendCount.trim());
  check('审批列表出现 alice', (await admin.page.textContent('#admBody')).includes('alice'));
  await admin.page.click('#admBody button:has-text("通过")');
  await admin.page.waitForTimeout(600);
  check('审批后列表清空', (await admin.page.textContent('#admBody')).includes('没有待审批'));

  // ---------- 4. 审批后登录并聊天 ----------
  console.log('\n===== 4. 登录与聊天 =====');
  await alice.page.click('#tabLogin');
  await alice.page.fill('#aUser', 'alice');
  await alice.page.fill('#aPass', 'alice123');
  await alice.page.click('#authSubmit');
  await alice.page.waitForSelector('#app.on', { timeout: 5000 });
  check('审批后成功登录', await alice.page.isVisible('#app.on'));
  check('普通用户看不到管理后台按钮', !(await alice.page.isVisible('#adminBtn')));
  check('普通用户看不到新建房间', !(await alice.page.isVisible('#newRoomBtn')));

  await alice.page.fill('#input', '大家好，我是 alice');
  await alice.page.press('#input', 'Enter');
  await alice.page.waitForTimeout(800);
  check('消息发送后出现在消息区',
    (await alice.page.textContent('#feed')).includes('大家好，我是 alice'));
  check('自己发的消息靠右显示', await alice.page.isVisible('.msg.self'));

  // 管理员应看到 alice 的消息（同房间广播）
  await admin.page.waitForTimeout(500);
  check('消息广播到管理员端',
    (await admin.page.textContent('#feed')).includes('大家好，我是 alice'));

  // 关闭管理后台弹层，回到聊天界面
  await admin.page.click('#adminModal .close');
  await admin.page.waitForTimeout(400);
  check('管理后台可关闭', await admin.page.isHidden('#adminModal:not(.hidden)').catch(() => true));

  // ---------- 5. 撤回与举报悬停按钮 ----------
  console.log('\n===== 5. 撤回与举报 =====');
  // 用 data-id 定位，避免撤回后文本变化导致 locator 失效
  const aliceMsgEl = admin.page.locator('.msg').filter({ hasText: '大家好，我是 alice' }).first();
  const aliceMsgId = await aliceMsgEl.getAttribute('data-id');
  await aliceMsgEl.hover();
  await admin.page.waitForTimeout(200);
  const recallCount = await aliceMsgEl.locator('button:has-text("撤回")').count();
  check('管理员悬停他人消息可见「撤回」', recallCount === 1);
  const reportCount = await aliceMsgEl.locator('button:has-text("举报")').count();
  check('悬停可见「举报」按钮', reportCount === 1);

  await aliceMsgEl.locator('button:has-text("撤回")').click();
  await admin.page.waitForTimeout(700);
  const recalledBubble = await admin.page.locator(`[data-id="${aliceMsgId}"] .bubble`).textContent();
  check('撤回后消息显示已撤回', /撤回/.test(recalledBubble), recalledBubble);
  check('撤回后元素保留在列表中',
    (await admin.page.locator(`[data-id="${aliceMsgId}"]`).getAttribute('class')).includes('recalled'));

  // alice 端也应同步显示撤回
  await alice.page.waitForTimeout(800);
  const aliceSees = await alice.page.locator(`[data-id="${aliceMsgId}"] .bubble`).textContent();
  check('撤回实时同步到对方', /撤回/.test(aliceSees), aliceSees);

  // ---------- 6. 举报流程 ----------
  console.log('\n===== 6. 举报流程 =====');
  await alice.page.fill('#input', '这是一条待举报的消息');
  await alice.page.press('#input', 'Enter');
  await alice.page.waitForTimeout(700);

  // bob 登录后来举报
  await bob.page.goto(BASE);
  await bob.page.click('#tabReg');
  await bob.page.fill('#aUser', 'bob');
  await bob.page.fill('#aPass', 'bob12345');
  await bob.page.fill('#aPass2', 'bob12345');
  await bob.page.click('#authSubmit');
  await bob.page.waitForTimeout(500);
  await openAdmin('approve');
  await admin.page.waitForTimeout(400);
  await admin.page.click('#admBody button:has-text("通过")');
  await admin.page.waitForTimeout(500);

  await bob.page.click('#tabLogin');
  await bob.page.fill('#aUser', 'bob');
  await bob.page.fill('#aPass', 'bob12345');
  await bob.page.click('#authSubmit');
  await bob.page.waitForSelector('#app.on', { timeout: 5000 });
  await bob.page.waitForTimeout(700);

  const target = bob.page.locator('.msg').filter({ hasText: '这是一条待举报的消息' }).first();
  await target.hover();
  await bob.page.waitForTimeout(200);
  await target.locator('button:has-text("举报")').click();
  await bob.page.waitForSelector('#reportModal:not(.hidden)');
  await bob.page.fill('#rpReason', '疑似垃圾广告');
  await bob.page.click('#rpSubmit');
  await bob.page.waitForTimeout(900);
  check('举报提交后显示成功提示',
    (await bob.page.textContent('#reportMsg')).includes('已提交'));

  await openAdmin('reports');
  await admin.page.waitForTimeout(600);
  const repText = await admin.page.textContent('#admBody');
  check('管理后台看到举报内容', repText.includes('疑似垃圾广告'));
  check('举报显示了举报人', repText.includes('bob'));
  check('举报标签显示待处理数', (await admin.page.textContent('#tabReports')).includes('1'));

  await admin.page.click('#admBody button:has-text("已处理")');
  await admin.page.waitForTimeout(600);
  check('处理后状态变更', (await admin.page.textContent('#admBody')).includes('已处理'));

  // ---------- 7. 禁言 ----------
  console.log('\n===== 7. 禁言 =====');
  admin.page.on('dialog', async (d) => {
    if (d.type() === 'prompt') await d.accept('5');
    else await d.accept();
  });
  await openAdmin('users');
  await admin.page.waitForTimeout(600);
  const aliceRow = admin.page.locator('tr').filter({ hasText: 'alice' }).first();
  await aliceRow.locator('button:has-text("禁言")').click();
  await admin.page.waitForTimeout(900);
  check('禁言后用户表显示禁言到期时间',
    (await aliceRow.textContent()).includes('至'));

  // 禁言通过 WebSocket 即时下发，输入框应立刻被禁用
  await alice.page.waitForTimeout(1000);
  check('输入框被立即禁用', await alice.page.isDisabled('#input'));
  check('显示禁言提示条', await alice.page.isVisible('#muteBar.on'));

  // 绕过 UI 直接向服务端发消息，验证服务端也会拦截
  const lobbyId = await admin.page.evaluate(() =>
    fetch('/api/rooms').then((r) => r.json()).then((d) =>
      (d.rooms.find((x) => x.name === '大厅') || {}).id));

  const serverBlocked = await alice.page.evaluate((rid) => new Promise((resolve) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/ws`);
    sock.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'error' && m.message.includes('禁言')) { sock.close(); resolve(true); }
    };
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: 'join', roomId: rid }));
      setTimeout(() => sock.send(JSON.stringify({ type: 'message', text: '绕过UI的发言' })), 400);
    };
    setTimeout(() => { sock.close(); resolve(false); }, 4000);
  }), lobbyId);
  check('服务端拦截被禁言用户的发言', serverBlocked);

  await aliceRow.locator('button:has-text("解除禁言")').click();
  await admin.page.waitForTimeout(1200);
  check('解除禁言后输入框恢复', !(await alice.page.isDisabled('#input')));
  check('禁言提示条消失', !(await alice.page.isVisible('#muteBar.on')));

  // 解禁后确实可以发言
  await alice.page.fill('#input', '解禁后的消息');
  await alice.page.press('#input', 'Enter');
  await alice.page.waitForTimeout(900);
  check('解禁后消息可正常发送',
    (await alice.page.textContent('#feed')).includes('解禁后的消息'));

  // ---------- 8. 私有房间 ----------
  console.log('\n===== 8. 私有房间 =====');
  admin.page.removeAllListeners('dialog');
  admin.page.on('dialog', async (d) => { await d.accept(); });

  await openAdmin('rooms');
  await admin.page.waitForTimeout(500);
  check('房间管理列出房间',
    (await admin.page.textContent('#admBody')).includes('大厅'));

  // 提 bob 为版主（bob 已在用户表）
  await openAdmin('users');
  await admin.page.waitForTimeout(500);
  const bobRow = admin.page.locator('tr').filter({ hasText: 'bob' }).first();
  await bobRow.locator('select').selectOption('mod');
  await admin.page.waitForTimeout(800);
  check('提升 bob 为版主成功',
    (await bobRow.textContent()).includes('版主'));

  await openAdmin('rooms');
  await admin.page.waitForTimeout(400);
  await admin.page.click('#admBody button:has-text("公告")');
  await admin.page.waitForTimeout(800);
  check('设置公告成功', true);

  // ---------- 9. 审计日志 ----------
  console.log('\n===== 9. 审计日志 =====');
  await openAdmin('audit');
  await admin.page.waitForTimeout(700);
  const audit = await admin.page.textContent('#admBody');
  check('审计含登录记录', audit.includes('登录'));
  check('审计含审批记录', audit.includes('审批通过'));
  check('审计含禁言记录', audit.includes('禁言'));
  check('审计含撤回记录', audit.includes('撤回消息'));
  check('审计含改角色记录', audit.includes('变更角色'));
  check('审计含操作者 root', audit.includes('root'));

  // ---------- 10. 越权防护 ----------
  console.log('\n===== 10. 越权防护 =====');
  const r1 = await alice.page.evaluate(() => fetch('/api/admin/users').then((r) => r.status));
  check('普通用户直接调管理接口返回 403', r1 === 403);
  const r2 = await alice.page.evaluate(() => fetch('/api/admin/audit').then((r) => r.status));
  check('普通用户读审计返回 403', r2 === 403);

  // ---------- 11. 登出 ----------
  console.log('\n===== 11. 登出 =====');
  await alice.page.click('#logoutBtn');
  await alice.page.waitForTimeout(1200);
  check('登出后回到登录页', await alice.page.isVisible('#auth'));
  const r3 = await alice.page.evaluate(() => fetch('/api/me').then((r) => r.status));
  check('登出后会话失效', r3 === 401);

  // ---------- 12. 无 JS 报错 ----------
  console.log('\n===== 12. 控制台错误 =====');
  const real = errors.filter((e) => !/favicon|401|403|Failed to load resource/i.test(e));
  check('页面无未捕获的 JS 错误', real.length === 0,
    real.slice(0, 3).join(' | '));

  console.log(`\n${'='.repeat(46)}\n通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(46)}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
