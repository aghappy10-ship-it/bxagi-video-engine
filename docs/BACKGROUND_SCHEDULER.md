# 后台分钟调度执行器

本执行器尚未部署到实际 Cloudflare 账号，当前文件和构建检查不表示后台已经运行。只有真实定时触发、服务端心跳和任务进度读回通过后，才能显示后台已连接。

`worker/cron-forwarder.mjs` 是独立的确定性 Cloudflare Worker，每分钟向 `SITE_URL` 的固定路径 `POST /api/v2/worker/background-tick` 发送 `{}`。原站点继续保存用户、任务和文件；执行器不需要新 D1、R2、常开电脑或模型。用户仍只用 BXAGI 登录平台。托管演示站点的无人值守访问可能另外需要部署者的 Sites 服务访问凭据；这不要求产品用户登录 GPT，也不提供用户身份。

服务端持久记录调度心跳、租约和进度，负责检查各用户 BXAGI 授权以及任务下一次可执行时间。执行器只发起有界检查，不决定员工、不重置任务、不添加预算。收到 HTTP 2xx 仅表示后台端点响应成功，不表示素材已生成或整个流程已完成。

## 部署准备

需要部署者实际拥有并授权使用的 Cloudflare 账号。本站托管权限不等于该账号权限；不要把 `.openai/hosting.json` 添加未知 `triggers` 字段当作上线，也不要创建 GPT 定时任务代替此执行器。

1. 先发布包含 `/api/v2/worker/background-tick` 的站点版本，并确认站点公开入口保留应用自身的 BXAGI 鉴权。
2. 生成至少 32 字符的随机独立秘密，在站点和此执行器的服务端秘密配置中设置相同的 `BXAGI_SCHEDULER_SECRET`。它仅授权后台推进端点，不应复用 `APP_WORKER_SECRET`、BXAGI 用户令牌或账户加密密钥。
3. 核实 `worker/wrangler.scheduler.jsonc` 的 `SITE_URL`。只允许 HTTPS 站点根地址，不带路径、查询、fragment 或 URL 用户名密码。默认值指向当前公开演示站点，但公开可见不等于已允许无人值守 HTTP 访问。2026-10-15 普通无认证 HTTP 健康检查实际返回 Cloudflare 403／Error 1010 `browser_signature_banned`，不是应用业务错误。
4. 对托管站点，使用官方 Sites `get_site` 为该站点返回的 `siwc_bypass_bearer_token`，通过安全输入保存为执行器的可选秘密 `SITES_SERVICE_TOKEN`。执行器仅将它作为 `OAI-Sites-Authorization: Bearer …` 发送到配置的同一源站，仍须同时提供专用调度密钥。此服务访问既不提供访客身份，也不授予任何 BXAGI 账号权限。必须从真实云端执行环境验证正式访问路径、凭据有效期与续期方式，不能假定令牌永久有效；若此路径不能持续运行，部署到已授权且可无人值守访问的自有域名环境。
5. 完成真实执行器部署与服务访问核验后，在站点服务端设置 `BXAGI_BACKGROUND_ENABLED=true` 并重新发布，使开关生效；随后验收真实定时心跳。此开关本身不会创建定时器。尚无已部署执行器时保留关闭状态。

秘密不能写入源码、命令参数、日志或网页。通过部署平台安全输入保存；不要为检查而读取、导出或打印现有秘密。

## Cloudflare 部署

以下命令从仓库根目录运行。使用已有的受保护 Cloudflare 部署凭据；需要交互认证时才执行登录。不会创建数据库或对象存储。

```sh
npx --no-install wrangler login
npx --no-install wrangler secret put BXAGI_SCHEDULER_SECRET --config worker/wrangler.scheduler.jsonc
npx --no-install wrangler deploy --config worker/wrangler.scheduler.jsonc
```

`secret put` 的安全提示输入与站点相同的专用调度秘密，不要把它粘贴进命令行。部署前核实当前账号、资源名称和套餐；本说明不自动购买套餐或承诺零费用。单个每分钟定时器每天触发 1,440 次，仍受账号 Worker 执行、CPU 和日志额度约束，站点数据库与 BXAGI 员工费用单独计算。

托管服务访问要求该凭据时，在部署前另以安全输入配置它：

```sh
npx --no-install wrangler secret put SITES_SERVICE_TOKEN --config worker/wrangler.scheduler.jsonc
```

已验证无需此凭据的自有部署不设置它。目标源站变更时必须重新核对凭据所属站点并删除不适用的旧服务令牌，不得把另一个站点的服务访问令牌带到新目标。

Cloudflare 官方支持 `* * * * *` 每分钟调度，Cron 使用 UTC；本方案每分钟一次，不受本地时区影响。新配置传播可能耗时最多约 15 分钟。托管站点的普通发布不会自动部署这个独立 Worker。

## 运行与验收

- 55 秒后终止本轮请求；不在同一轮盲目重发。服务端可能已经收到请求，下一分钟必须利用持久租约和任务状态继续核对。
- 所有 HTTP 重定向均被拒绝，秘密只发送到配置的唯一 HTTPS 源站。响应体不读取、不记录，错误日志仅包含固定错误码、HTTP 状态和耗时。
- 403、401 等拒绝访问结果保持失败，不修改 User-Agent、不追随跳转，也不立即重试来绕过访问控制。通过正式服务授权和凭据续期解决；必要时在已授权的自有部署环境接入调度。
- `acknowledged` 表示端点返回 2xx。离线等待、会话过期和真实素材交付仍以站点保存的业务状态为准；失败不会制造成功心跳。
- 执行器禁用公开 `workers.dev` 和预览 URL；即使 HTTP 入口被调用也只返回 404，不能触发任务。
- 部署后查看 Cloudflare 的 Cron 执行记录，核对平台调度心跳由该专用端点产生，并在关闭页面后读回真实任务的进度。至少观察连续两次真实定时触发，确认请求没有被跳转、拒绝或超时。素材生成、归档、下载须分别验收。

本地夹具验证可运行：

```sh
node --test tests/cron-forwarder.test.mjs
```

这项检查不会调用实际站点，也不会创建任务、消费广告预算或证明云端定时器已经上线。

暂停时，在此配置将 `triggers.crons` 改为空数组后重新部署独立 Worker；暂停定时器不删除站点任务。撤销专用服务秘密后，后续调用应被站点拒绝。不要旋转账户加密密钥来停用调度。

官方资料：[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[Workers 价格和配额](https://developers.cloudflare.com/workers/platform/pricing/)。
