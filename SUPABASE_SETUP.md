# chat-app → Supabase 部署与执行指南

把项目改造为「前端直连 Supabase + Cloudflare Pages 部署」后，按以下顺序执行即可上线。

## 一、前置准备
- 一个 Supabase 项目（免费档即可）：https://supabase.com
- 一个 Cloudflare 账号（用于 Pages 部署与自定义域名）
- 本仓库已就绪的文件：
  - `supabase/schema.sql` — 建表 + 索引 + 开启 RLS + 附件桶
  - `supabase/triggers.sql` — 新用户自动建档（首用户=管理员，其余=待审批）
  - `supabase/policies.sql` — 行级安全策略
  - `supabase/rpc.sql` — 所有管理动作与后台查询（security definer）
  - `public/supabase-config.js` — 前端 Supabase 配置（需填值）
  - `public/index.html` — 已重写为 Supabase 直连

## 二、执行 SQL 迁移（顺序不可打乱）
1. 打开 Supabase 控制台 → **SQL Editor → New query**
2. **推荐（一次搞定）**：打开仓库里的 `supabase/00_all_in_one.sql`，整段复制，在 SQL Editor 粘贴后点 **Run** 一次即可（已按 schema→triggers→policies→rpc→rpc_patch→06 顺序合并好，可重复执行，幂等）。
3. 若想分步执行，也可依次粘贴以下 6 个文件：
   1. `supabase/schema.sql`
   2. `supabase/triggers.sql`
   3. `supabase/policies.sql`
   4. `supabase/rpc.sql`
   5. `supabase/rpc_patch.sql`（补丁：本人撤回、私聊举报）
   6. `supabase/06_fix_images_recall.sql`（**房间消息支持图片/附件 + 撤回保留原文**，让管理员在后台能看到被撤回内容）
4. 全部执行无报错即完成。可到 **Table Editor** 看到 `users/rooms/messages/dms/blocks/reports/audit/mutes` 八张表。

> 已上线、之前只跑过前 5 个文件的用户：**只需补跑 `supabase/06_fix_images_recall.sql` 一次**即可开启图片发送与「撤回保留原文」。

## 三、Auth 设置
- **Authentication → Providers → Email**：关闭 **Confirm email**（否则注册后需验证邮箱才能登录）。
- **Authentication → URL Configuration**：
  - Site URL 填你的 Cloudflare 域名（如 `https://chat.example.com`），开发期可先用 `http://localhost`。
  - Redirect URLs 加入该域名。

## 四、配置前端
编辑 `public/supabase-config.js`，填入：
- `SUPABASE_URL`：项目 URL（`https://<ref>.supabase.co`）
- `SUPABASE_ANON_KEY`：Project Settings → API → `anon` `public` key

## 五、Realtime 开启
- **Database → Replication**（或 Project Settings → API → Realtime）：确保 `messages`、`dms` 表已开启 Realtime（用于房间消息推送与私聊广播）。

## 六、CORS（关键）
- **Project Settings → API → CORS**：加入你的前端域名（Cloudflare 地址 / 自定义域名）。
- 开发期可临时填 `*`。

## 七、Cloudflare Pages 部署
1. Cloudflare Dashboard → **Workers & Pages → Create → Pages → 连接 GitHub**
2. 选择仓库 `Xsny-001/24h02chat1`
3. 构建设置（**务必**）：
   - Framework preset：**None**
   - Build command：**留空**
   - Output directory：**`public`**
4. 部署完成获得 `*.pages.dev` 预览地址。
5. 自定义域名（可选）：Cloudflare → 添加站点（NS 转入）→ Pages 项目 → Custom domains → 绑定，自动签发 SSL。

## 八、首次使用
1. 打开站点 → 注册**第一个账号** → 自动成为管理员并直接激活。
2. 后续注册的其他账号进入「待审批」状态，由管理员在后台「待审批」标签通过。
3. 验证：发消息即时出现、刷新后历史仍在（数据已持久化）、多端登录在线状态同步。

## 九、常见问题
- **注册后登录提示「待审批」**：正常，等管理员在后台通过即可。
- **文件上传失败**：确认 `attachments` 桶已创建（schema.sql 自动建），且路径用 `dm/<conv_key>/<uuid>.<ext>`。
- **Realtime 不推送**：检查表已开启 Realtime，且前端已 `sb.realtime.setAuth(session.access_token)`（见 index.html）。
- **CORS 报错**：在 Supabase API CORS 加入前端域名。

## 十、安全提醒
- `anon key` 放前端是标准做法，安全由 **RLS + RPC 角色校验** 保证；所有写表操作只经 `supabase/rpc.sql` 的 `security definer` 函数。
- `service_role key` 仅在本地执行 SQL 迁移时使用，**绝不下发前端/仓库**。
- 默认房间（`大厅/技术/闲聊`）由前端在 rooms 为空时创建（首次安装），或你可在 `rpc.sql` 之外手动插入。
