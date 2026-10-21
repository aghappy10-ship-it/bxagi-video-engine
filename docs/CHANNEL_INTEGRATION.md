# 真实渠道接入与投放闭环

产品读取 BXAGI 账号实际已雇佣员工，按“业务素材 → 营销目标 → 广告账户能力”安排任务。投放员工交付与当前计划绑定的执行请求后，由本平台预算工具调用真实渠道；员工文本不能替代渠道执行成功。服装、游戏、短剧与通用产品共享资产库、预算、素材版本与反馈记录；业务场景不决定某一家广告平台的 API 能力。当前真实渠道代码实现巨量引擎，腾讯广告、磁力引擎和自定义渠道保留扩展目录，调用时返回 `adapter_pending`，不会生成远程广告 ID 或模拟消耗。

## 接入条件

- 用户身份由 BXAGI 官方身份核验及工作区唯一映射提供。素材、账户、计划、指标和操作记录按用户查询，浏览器提交的用户 ID 不作为授权依据。
- Runtime 必须配置 `APP_ENCRYPTION_KEY`：32 字节密钥的 64 字符 hex 或 base64；凭证用 AES-GCM 加密持久化。API、导出和审计均不返回令牌、应用秘密或密文。轮换密钥前需迁移现有密文，不能直接删除旧密钥。
- 用户配置巨量引擎广告主账户、该账户实际获授权的 Access Token 和真实 `expiresAt`。初版不会构造未核实的 OAuth 链接，过期令牌必须重新授权；开发者应用本身仍需获得官方 API 权限。页面的“开始投放”就是执行授权。
- 广告预算内部及首版渠道模板均以人民币元填写。`budgetUnit:"yuan"` 必須源于该账户当前官方文档；首版不推测单位、账户额度下限或目标条件。日预算不得超过用户配置的日预算上限及总预算。
- 巨量首版接收实际 PNG 和 MP4 文件。图片按官方上传注释限制为 1.5 MiB；视频带同项目真实 PNG 封面。WebM 返回 `needs_transcode`，需先用本地生产服务或其他实际转码路径生成 MP4。其他创意格式尚未接入此广告上传适配器。

## 平台参数

`platformConfig` 保存经过具体账户与目标校验的官方项目、营销、报表模板。以下仅展示结构，不能视为任何账户都可直接上线的有效组合：

```json
{
  "budgetUnit": "yuan",
  "project": {
    "ad_type": "ALL",
    "landing_type": "LINK",
    "marketing_goal": "VIDEO_AND_IMAGE",
    "delivery_range": { "inventory_catalog": "MANUAL" },
    "delivery_setting": {
      "bid_type": "NO_BID",
      "budget_mode": "BUDGET_MODE_DAY",
      "pricing": "PRICING_CPC"
    }
  },
  "promotion": {},
  "landingUrl": "https://your-actual-store.example/product",
  "titles": ["基于已上传事实的实际广告标题"],
  "report": {
    "data_topic": "填写该账户官方报表主题",
    "dimensions": ["project_id"],
    "metrics": ["stat_cost"],
    "filters": [],
    "order_by": []
  },
  "metricMapping": { "projectId": "project_id", "spend": "stat_cost" }
}
```

投放 MP4 时额外填写 `coverCreativeId`，指向同用户、同项目实际存储的 PNG 创意。接入时服务端通过官方 `report/custom/config/get` 实际读取该账户维度、指标及项目过滤配置，缺失即阻止投放。报表通过官方“维度指标配置”接口或平台参数生成器取得，必须包含账户实际支持的项目聚合维度，并用 `metricMapping.projectId` 指定其官方字段。示例 `project_id` 需要按真实主题的字段配置核实。可添加确实可用的 `conversions`、`revenue`、`impressions`、`clicks` 映射，但必须同时出现在 `report.metrics`；不假定每种目标都有收入字段。应用下载、商城、小游戏等按真实目标填写官方条件字段，没有有效模板时阻止上线。

模板不能替换连接账户、已创建项目、上传后的素材 ID、预算和开启状态。项目 `advertiser_id` 若与连接不同则拒绝；营销不能预置 `project_id` 或 `promotion_materials`。预算及源素材由服务端编译。模板支持已核实的顶层字段、有限 JSON 大小与嵌套深度；不支持任意 HTTP 端点。落地页仅接受公开 HTTPS 域名，拒绝本机、内网、IP、凭证和非标准端口。

## 真正执行的路径

固定 API origin：`https://api.oceanengine.com`，业务鉴权 header 为 `Access-Token`。官方 int64 广告主/项目/营销 ID 以精确十进制序列化，超出 JS 安全整数的 ID 内部保留字符串，不能先用 Number 舍入。

| 阶段 | 官方接口 | 实际行为 |
|---|---|---|
| 素材上传 | `POST /open_api/2/file/image/ad/` / `/video/ad/` | `UPLOAD_BY_FILE` + 实际二进制 + 文件 MD5；只采用渠道返回素材 ID |
| 项目创建 | `POST /open_api/v3.0/project/create/` | 初始 `operation:DISABLE`，立即保存返回的真实项目 ID |
| 营销创建 | `POST /open_api/v3.0/promotion/create/` | 初始 `operation:DISABLE`，绑定刚上传的图片/视频/封面及实际标题 |
| 开始投放 | `POST /open_api/v3.0/promotion/status/update/`，随后 `/project/status/update/` | 已有营销全部创建后，`data[].opt_status:ENABLE`；后台审核和展示仍由媒体决定 |
| 暂停 | 上述状态接口 | 先停项目，再停营销；`data[].opt_status:DISABLE` |
| 状态核对 | `GET /open_api/v3.0/project/list/` / `/promotion/list/` | 写入后读回同账户、已知真实实体，核对 `opt_status` 与实际预算；启停目标与媒体审核状态分别记录 |
| 改预算 | `POST /open_api/v3.0/project/budget/update/` | `data:[{project_id,budget_mode:BUDGET_MODE_DAY,budget}]` |
| 报表 | `GET /open_api/v3.0/report/custom/get/` | 复合字段为 query JSON 字符串，逐页读取并准确匹配已创建的真实项目 ID |

