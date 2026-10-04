# 网页版聊天室（账号体系 · 权限控制 · 私聊）

基于 **Supabase（Postgres + Auth + Storage + Realtime）+ Cloudflare Pages** 的实时聊天应用：多房间、私聊、文件传输，带完整的**注册审批、三角色权限、房间级访问控制和管理后台**。

> 架构说明：前端为原生单页、**无后端、无构建步骤**。所有数据读写、鉴权、实时推送、文件存储均直连 Supabase；静态资源由 Cloudflare Pages 托管。

## 快速开始

> 最简路径：先在 Supabase 跑 `supabase/00_all_in_one.sql` 建库，再部署到 Cloudflare Pages。详细步骤见下方「部署指南」与 `SUPABASE_SETUP.md`。

```bash
# 1. 在 Supabase SQL Editor 执行 supabase/00_all_in_one.sql（一次建好全部表/策略/函数）
# 2. 填写 public/supabase-config.js 的真实 URL 与 anon key
# 3. 用 Cloudflare Pages 连接仓库部署（输出目录 public）
```

打开站点 → 注册**第一个账号自动成为管理员并激活** → 用它审批后续注册用户。

## 功能总览

### 聊天
- **多房间**：内置大厅/技术/闲聊，实时在线人数，公开与私有房间
- **私聊**：一对一实时会话，会话列表、未读徽标、消息搜索
- **实时状态**：对方在线/离线（Realtime presence）、正在输入、已读未读回执
- **消息操作**：撤回（保留原文，管理员在后台可见）、举报
- **文件传输**：图片、PDF、Office 文档、压缩包、文本（单文件上限 5MB，存于 Supabase Storage `attachments` 桶）
- **消息持久化**：全部落 Postgres，进房自动加载最近历史
- **断线重连**：Realtime 自动重连并恢复会话

### 账号与权限
- 注册需管理员审批，首个用户自动提权
- 登录走 Supabase Auth（邮箱 + 密码，默认关闭 Confirm email）
- 三角色（管理员/版主/普通用户）+ 多权限点
- 房间级 ACL，私有房间对无权限用户完全不可见

### 管理后台（RPC `security definer` 实现）
用户管理、注册审批、房间管理、消息管理、**私聊审计**、举报处理、审计日志。

## 数据模型

八张表（由 `supabase/schema.sql` 创建，均已开启 RLS）：

| 表 | 用途 |
|---|---|
| `users` | 账号、角色（admin/mod/user）、状态（pending/active/banned）、审批 |
| `rooms` | 房间、是否私有、成员白名单、公告 |
| `messages` | 房间消息（含图片/附件字段） |
| `dms` | 私聊消息（会话 key = 双方 id 排序拼接） |
| `blocks` | 拉黑关系（单向即双向阻断） |
| `reports` | 举报（房间/私聊来源） |
| `mutes` | 禁言记录 |
| `audit` | 审计日志 |

### 会话模型
私聊会话用「双方 user id 排序后拼接」作为稳定 key（如 `idA:idB`），保证 A→B 与 B→A 落在同一会话，无需额外建会话表。

## 权限模型

**角色等级**：`user(1) < mod(2) < admin(3)`

| 权限点 | 最低角色 | 对应 RPC |
|---|---|---|
| 发言 | user | `add_report`（举报）等 |
| 撤回他人消息 | mod | `recall_message` / `recall_dm` |
| 删除消息 | mod | `delete_message` |
| 禁言/解禁 | mod | `mute_user` / `unmute_user` |
| 发布房间公告 | mod | `set_announce` |
| 处理举报 | mod | `resolve_report` |
| 审批注册 | admin | `approve_user` / `reject_user` |
| 用户管理 | admin | `set_user_role` / `set_user_status` |
| 房间管理 | mod/admin | `add_room` / `delete_room` / `set_member` |
| 后台数据查看 | admin | `admin_users` / `admin_rooms` / `admin_messages` / `admin_dms` / `admin_reports` / `admin_audit` |

> 所有写操作只经由 `supabase/rpc.sql` 的 `security definer` 函数，角色校验在服务端执行，前端无法绕过。

## 项目结构

```
chat-app/
├── public/
│   ├── index.html          # 前端单页（登录、聊天、私聊、管理后台），直连 Supabase
│   └── supabase-config.js  # 前端 Supabase 配置（URL + anon key）
├── supabase/
│   ├── 00_all_in_one.sql   # 一键建库：schema→triggers→policies→rpc→rpc_patch→06（幂等可重复执行）
│   ├── schema.sql          # 建表 + 索引 + 开启 RLS + attachments 桶
│   ├── triggers.sql        # 新用户自动建档（首用户=管理员，其余=待审批）
│   ├── policies.sql        # 行级安全策略
│   ├── rpc.sql             # 全部管理动作与后台查询（security definer）
│   ├── rpc_patch.sql       # 补丁：本人撤回、私聊举报
│   └── 06_fix_images_recall.sql # 房间消息支持图片/附件 + 撤回保留原文
├── SUPABASE_SETUP.md       # 详细部署与执行指南
└── README.md
```

## 部署指南（概要）

完整步骤见 `SUPABASE_SETUP.md`。要点：

1. **建库**：Supabase SQL Editor 执行 `supabase/00_all_in_one.sql`。
2. **Auth**：关闭 Confirm email；Site URL 填 Cloudflare 域名。
3. **前端配置**：`public/supabase-config.js` 填 `SUPABASE_URL` 与 `SUPABASE_ANON_KEY`。
4. **Realtime**：确保 `messages`、`dms` 表已开启 Realtime。
5. **CORS**：Supabase API CORS 加入前端域名（开发期可临时 `*`）。
6. **部署**：Cloudflare Pages 连接仓库 `Xsny-001/24h02chat1`，Framework preset 选 **None**，Build command 留空，Output directory 填 **`public`**。

> ⚠️ 已上线、之前只跑过前 5 个 SQL 文件的用户：**只需补跑 `supabase/06_fix_images_recall.sql`** 即可开启图片发送与「撤回保留原文」。

## 合规提示

- **私聊审计**：管理员可在后台查看全部私聊内容。此类监控须在**隐私政策或用户协议中明确告知**用户，否则存在合规风险。实现已按需求提供该能力，上线前请补齐告知。
- **安全边界**：`anon key` 放前端是标准做法，安全由 RLS + RPC 角色校验保证；`service_role key` 仅用于本地执行 SQL 迁移，**绝不下发前端或写入仓库**。

## 生产环境注意事项

- **传输加密**：Cloudflare Pages 默认提供 HTTPS，确保全程加密。
- **私聊告知义务**：管理员可查看私聊，须在隐私政策中告知用户。
- **速率限制**：登录、注册、发消息、上传未做限流，存在被刷风险，建议 Cloudflare 层加 WAF/速率规则。
- **存储**：附件进 Supabase Storage，建议配置大小与类型校验、病毒扫描。
- **审计留存**：`audit` 表有上限，长期合规留存需另行归档。
