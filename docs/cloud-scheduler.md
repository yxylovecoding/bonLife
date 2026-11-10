# Cloudflare 云端调度

Cloudflare Workers Free + SQLite Durable Object 队列负责触发，Render 免费 Web Service 执行业务逻辑，Turso 保存应用数据。GitHub Actions 不再执行任务，旧工作流和手动入口均已移除，月度备份由同一 Cloudflare 队列执行，Vercel Cron 已移除。

| 北京时间 | 工作 |
| --- | --- |
| 00:01、06:01–23:01 | 普通重排、固定今日、具体时刻显隐 |
| 05:01 | 显隐恢复 → 经期归档 → 完整排程（含当天重排），不重复投递小时任务 |
| 07:01 | 阅读日间隐藏 → 小时重排 |
| 12:00 / 17:00 | 经期归档、完整排程 |
| 20:00 | 洗头与阅读显示、经期归档、完整排程 |
| 22:00 | 夜间 routine、未完成运动 |
| 00:00 | 凌晨临时隐藏、固定今日 |
| 每月 1 日 08:10 | Cloudflare 调度 Render 月度备份 |

## 部署

全部自动任务在北京时间 00:30–05:01 暂停，UTC cron 为 `1 0-16,21-23 * * *`；延迟进入休息窗口的任何任务由队列与服务端再次拦截。晨间显隐恢复、经期归档与完整同步在 05:01 依次执行；每日计划邮件已于 2026-11-04 取消。`always-today` 当天完成过时保留下一次日期，次日再固定为当天。

使用官方 Wrangler CLI，固定版本 `4.152.0`，不连接 GitHub Builds。首次部署需要 Cloudflare Workers Scripts Write 权限；日志检查使用 Workers Tail Read。

1. `npx wrangler@4.152.0 login --scopes account:read user:read workers_scripts:write workers_tail:read`
2. `npx wrangler@4.152.0 deploy -c workers/scheduler/wrangler.jsonc`
3. 通过 `wrangler secret put` 或私有临时 JSON 的 `secret bulk` 配置 两枚新生成的独立随机密钥 `SCHEDULER_RUN_SECRET` 和 `DISPATCH_SECRET`，不复制旧生产定时密钥。不得写入仓库、命令行参数或公开日志。
4. Render 生产环境配置 `CLOUD_SCHEDULER_URL` 为部署后的 HTTPS workers.dev 地址，`CLOUD_SCHEDULER_SECRET` 与 `DISPATCH_SECRET` 相同，`CLOUD_SCHEDULER_RUN_SECRET` 与 Worker 的 `SCHEDULER_RUN_SECRET` 相同。沿用已验证的生产密钥，不输出明文。Worker 的 `ORIGIN` 固定为 `https://bonbills.onrender.com`，与自定义域名切换解耦。
5. 禁用并移除 GitHub 三个旧工作流，检查没有旧运行仍在排队；发布 Render 并完成认证、只读数据验证后，启用 Cloudflare Cron。Cron 配置传播可能需要最多 15 分钟。

Worker 固定调用 Render 服务地址，不接受请求方提供目标 URL、任意 action 或邮件指令。公开 HTTP 入口全部检查独立调度密钥。应用的 `scheduler=1` 只在 原有 CRON 或专用调度授权通过后返回精简响应，Cloudflare 不存储应用记录或错误正文。

## 检查与恢复

- BonLog 账号所有者可通过已登录的 `GET /api/ticktick-trips?action=scheduler-status` 读取同一队列的脱敏状态；只返回触发时间、阶段、状态、HTTP 状态和固定失败类别，不触发任务，也不返回密钥或业务记录。
- `GET /status`：附 `Authorization: Bearer <DISPATCH_SECRET>`，返回最近 3 天、最多 200 条队列状态和 `lastCronAt`。仅输出固定阶段、时间、HTTP 状态和失败类别。
- `POST /dispatch`：同样鉴权，JSON `{ "kind": "full", "id": "<唯一请求ID>" }` 或 `kind=hourly`。相同 ID 去重，正在排队或执行的同类请求合并；不发邮件。
- 一次 Durable Object alarm 至多执行一次有超时的业务 HTTP 调用，完成状态持久化后唤醒下一步。调用 Render 前先做一次最长 10 秒、无凭据的只读 `/healthz` 检查；仅收到 `200` 和 `ok: true` 才发业务请求。冷启动、502、加载页或就绪读取超时均由持久队列每 30 秒复查，最多 12 次；此时尚未发送业务请求，不会重复写待办。任务不会依赖 HTTP 客户端保持连接，也不依赖本地进程。
- 已确认的安全读取失败最多重试两次；锁占用每 30 秒等待，最多 12 次。响应未知或进程中断后不会重发写入。需先检查业务结果，再手动补同步。
- Turso 网络中断发生在 SQL 事务提交前时，关闭并回滚该事务后最多重试两次；读事务也可重试。写事务一旦发出 COMMIT，响应不明时立即停止，不重放增量或条件写入。
- 经期导入失败仍执行完整排程并记录失败。旧任务等待超过 45 分钟或跨上海日期则失败，避免过时执行。
- 需要补跑时，检查业务状态后通过 Worker `/dispatch` 或网页 Orche 入口触发。GitHub 不再提供任务执行入口，不能重新启用旧工作流。

## 额度

只使用 Workers Free 和 SQLite Durable Objects Free，不升级套餐。免费额度内包含 Cron、持久队列及少量运行状态存储；超额会失败，不能保证平台永远不调整规则。Render 免费实例闲置 15 分钟会休眠，冷启动可能延长一次任务；队列分步继续，不把整个流程塞进一个 15 分钟 Cron 调用。队列串行等待意味着 01 分是触发时间，不是业务完成时间。

官方说明：[Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[Durable Objects 免费额度](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[alarm 行为](https://developers.cloudflare.com/durable-objects/api/alarms/)。

专用执行密钥只授权 `ticktick-trips` 的 `scheduler=1`、GET 和固定业务 action 白名单；不授权账本、照片、账号或月度备份接口。独立 `BACKUP_RUN_SECRET` 对应 Render 的原 `CRON_SECRET`，只用于每月 1 日北京时间 08:10 的备份接口；`MONTHLY_BACKUP_ENABLED=true`，原 Vercel Cron 必须保持关闭。

手动完整重排依次执行 `routine-visibility → life-periods → full`，涵盖所有现行 TickTick 专项处理；不发送邮件。每小时与完整同步均先对齐出门／搬家模板的 10 组二级子任务，保留容器前缀与各自排期。

每天 05:01 起首次有效 replan 在服务端核对当日完整专项同步状态；未成功时补做完整排程（含充电、接车、洗头、洗衣的 TickTick 与 Outlook），全部成功后标记当天完成。接车固定充电次日 07:20–07:40。小时补做不发邮件；接车失败由服务端返回同步失败，现有 Worker 会记录失败。


### 规则配置与结果（2026-11）

`PATCH /api/ticktick-trips?action=rules` 完成版本校验及账号配置保存后，复用现有完整重排队列投递一次任务。投递失败不回滚已保存配置，前端显示「已保存，Orchestrate 未提交」并允许通过 `trigger-replan` 重试。无需新增 Cron、服务、密钥或本机进程。

所有规则入口固定读取一份配置版本，按稳定拓扑顺序计算；实际范围保持原入口语义，范围外前序不可借用历史结果。调度响应只提供 `rulesComplete` 等脱敏结果：全部适用规则完成才视为成功；部分失败或跳过不自动重放可能已经写入的任务。具体规则结果和冲突原因通过登录后的 DoneList／排期详情读取，不进入队列日志。
