# 独立部署 BXAGI 广告平台

独立构建使用自己的 Cloudflare Worker、D1 数据库和 R2 文件桶。平台登录由 BXAGI 应用会话验证，员工执行连接 `https://bxagi.xinlx.com`；不需要 OpenAI 账户、ChatGPT 登录、Sites 项目凭据、连接器或 `.openai/hosting.json`。

这条部署路径与当前托管站点分开。源码包含可运行的独立构建配置，但并未创建部署者的 Cloudflare 资源，也未将网站迁移到 `xinlx.com` 或其他用户域名。`wrangler.standalone.jsonc` 的数据库 ID 是明确的本地构建占位值，必须在真实部署前替换。

## 本地构建

准备 Node.js 22.13 或更新版本和 npm，进入完整源码目录：

```sh
npm ci
node scripts/build-standalone.mjs
```

脚本自动设置 `BXAGI_STANDALONE=true`，直接调用 Vite builder，输出：

```text
dist-standalone/client/
dist-standalone/server/
dist-standalone/server/wrangler.json
```

独立 Vite 分支只加载 Vinext 和 Cloudflare 插件，入口为 `build/bxagi-worker.ts`，直接执行应用请求处理器。它不加载 Sites 插件、连接器、模拟身份、托管环境脚本或项目身份文件。当前托管构建继续使用自己的 `dist/`，不会被这个脚本覆盖。

构建不会自动部署、创建账户、购买服务、雇佣员工或发起付费广告。完整依赖锁文件已随源码提供；`npm ci` 按锁文件安装，不依赖本地预览工具。

## 创建自己的 Cloudflare 资源

先使用自己的 Cloudflare 账户认证，或在受保护的部署环境设置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。凭据不写入源码、下载包或公开配置。

```sh
npx --no-install wrangler login
npx --no-install wrangler d1 create bxagi-advertising
npx --no-install wrangler r2 bucket create bxagi-materials
```

把 D1 创建命令实际返回的 `database_id` 写入 `wrangler.standalone.jsonc`，替换 `00000000-0000-4000-8000-000000000000`。数据库名、桶名和 Worker 名可按实际资源调整；绑定名保持 `DB`、`BUCKET` 和 `ASSETS`，因为应用按这些绑定读取数据。

当前配置只开放 Worker 提供的公共页面入口。项目、素材、预算、账户、员工任务和实际文件仍需要已验证 BXAGI 会话；不能用公开页面访问代替应用身份校验。

## 数据库与服务端秘密

应用 schema 和迁移存放在 `drizzle/`。部署到新数据库前应用完整迁移序列：

```sh
npx --no-install wrangler d1 migrations apply bxagi-advertising --remote --config wrangler.standalone.jsonc
```

如果修改了配置中的数据库名，也要对应修改命令。迁移包含账户、用户隔离、任务、预算、审计和历史归属处理；不要手工只建其中一张表。

为 Worker 设置两个服务端秘密，命令会要求安全输入实际值：

```sh
npx --no-install wrangler secret put APP_ENCRYPTION_KEY --config wrangler.standalone.jsonc
npx --no-install wrangler secret put APP_WORKER_SECRET --config wrangler.standalone.jsonc
```

`APP_ENCRYPTION_KEY` 使用随机生成的 32 字节 AES 密钥，编码为 64 位十六进制或对应 Base64；`APP_WORKER_SECRET` 使用独立随机服务密钥。如果迁移已有加密的账户与会话数据，须沿用其原加密密钥，不能重新生成后直接导入旧密文。

`BXAGI_REQUIRED: "true"` 已作为非秘密配置保存在 Wrangler 文件中。可选 `APP_BXAGI_TIMEOUT_MS` 调整 BXAGI 请求超时，应用仍保留自己的边界限制。广告平台、模型或执行器的真实账户参数按相应集成文档设置，不把任何秘密放进前端 `VITE_*` 变量。

独立部署不会自动复制当前站点的生产数据库、R2 对象或账户凭据。需要迁移数据时，应单独备份、导出、按真实账户归属导入和验证，再切换域名。