暂停后恢复前先重新拉取真实累计消耗。累计消耗未知或总额度耗尽时保持暂停；恢复按原子锁中读取的当前预算配置与真实剩余额度取较小值，每次都先设置实际渠道预算并读回核实，再启用已有项目；暂停时编辑增加或减少的预算也会同步到渠道，不能绕过总预算创建新项目。累计查询包含首次创建日的完整日期，避免遗漏启用与读回之间的首笔消耗。

所有外部写入只发一次，不会自动重试。D1 领取计划并保存每次写入阶段，阻止重复点击或并发创建。网络中断、无法解释的响应或写入之后保存失败进入 `needs_reconciliation`；系统保留写入阶段和已知真实 ID，用户需在媒体后台核对，不能把再次点击当恢复方式。批量响应中的单项 `errors` 视为需要核对；顶层结果码成功不会覆盖单项失败。状态/预算写入后用官方查询接口读回实际结果才保存成功状态。已确认创建的项目不会重新创建。明确拒绝的接口返回 `blocked` 和错误码/请求编号，凭证不会写入审计。

## 真实反馈与预算闭环

手动“同步”或经服务密钥鉴权的 worker 拉取当天及自上线以来的渠道项目聚合报表。当天快照按“用户 + 计划 + 日期 + 来源”覆盖保存，重复同步不会累加同一笔消耗。保留请求编号、项目 ID、时间范围和字段映射作为来源证明。

- 缺少实际收入或转化映射时，收入、转化和 ROI 保持未知；不把点击当订单，也不把未知收入填为成功回款。
- 缺失项目行、重复聚合行、无效消耗或分页不完整时保持预算，不生成假指标。
- `autoOptimize:false` 关闭 ROI 驱动的止损、加量与素材优化任务。用户配置的日预算、总预算纪律仍生效：实际消耗达到额度时暂停，剩余总预算低于日预算时收缩实际渠道预算。
- `autoOptimize:true` 才按现有可审查策略执行 ROI 止损或加量。日预算与剩余总预算限制加量，超过边界改为建议审核。自动加量最多每 24 小时一次，避免同一快照不断复利扩张。
- 需要素材改进时创建真实反馈引用的优化任务，关联源素材和对应员工，形成新的创意方案。收入或转化未知，但真实曝光至少 1000 次且点击有效时，可生成标题与版式的 CTR 对照实验；仍保持 ROI 与预算判断，不把曝光、点击证据写成转化或利润结论。一个计划有未完成优化任务时不会不断堆积自动新任务。任务先进入 `pending`。连接 BXAGI 后，页面同步或实际运行的后台执行器将合格任务交给已有员工；员工交付的真实文件完成校验和归档，才将任务标为 completed；成品属于待验证实验，不自动上线或声称已经改善效果。视频内容实验需要对应的真实媒体生产能力。

广告渠道没有实时消费阻断事务。达到阈值后的监控暂停受媒体数据延迟、采样间隔和接口延迟影响，用户总预算是执行控制目标，不构成媒体零超支保证。

后台调度需要实际运行 worker，或外部 runner 分别调用带服务凭据的 `/api/v2/worker/tick`（预算监测）与 `/api/v2/worker/bxagi-tick`（BXAGI 派发及文件同步）。两个循环独立，远端员工请求不阻塞预算监测。未配置 runner 时用户可主动同步；页面不会宣称有正在运行的全天盯盘。

媒体报表拉取与客户订单/安装转化回传是两条不同链路。此版本没有对接客户真实订单源，也没有自动向媒体发送转化事件；配置报表收入字段不能替代完整的客户事件回传接入。

## 核实依据与验证范围

接口与 payload 字段来自巨量引擎官方 SDK [Go SDK](https://github.com/oceanengine/ad_open_sdk_go)，对应模型 `model_file_image_ad_v2_request.go`、`model_file_video_ad_v2_request.go`、`model_project_create_v3_0_request.go`、`model_promotion_create_v3_0_request.go`、`model_project_status_update_v3_0_request.go`、`model_promotion_status_update_v3_0_request.go`、`model_project_budget_update_v3_0_request.go` 及 `model_report_custom_get_v3_0_response_data_rows_inner.go`。

官方文档：[自定义报表](https://open.oceanengine.com/labels/7/docs/1741387668314126) · [维度指标配置](https://open.oceanengine.com/labels/7/docs/1755261744248832) · [转化回传鉴权](https://open.oceanengine.com/docs/1727544879404043)。

`node --test tests/ads-service.test.mjs` 使用本地注入 HTTP fixtures 验证真实表单二进制、官方 payload、用户隔离、AES 凭据保密、并发领取、未知写入不重试、指标真实性、预算上限及自动加量冷却。没有调用真实广告账户、没有广告消费；账户权限、不同目标的条件字段及媒体审核需用已授权账户完成接入验收后才能称为真实投放已验证。
