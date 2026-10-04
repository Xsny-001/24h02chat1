const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const dir = '/workspace/chat-app/screenshots';
require('fs').mkdirSync(dir, { recursive: true });

(async () => {
  // 截图脚本要求空库（首个注册者才会成为管理员），先做前置检查
  const health = await fetch(BASE + '/api/health').then((r) => r.json());
  if (health.users > 0) {
    console.error(`数据库已有 ${health.users} 个用户。请先重置数据后重跑：`);
    console.error('  1) 停掉服务  2) rm -f data/store.json  3) 重启服务  4) node shots.js');
    process.exit(1);
  }

  const browser = await chromium.launch();
  const mk = async () => {
    const c = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    return await c.newPage();
  };
  const A = await mk(), B = await mk(), C = await mk();

  const reg = async (p, u) => {
    await p.goto(BASE);
    await p.click('#tabReg');
    await p.fill('#aUser', u); await p.fill('#aPass', u + '12345'); await p.fill('#aPass2', u + '12345');
    await p.click('#authSubmit');
    await p.waitForTimeout(700);
  };

  await reg(A, 'admin');
  await A.waitForSelector('#app.on', { timeout: 8000 });
  await reg(B, '李四');
  await reg(C, '王五');

  // 审批
  await A.click('#adminBtn');
  await A.waitForSelector('#adminModal:not(.hidden)');
  await A.click('#admTabs button[data-tab="approve"]');
  await A.waitForTimeout(700);
  await A.screenshot({ path: dir + '/3-后台-待审批.png' });

  // 逐个通过，直到列表显示为空
  for (let i = 0; i < 10; i++) {
    const btn = A.locator('#admBody table button:has-text("通过")');
    if (await btn.count() === 0) break;
    await btn.first().click();
    await A.waitForTimeout(700);
  }
  const stillPending = await A.textContent('#admBody');
  if (!stillPending.includes('没有待审批')) {
    console.error('审批未全部完成:', stillPending.slice(0, 100));
    process.exit(1);
  }
  await A.click('#adminModal .close');
  await A.waitForTimeout(400);

  const login = async (p, u) => {
    // 重新加载回到登录页，避免停留在「待审批」提示状态
    await p.goto(BASE);
    await p.waitForTimeout(400);
    await p.click('#tabLogin');
    await p.fill('#aUser', u); await p.fill('#aPass', u + '12345');
    await p.click('#authSubmit');
    await p.waitForSelector('#app.on', { timeout: 8000 });
    await p.waitForTimeout(500);
  };
  await login(B, '李四');
  await login(C, '王五');

  // 房间聊天
  await B.fill('#input', '大家好，我是李四，今天的技术分享几点开始？');
  await B.press('#input', 'Enter');
  await A.waitForTimeout(500);
  await A.fill('#input', '下午三点，会议室 A，欢迎参加');
  await A.press('#input', 'Enter');
  await C.waitForTimeout(400);
  await C.fill('#input', '收到，我会提前准备好演示环境');
  await C.press('#input', 'Enter');
  await A.waitForTimeout(900);
  await A.screenshot({ path: dir + '/4-聊天主界面.png' });

  // 私聊
  await B.click('#tabDms');
  await B.waitForTimeout(400);
  await B.click('#newDmBtn');
  await B.waitForTimeout(700);
  await B.screenshot({ path: dir + '/10-发起私聊(选择用户).png' });
  // 明确选择「王五」，避免选到 admin
  await B.fill('#pickSearch', '王五');
  await B.waitForTimeout(700);
  await B.locator('#pickList .conv').first().click();
  await B.waitForTimeout(900);
  await B.fill('#input', '王五你好，那份设计稿我改完了，方便的话看下？');
  await B.press('#input', 'Enter');
  await C.waitForTimeout(1500);

  // 王五收到未读徽标
  await C.click('#tabDms');
  await C.waitForTimeout(800);
  await C.screenshot({ path: dir + '/11-私聊未读徽标.png' });
  const convCount = await C.locator('#convlist .conv').count();
  if (convCount === 0) {
    console.error('王五未收到会话，私聊投递异常');
    process.exit(1);
  }
  await C.locator('#convlist .conv').first().click();
  await C.waitForTimeout(900);
  await C.fill('#input', '好的，我下班前给你反馈 👍');
  await C.press('#input', 'Enter');
  await B.waitForTimeout(1000);
  await B.screenshot({ path: dir + '/12-私聊会话.png' });

  // 附件
  await B.evaluate(async () => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Blob(['设计稿评审意见'], { type: 'text/plain' })],
      '设计稿评审意见.txt', { type: 'text/plain' }));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await B.waitForTimeout(2500);
  await B.hover('#input');
  await B.screenshot({ path: dir + '/13-私聊附件.png' });

  // 会话菜单
  await B.click('#peerMenuBtn');
  await B.waitForTimeout(400);
  await B.screenshot({ path: dir + '/14-会话操作菜单.png' });
  await B.keyboard.press('Escape');
  await B.locator('body').click({ position: { x: 800, y: 600 } });
  await B.waitForTimeout(300);

  // 后台：私聊审计
  await A.click('#adminBtn');
  await A.waitForSelector('#adminModal:not(.hidden)');
  await A.click('#admTabs button[data-tab="dms"]');
  await A.waitForTimeout(1000);
  await A.screenshot({ path: dir + '/15-后台-私聊审计.png' });

  await A.click('#admTabs button[data-tab="users"]');
  await A.waitForTimeout(700);
  await A.screenshot({ path: dir + '/6-后台-用户管理.png' });
  await A.click('#admTabs button[data-tab="audit"]');
  await A.waitForTimeout(800);
  await A.screenshot({ path: dir + '/9-后台-审计日志.png' });

  await browser.close();
  console.log('截图完成');
})();
