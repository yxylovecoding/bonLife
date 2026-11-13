# 免费托管迁移

核对日期：2026-11-04。已迁至 Render 免费 Web Service，在用户确认的 `xinyi's workspace` 使用新加坡 `bonbills` 服务（`srv-dbld16gu01pc739s7o2g`，`https://bonbills.onrender.com`）。17 项应用配置已迁入，PR #2 与 CPU 优化已发布。正式域名已切换，根域跳转到 `https://www.bonbills.cn`；五个业务子域的 HTTPS、正式域名登录、Turso 规则/衣柜读取及既有 R2 照片验证通过。旧 Vercel 项目保留用于回滚。

## 已完成的域名切换

Cloudflare 域名与调度 Worker 分属两个账号，不能用 Worker 账号的空域名列表判断域名不存在。2026-11-04 在用户指定的域名账号完成以下配置，所有记录均为 DNS only、TTL Auto：

| CNAME 名称 | 当前目标 |
| --- | --- |
| `@`、`www`、`bill`、`log`、`clothes`、`*` | `bonbills.onrender.com` |
| `_acme-challenge` | `bonbills.verify.renderdns.com` |
| `_cf-custom-hostname` | `bonbills.hostname.renderdns.com` |
| `cv`（保留） | `ada7aa1771debe1d.vercel-dns-017.com` |

`life.bonbills.cn` 由通配 DNS 覆盖。Render 使用 `www.bonbills.cn` 和 `*.bonbills.cn` 两个绑定，自动配对根域跳转；后台确认占用 **2/2** 个免费域名，三行域名的状态均为 Verified / Certificate Issued。根域由 Render 返回 301，实测 `/calendar?tab=month` 完整跳转到 www 的相同路径和查询；应用内 308 逻辑仍作为适配层的兜底。

验证包括公共 DNS（1.1.1.1）、严格 TLS 校验及 Render 响应标识，避免将本机 DNS 旧缓存命中的 Vercel 误认为新服务。五个业务子域 `/healthz` 均为 200，主站登录和会话为 200，Cookie 包含 Secure/HttpOnly，Turso 规则和 63 件衣物读取为 200，既有 R2 WebP 照片读取为 200。测试会话已注销；没有触发真实排程或改写业务数据。主站浏览器登录页可正常打开。

迁移时正常调度尚未到下一轮；队列中最后一条 15:01 的 524 失败发生在 Worker 切向 Render 之前，不能将其作为迁移后结果。后续以正常云端任务及 Render 指标评估运行表现。

## 方案与限制

| 平台 | 免费资源 | 本项目结论 |
| --- | --- | --- |
| Vercel Hobby | 4 小时 Active CPU/月 | 用户报告已耗尽 |
| Render Free | 每工作区每月 750 实例运行小时；0.1 CPU、512 MB 内存 | 当前迁移目标；闲置 15 分钟休眠，唤醒有延迟；单实例运行时长可覆盖一个月，但 CPU 较慢 |
| Deno Deploy | 已验证账号原有 10 小时 Active CPU/月 | **已放弃**：2026-10-09 官方宣布六个月后停服，约 2027 年 4 月，不应再推荐长期迁入 |
| Koyeb | 文档仍保留 free 实例说明 | 2026-02-17 公告取消新用户 Starter 免费计划；不按过时文档推荐 |
| Cloudflare Workers Free | 10 万请求/天，单次 10ms CPU | 继续负责现有调度，不直接承接完整日历解析与排程 |

Render 的实例运行小时不能直接与 Active CPU 小时比较。750 小时是一个工作区所有免费服务共享，不能保证在 512 MB / 0.1 CPU 上达到原有速度。账户后台已核对：Hobby 每月 5 GB 出站流量、500 构建分钟、两个自定义域名；构建额外预算为 $0，用尽后停止构建。已绑卡账户的公网出站超额仍按 $0.15/GB 收费；额外域名为 $0.25/个/月。当前账单及当月预估均为 $0。免费 Web Service 未规定固定到期日，免费 Postgres 的 30 天期限不适用于本项目继续使用的 Turso；平台政策不等于永久免费承诺。不创建付费实例、数据库、磁盘或 Cron。

Render 免费服务禁止 SMTP 25/465/587。用户于 2026-11-04 明确取消每日计划邮件，因此已删除自动发信步骤、发信实现和 SMTP 依赖；旧队列邮件步骤不发请求，旧邮件 API 退役。网页计划、云端同步及账单导入保留。

