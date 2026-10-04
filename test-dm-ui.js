// 浏览器端私聊 UI 测试
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
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    return { ctx, page };
  };

  const A = await mk();   // admin
  const B = await mk();   // bob
  const C = await mk();   // carol

  const login = async (page, user, pass) => {
    await page.goto(BASE);
    await page.click('#tabLogin');
    await page.fill('#aUser', user);
    await page.fill('#aPass', pass);
    await page.click('#authSubmit');
  };
  const reg = async (page, user, pass) => {
    await page.goto(BASE);
    await page.click('#tabReg');
    await page.fill('#aUser', user);
    await page.fill('#aPass', pass);
    await page.fill('#aPass2', pass);
    await page.click('#authSubmit');
  };

  // ---------- 准备 ----------
  console.log('\n===== 1. 管理员与两个用户 =====');
  await reg(A.page, 'admin', 'admin12345');
  await A.page.waitForSelector('#app.on', { timeout: 6000 });
  check('管理员进入主界面', await A.page.isVisible('#app.on'));

  await reg(B.page, 'bob', 'bob12345');
  await B.page.waitForTimeout(600);
  await reg(C.page, 'carol', 'carol12345');
  await C.page.waitForTimeout(600);

  // 审批
  await A.page.click('#adminBtn');
  await A.page.waitForSelector('#adminModal:not(.hidden)');
  await A.page.click('#admTabs button[data-tab="approve"]');
  await A.page.waitForTimeout(600);
  while (await A.page.locator('#admBody button:has-text("通过")').count() > 0) {
    await A.page.locator('#admBody button:has-text("通过")').first().click();
    await A.page.waitForTimeout(500);
  }
  await A.page.click('#adminModal .close');
  await A.page.waitForTimeout(300);

  await login(B.page, 'bob', 'bob12345');
  await B.page.waitForSelector('#app.on', { timeout: 6000 });
  await login(C.page, 'carol', 'carol12345');
  await C.page.waitForSelector('#app.on', { timeout: 6000 });
  check('三个账号均已登录', true);

  console.log('\n===== 2. 私聊侧栏 =====');
  check('存在私聊标签页', await B.page.isVisible('#tabDms'));
  await B.page.click('#tabDms');
  await B.page.waitForTimeout(500);
  check('切换到私聊面板', await B.page.isVisible('#paneDms'));
  check('房间面板已隐藏', await B.page.isHidden('#paneRooms'));
  check('初始提示为空会话', (await B.page.textContent('#convlist')).includes('暂无会话'));

  console.log('\n===== 3. 发起私聊 =====');
  await B.page.click('#newDmBtn');
  await B.page.waitForSelector('#pickUserModal:not(.hidden)');
  await B.page.waitForTimeout(600);
  const pickText = await B.page.textContent('#pickList');
  check('用户选择器列出其他用户', pickText.includes('carol') && pickText.includes('admin'));
  check('用户选择器不含自己', !pickText.includes('bob'));

  await B.page.fill('#pickSearch', 'carol');
  await B.page.waitForTimeout(600);
  const filtered = await B.page.textContent('#pickList');
  check('搜索过滤生效', filtered.includes('carol') && !filtered.includes('admin'));

  await B.page.locator('#pickList .conv').first().click();
  await B.page.waitForTimeout(900);
  check('打开会话后标题为对方用户名',
    (await B.page.textContent('#roomTitle')) === 'carol');
  check('显示对方在线状态',
    (await B.page.textContent('#dmPeerState')).includes('在线'));
  check('输入框提示为私聊对象',
    (await B.page.getAttribute('#input', 'placeholder')).includes('carol'));

  console.log('\n===== 4. 私聊实时收发 =====');
  await C.page.click('#tabDms');
  await C.page.waitForTimeout(400);
  await B.page.fill('#input', '你好 Carol，这是私聊测试');
  await B.page.press('#input', 'Enter');
  await C.page.waitForTimeout(1000);

  check('发送者看到自己的消息',
    (await B.page.textContent('#feed')).includes('你好 Carol，这是私聊测试'));
  check('发送者消息靠右', await B.page.isVisible('.msg.self'));

  // carol 应该收到未读徽标（未打开该会话）
  const badgeOn = await C.page.evaluate(() => {
    const b = document.getElementById('dmBadge');
    return b.classList.contains('on') ? b.textContent : null;
  });
  check('接收者未读徽标出现', badgeOn !== null && badgeOn !== '', `badge=${badgeOn}`);

  await C.page.locator('#convlist .conv').first().click();
  await C.page.waitForTimeout(900);
  check('接收者打开会话看到消息',
    (await C.page.textContent('#feed')).includes('你好 Carol，这是私聊测试'));
  check('接收者侧消息靠左', await C.page.isVisible('.msg:not(.self)'));

  console.log('\n===== 5. 已读回执 =====');
  await B.page.waitForTimeout(900);
  const readTags = await B.page.locator('.read-tag').allTextContents();
  check('发送者看到已读回执', readTags.some((t) => t === '已读'), readTags.join(','));

  console.log('\n===== 6. 正在输入 =====');
  await C.page.fill('#input', '正在输入的内容');
  await C.page.waitForTimeout(500);
  check('对方看到正在输入提示',
    (await B.page.textContent('#typing')).includes('carol'),
    await B.page.textContent('#typing'));
  await C.page.fill('#input', '');

  console.log('\n===== 7. 会话列表 =====');
  await C.page.fill('#input', '收到，我是 Carol');
  await C.page.press('#input', 'Enter');
  await B.page.waitForTimeout(1000);
  const convText = await B.page.textContent('#convlist');
  check('会话列表显示对方用户名', convText.includes('carol'));
  check('会话列表显示消息预览', convText.includes('收到，我是 Carol'));

  console.log('\n===== 8. 会话搜索 =====');
  await B.page.fill('#dmSearch', 'carol');
  await B.page.waitForTimeout(700);
  check('按用户名搜索命中', (await B.page.textContent('#convlist')).includes('carol'));
  await B.page.fill('#dmSearch', '不存在的会话xyz');
  await B.page.waitForTimeout(700);
  check('搜索无结果时提示为空',
    (await B.page.textContent('#convlist')).includes('暂无会话'));
  await B.page.fill('#dmSearch', '');
  await B.page.waitForTimeout(700);

  console.log('\n===== 9. 会话隔离 =====');
  await A.page.click('#tabDms');
  await A.page.waitForTimeout(600);
  check('无关用户看不到他人会话',
    (await A.page.textContent('#convlist')).includes('暂无会话'));

  console.log('\n===== 10. 撤回 =====');
  const targetMsg = C.page.locator('.msg').filter({ hasText: '收到，我是 Carol' }).first();
  const targetId = await targetMsg.getAttribute('data-id');
  await targetMsg.hover();
  await C.page.waitForTimeout(300);
  await targetMsg.locator('button:has-text("撤回")').click();
  await C.page.waitForTimeout(900);
  check('撤回者看到已撤回',
    /撤回/.test(await C.page.locator(`[data-id="${targetId}"] .bubble`).textContent()));
  check('对方同步看到已撤回',
    /撤回/.test(await B.page.locator(`[data-id="${targetId}"] .bubble`).textContent()));

  console.log('\n===== 11. 举报 =====');
  const bobMsg = B.page.locator('.msg').filter({ hasText: '你好 Carol' }).first();
  await bobMsg.hover();
  await C.page.waitForTimeout(200);
  // carol 侧应能看到对 bob 消息的举报按钮
  const carolTarget = C.page.locator('.msg').filter({ hasText: '你好 Carol' }).first();
  await carolTarget.hover();
  await C.page.waitForTimeout(300);
  await carolTarget.locator('button:has-text("举报")').click();
  await C.page.waitForSelector('#reportModal:not(.hidden)');
  check('私聊举报弹层标题正确',
    (await C.page.textContent('#reportTitle')).includes('私聊'));
  await C.page.fill('#rpReason', '私聊内容不当');
  await C.page.click('#rpSubmit');
  await C.page.waitForTimeout(1000);
  check('私聊举报提交成功',
    (await C.page.textContent('#reportMsg')).includes('已提交'));

  await A.page.click('#adminBtn');
  await A.page.waitForSelector('#adminModal:not(.hidden)');
  await A.page.click('#admTabs button[data-tab="reports"]');
  await A.page.waitForTimeout(800);
  const repText = await A.page.textContent('#admBody');
  check('后台看到私聊举报', repText.includes('私聊内容不当'));
  check('举报标注为私聊来源', repText.includes('私聊'));
  await A.page.click('#adminModal .close');
  await A.page.waitForTimeout(300);

  console.log('\n===== 12. 管理员私聊审计 =====');
  await A.page.click('#adminBtn');
  await A.page.waitForSelector('#adminModal:not(.hidden)');
  await A.page.click('#admTabs button[data-tab="dms"]');
  await A.page.waitForTimeout(900);
  const dmText = await A.page.textContent('#admBody');
  check('管理员可看到私聊内容', dmText.includes('你好 Carol'));
  check('私聊列表显示会话双方', dmText.includes('bob') && dmText.includes('carol'));

  await A.page.fill('#admBody input[placeholder*="搜索私聊"]', '你好 Carol');
  await A.page.locator('#admBody button:has-text("搜索")').click();
  await A.page.waitForTimeout(800);
  check('管理员可搜索私聊', (await A.page.textContent('#admBody')).includes('你好 Carol'));

  await A.page.fill('#admBody input[placeholder*="搜索私聊"]', '完全不存在xyz');
  await A.page.locator('#admBody button:has-text("搜索")').click();
  await A.page.waitForTimeout(800);
  check('搜索无结果时提示为空',
    (await A.page.textContent('#admBody')).includes('没有匹配'));
  await A.page.click('#adminModal .close');
  await A.page.waitForTimeout(300);

  console.log('\n===== 13. 拉黑 =====');
  await B.page.click('#peerMenuBtn');
  await B.page.waitForTimeout(400);
  await B.page.locator('.menu button:has-text("拉黑")').click();
  await B.page.waitForTimeout(1000);

  check('拉黑后输入框被禁用', await B.page.isDisabled('#input'));
  const bBlocks = await B.page.textContent('#blocklist');
  check('黑名单中出现对方', bBlocks.includes('carol'), bBlocks.trim());

  await C.page.fill('#input', '拉黑后尝试发送');
  await C.page.press('#input', 'Enter');
  await C.page.waitForTimeout(900);
  check('被拉黑方无法发送',
    (await C.page.textContent('#feed')).indexOf('拉黑后尝试发送') === -1);

  console.log('\n===== 14. 解除拉黑 =====');
  await B.page.locator('#blocklist button:has-text("解除")').click();
  await B.page.waitForTimeout(1000);
  check('解除后输入框恢复', !(await B.page.isDisabled('#input')));
  check('黑名单已清空',
    (await B.page.textContent('#blocklist')).includes('无'));

  await B.page.fill('#input', '解除拉黑后的消息');
  await B.page.press('#input', 'Enter');
  await C.page.waitForTimeout(1000);
  check('解除拉黑后可正常收发',
    (await C.page.textContent('#feed')).includes('解除拉黑后的消息'));

  console.log('\n===== 15. 文件发送 =====');
  await B.page.click('#peerMenuBtn');
  await B.page.waitForTimeout(300);
  await B.page.keyboard.press('Escape');
  await B.page.locator('body').click({ position: { x: 700, y: 500 } });
  await B.page.waitForTimeout(300);

  // 用 DataTransfer 构造文件上传
  await B.page.evaluate(async () => {
    const dt = new DataTransfer();
    const blob = new Blob(['这是一个测试文档的内容'], { type: 'text/plain' });
    dt.items.add(new File([blob], '测试文档.txt', { type: 'text/plain' }));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await B.page.waitForTimeout(2500);
  const bFeed = await B.page.textContent('#feed');
  check('发送者看到附件卡片', bFeed.includes('测试文档.txt'), bFeed.slice(-120));

  await C.page.waitForTimeout(1200);
  check('接收者收到附件', (await C.page.textContent('#feed')).includes('测试文档.txt'));

  console.log('\n===== 16. 无 JS 报错 =====');
  const real = errors.filter((e) =>
    !/favicon|401|403|Failed to load resource|net::ERR/i.test(e));
  check('页面无未捕获的 JS 错误', real.length === 0, real.slice(0, 3).join(' | '));

  console.log(`\n${'='.repeat(46)}\n通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(46)}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
