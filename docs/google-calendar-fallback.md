# Google 备用日历

Google 只读来源是「课／玩／日历／干」四个 Outlook 导入副本。Outlook 失败时后台对应来源读取 Google；主源恢复后自动切回。Google 抓取时间不是订阅内容同步时间，导入副本可能滞后；排期详情显示实际来源。缺源或分页失败不会按空日历排程。

## 部署与权限

1. 在日历所有者的 Google 账号新建 Apps Script，复制 `integrations/google-calendar/Code.gs` 和 `appsscript.json`。脚本仅使用 Calendar API 只读权限，没有触发器、邮件或日历写入。
2. Google 的只读授权涵盖账号可访问的任何日历，无法在 OAuth 页限制四个；须向所有者明确该范围。脚本属性 `BON_CALENDARS` 则仅配置四个已核对的名称与 ID，代码不接受调用方指定其他日历。
3. 在脚本属性安全保存至少 32 字符的随机 `BON_CALENDAR_SECRET`。不得打印到执行日志、版本库或 URL。
4. 部署为 Web 应用，以所有者身份执行，允许服务端访问。公开 GET 不返回日程；POST 先核验密钥，再读取完整分页。仅向 BonLog 保存 `/macros/s/.../exec` URL 与密钥。
5. 在 Orchestrator 的连接设置中连接 Google 备用。后台即时读取并核对所有 Outlook 来源映射，成功后按账号加密保存凭据；失败保留原连接。OAuth 授权保留在 Google，BonLog 不持有 Google 账号令牌。

后台只向 Google 固定主机发送凭据，ContentService 的跳转仅允许 Google 内容主机并改为无密钥 GET。请求 ID、日期范围、完成标识及返回时间全部校验；响应限 4 MB，读取限 45 秒。原 Outlook URL 改变后必须重新核对映射；断开连接后不再读取备用。

## 验收

先读生产 `plan-details`，再回读同一北京时间日期的 TickTick 原始任务。核对本轮生成时间、日历来源、实际入选、日期、状态及标签。单元测试或部署成功不等于今日事已恢复。订阅故障和 Google 授权状态分别记录，不以聊天连接替代后台接入。

调度仍为 Cloudflare 持久队列调用 Render；此脚本只有被动只读接口，不新增定时任务或付费服务。