## 构建并部署

资源配置发生变化后重新构建，再使用生成的部署配置：

```sh
node scripts/build-standalone.mjs
npx --no-install wrangler deploy --config dist-standalone/server/wrangler.json
```

生成的配置指向已编译 Worker 和实际前端资产目录；不要把未编译的 TypeScript 入口当作完整前端部署产物。构建脚本检查 Worker 入口、资产目录与 D1/R2 绑定，检查通过表示产物齐全，不表示资源已经创建或生产业务已经验收。

部署者可在自己的 Cloudflare 控制台配置 Worker 自定义域名或路由。需要该域名和 DNS 的实际管理权；本源码不会自动接管 BXAGI 主站的域名。

## 后台执行与验收

独立 Worker 的生成配置包含每分钟一次的 Cron Trigger，`BXAGI_BACKGROUND_ENABLED: "true"` 时会推进持久自动流程并读取已授权投放的真实报表。只有把生成配置部署到自己的 Cloudflare 资源后，该定时入口才运行；当前托管站点的发布不代表这条独立定时任务已经上线。

FFmpeg 辅助任务仍需外部执行器；也可用 `worker/run.py` 作为周期调度入口，配置独立站点 HTTPS 地址及相同 `APP_WORKER_SECRET`，独立站点不需要 `SITES_SERVICE_TOKEN`。未连接持续执行器时，登录后的可见页面会自动推进，进度持久保存，重新打开恢复；不宣称关闭页面后仍有已验证的全天候监测。

BXAGI 员工市场的真实模板是唯一选人来源。系统根据素材、目标和市场岗位匹配员工，再核验当前账号对应的安装记录、激活状态与执行资源。历史会话只保留为任务历史，不作为员工目录，也不能替代市场岗位证明；旧会话任务不会自动继续派发或作为新市场流程的完成结果。

未激活的匹配员工进入 `waiting_employee_activation`；缺少市场证明进入明确等待状态。价格和免费条件只能来自已核实的官方市场信息，未知价格保持未知。只有显式开启 `BXAGI_MARKET_AUTO_ACTIVATE_FREE`，并实时确认对应新 Solo 岗位零费用、免费名额充足且无默认日程，才允许自动启用；安装结果不明不重试，不自动付费购买或续费。执行会话必须与所选市场模板及当前账号安装记录一致。

`BXAGI_PLANNER_ENABLED=true` 可启用已核验市场员工的协调任务，先回收结构化规划文件，再选择符合条件的市场岗位执行；关闭时使用明确的岗位与场景规则路由。此配置不是独立模型推理服务，也不证明远端具体模型已验证。

部署后逐项验证：BXAGI 登录与退出、两个实际账号的数据隔离、市场岗位匹配与安装证明、上传和真实员工执行、真实成品入库与下载、预算计划与广告账户授权，以及实际报表反馈。2026-10-14 的一次真实市场视频优化专家任务已通过 CodeActAgent 生成 PNG 与文案，平台归档和授权下载已确认；首版中文不合格后，同一任务的 v2 流程测试样张通过完整解码与视觉检查。这个结果不替代商业素材、全部行业、独立部署环境或多用户运行的验收，详见 [验证记录](VERIFICATION.md)。

当前真实广告连接为 0，无投放预算或广告消费，真实投放和转化闭环尚未验收。云端协调模型与本地内嵌模型的 B/C 方案未部署，三组质量、成本和稳定性对比尚未开始。已有协议夹具和单次文件产出均不能替代这些现场验收。

配置参考：[Cloudflare Vite 插件](https://developers.cloudflare.com/workers/vite-plugin/)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)、[Worker 秘密](https://developers.cloudflare.com/workers/configuration/secrets/)、[Worker 自定义域名](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

若需要部署后的源码下载按钮可用，构建前运行 `python3 scripts/package_delivery.py` 生成公开下载包；下载源码自身不包含嵌套源码 ZIP。