来源：[Render 免费限制](https://render.com/docs/free)、[计算规格](https://render.com/docs/compute-plans)、[自定义域名](https://render.com/docs/custom-domains)、[Deno 停服公告](https://deno.com/blog/cloudflare)、[Koyeb 公告](https://www.koyeb.com/blog/koyeb-is-joining-mistral-ai-to-build-the-future-of-ai-infrastructure)、[Vercel Fluid](https://vercel.com/docs/functions/usage-and-pricing)、[Cloudflare 限制](https://developers.cloudflare.com/workers/platform/limits/)。

## 运行适配

`server/index.ts` 通过 Node HTTP 兼容接口复用现有 12 个 API 入口。显式路由表禁止访问内部模块；沿用 API 重写、Cookie、同源检查、账号隔离和 4.5MB 请求上限。只从 `dist` 提供前端文件，SPA 深链接返回首页，丢失资源返回 404。

`render.yaml` 固定 `plan: free`、Singapore、Node 24、构建和启动命令及 `/healthz`；不声明数据库或额外服务。初次部署使用迁移分支，正式切换后跟随 main。应用所需密钥单独迁移，不写进仓库。

当前服务以公开 Git 仓库 URL 连接 main，尚未连接 GitHub provider。即使 API 的 autoDeploy 字段显示开启，推送仍不会自动发布；本次通过 Render 手动部署完成。后续发布先检查 deploy 列表，确认最新提交没有自动构建，再触发一次部署，避免重复消耗免费构建分钟。

```sh
npm ci --include=dev
npm run build:deploy
npm run verify:deploy
```

HTTP 验证使用独立假密钥，不连接正式数据、不发送邮件、不修改待办。另运行已有认证、数据隔离、日历、日志、衣柜和调度回归。

### 经授权的关窗一次性补跑

维护入口仅由服务端环境变量 `BON_RAIN_REPLAY` 启用，默认缺省或空串关闭，不新增公开 API。JSON 字段为 `date`（上海当天）、`accountId`（仅 `legacy`，既有云端 owner）、`projectId`（必须与实际 TickTick 连接一致）、`requestId`（16–80 位字母数字或连字符）、`mode`（`inspect` / `run`）。不放入 Blueprint，不改动现有密钥。

先对目标服务合并写入 `inspect` 参数并部署，通过 `[rain-reminder-replay]` 日志核对城市、预报、去重记录及 `inspected` 结果；再将同一请求改为 `run` 并部署。`run` 会重新读取真实来源并经过原雨天规则及提交确认，仅绕过本次手动请求的晨间限制。任何阶段不确认时不盲目创建。请求执行前保存尝试记录，同一 mode 的同一请求在重启后不会重放；若中断或失败，先核对远端状态，再决定是否使用新的请求 ID。规则已删除或显式前序未执行时仍跳过。

取得结果后合并设为空串，检查是否已有部署，避免重复触发。外部平台未自动部署时按本节既有流程手动部署一次。任务与回读字段记入审查材料；不记录账号密钥、订阅 URL 或无关任务内容。08:00 后创建不证明过去时刻的通知可以补发。

## 切换顺序

1. 在用户确认的 Render 工作区创建一个 `bonbills` 免费 Web Service，先使用 `onrender.com` 域名；核对实际 `free` 套餐。不开通付费服务。
2. 迁移**应用所需**生产环境变量，保留原 `SYNC_SECRET`、存储后端、Turso 配置和调度密钥。不复制 `VERCEL*` 平台变量、过时 GitHub Actions token 或已取消的每日发信凭据。构建脚本不输出密钥，前端只允许既有公开配置。
3. 沿用现有 Turso 和对象存储，不导入、覆盖或搬运账本数据。检查健康接口、认证、同源 Cookie、只读数据、照片和外部服务连接后再切正式域名；不以测试名义执行排程。
4. 五个业务域名为 `www`、`bill`、`log`、`clothes`、`life.bonbills.cn`。使用 `www.bonbills.cn`（自动配对根域跳转）加 `*.bonbills.cn`，总占用两个免费域名。用户已明确批准移除本轮新建的未验证根域主绑定，再重建为 www 主绑定；此操作和 DNS/证书验证均已完成。`cv.bonbills.cn` 属于独立 BonCV 项目，保留其明确的 Vercel DNS 记录。任何会增加费用的域名配置都不得直接执行。
5. 保留 Cloudflare `bonbills-scheduler` 及现有 Durable Object 队列。其 `ORIGIN=https://bonbills.onrender.com` 直接指向已验证的 Render 后端，避免自定义域名待切换期间继续消耗 Vercel CPU。保留所有同步频率、休息窗口和未知写入结果不重试规则；每日邮件已取消。
6. 月度备份入口已适配 Cloudflare 持久队列，以相同北京时间每月 1 日 08:10 调用 `/api/sync-monthly-backup`。将原 `CRON_SECRET` 写入 Worker 的 `BACKUP_RUN_SECRET`，并设置 `MONTHLY_BACKUP_ENABLED=true`；`vercel.json` 的旧 Cron 已移除，发布生效后再部署 Worker，避免重复调度。备份响应不确定时不会自动重放。
7. 切换后检查响应、日志和下一次正常云端任务；观察实际内存、流量与任务耗时。旧 Vercel 部署先保留回滚，不删除数据库或原环境变量。

## 回滚

原始 DNS 已导出备份。回滚时将 `@`、`www`、`bill`、`log`、`clothes` 的 CNAME 恢复为 `ecf2517c670b90bd.vercel-dns-017.com`（DNS only、TTL Auto）。`cv` 始终保留上表中的独立目标。`*` 和两条 Render 验证记录为本次新增；原先没有 life 记录，若继续保留 life 入口，应在确认 Vercel 域名绑定后显式指回原项目，而非让它继续命中 Render 通配记录。

让月度备份只有一侧启用。Cloudflare 日常队列的 `ORIGIN` 也须恢复到原 `www` 地址，Turso 数据及会话沿用原实例，不应反向导入旧快照。回滚前确认原 Vercel 账户额度能提供服务。每日邮件的取消是独立用户要求，回滚托管时也不得恢复发信。
