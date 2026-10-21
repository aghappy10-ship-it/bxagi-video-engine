# BXAGI 登录后的真实员工协议

本实现依据 2026-10-14 从 BXAGI 官网实际加载的公开客户端源码，并通过协议夹具和受限现场任务逐项核对。当天一个官方市场视频优化专家的 CodeActAgent 任务已确认真实输入上传、WebSocket 指令回执、PNG 与文案输出、归档和授权下载；首版中文错误后，同一任务的 v2 流程测试样张通过完整解码与视觉检查。这个单次结果不代表商业素材或全部行业质量已验收，详见 [验证记录](VERIFICATION.md)。

`liveVerified: false` 保留为通用适配器的能力边界，不因单次调用成功就承诺所有账号、节点和素材类型已验收；它也不表示从未进行上述实际调用。HTTP 2xx、启动 READY、消息回执和员工结束状态都不能单独证明交付合格。

公开来源：

- [主客户端](https://bxagi.xinlx.com/assets/index-Dh5Fblev.js)：员工 API、会话 API、启动任务、运行时鉴权。
- [员工工作台](https://bxagi.xinlx.com/assets/sessions-view-BZ8IbSWa.js)：已雇佣员工响应字段、可用性和会话状态。
- [新建会话](https://bxagi.xinlx.com/assets/use-create-conversation-BhU7tQ03.js)：创建响应的启动任务 ID 与 `task-` 视图过渡。
- [会话客户端](https://bxagi.xinlx.com/assets/ConversationContent-CXyTGs7n.js)：`READY` 到真实会话的过渡、WebSocket 消息、事件字段。
- [工作区文件客户端](https://bxagi.xinlx.com/assets/file-preview-request-store-CaWzilGG.js)：同源文件上传、节点代理下载。
- [员工市场客户端](https://bxagi.xinlx.com/assets/employee-hire-Cl-Ko4Cm.js)：模板名称、分类、技能和角色详情字段。
- [工作区文件浏览器](https://bxagi.xinlx.com/assets/TimeMachinePanel-B3_HnGxQ.js)：文件列表和读文件字段。
- [会话文件浏览器](https://bxagi.xinlx.com/assets/CodeTab-CLNY1nGp.js)：上传时将目录列表返回的选中路径直接传给可选 `path`，不添加工作区前缀。
- [执行智能体定义](https://bxagi.xinlx.com/assets/agents-WDcGH4eQ.js)：规划与执行智能体的默认工具定义；静态定义不等于当前运行时工具权限已核实。

源码 URL 包含构建版本，后续 BXAGI 升级可能替换这些路径。接入模块 `server/bxagi-workforce.mjs` 固定连接 `https://bxagi.xinlx.com`，不接受用户传入服务地址，不执行下载的 JavaScript，不直接连接响应中的 `agent_server_url` 或 `conversation_url`。

## 员工市场与安装核验

认证为服务端保存的 BXAGI `Authorization: Bearer <access token>`。调用者须在登录时通过 BXAGI 身份接口验证 `subject`；本模块不信任浏览器提交的用户 ID。

| 实际 API | 观察到的响应/用途 |
| --- | --- |
| `GET /api/v1/employees/templates?locale=zh` | 唯一选人来源；模板包含 `id,name,description,category,tags,skills,sub_agents` |
| `GET /api/v1/employees/pricing` | 官方价格与套餐依据；未知价格不视为免费 |
| `GET /api/v1/employees/mine?include_inactive=true&locale=zh` | 当前账号安装记录与可用性，只用来核验所选市场岗位的执行资源 |
| `GET /api/billing/free-solo-quota` | 当前 Solo 免费名额 |
| `GET /api/settings`、`GET /api/nodes` | 只提取云端模式白名单字段及授权节点状态，不公开设置中的秘密 |
| `GET /api/v1/employees/templates/{id}/roles`、`.../{id}/schedules` | 可选岗位职责详情及默认日程核验 |

`server/bxagi-marketplace.mjs` 从官方模板建立候选，再按精确模板 ID 连接当前账号的安装记录，核验员工根会话、账号归属与授权节点。市场候选标识为 `bxagi:market:<templateId>`；关键字段包括：

```js
{
  id: 'bxagi:market:' + templateId,
  marketId: templateId,
  providerId: templateId,
  provider: 'bxagi',
  name, description, skills,
  roleCandidates, sceneKeywords,
  marketVerified, activationState, sourceVerified,
  usable, conversationId,
  liveVerified: false
}
```

`roleCandidates` 和 `sceneKeywords` 是根据市场元数据得到的路由线索，不证明视觉理解、媒体编辑或广告工具已经接通。可用性未知、安装归属不符、缺少市场证明或授权节点不可用时不可派发。历史会话和历史 `listEmployees()` 发现结果不作为产品的新任务候选目录，也不能作为新市场任务的成果证明。

显式开启 `BXAGI_MARKET_AUTO_ACTIVATE_FREE` 后，只有实时确认零费用 Solo 条件、免费名额充足、目标为新岗位且无默认日程时，才允许调用官方 `POST /api/v1/employees/install`。先持久保存待核对安装记录，再提交并核验真实回执；同账号安装串行检查名额，结果不明不重试。不自动付费购买、续费或创建账户。下文固定内置通用助理的每周反思例外只属于独立 bootstrap，不改变通用市场激活规则；其他含默认定时任务的员工模板仍不能自动安装。

## 官方大管家

官方大管家是独立的统一派发入口：把一句话派给合适的员工，兜底通用助理。它与本站 `server/bxagi-planner.mjs` 的协调员工任务不同，不能将现有协调流程改名后当作已接入官方大管家。本次实际视频试产通过市场员工生产路径派发，未由大管家调度。

公开依据为 [大管家 API 客户端](https://bxagi.xinlx.com/assets/butler-BE_lnDrK.js)、[大管家页面](https://bxagi.xinlx.com/assets/butler-De-yK0nI.js) 和 [官方中文说明](https://bxagi.xinlx.com/locales/zh-CN/translation.json)。这些源码仅被读取，没有执行；客户端可见契约如下：

| 官方接口 | 已观察到的契约 |
| --- | --- |
| `GET /api/v1/feature-flags` | `butler_mode` 控制页面与大管家端点；现场只读查询曾返回 `true`，不代表任意账号的派发权限已验收 |
| `POST /api/v1/butler/dispatch` | JSON 为 `{text,mode:"command",client_message_id}`；前端使用去连字符 UUID，处理 `accepted,conversation_id,error`，输入控件限制 500 字符 |
| `GET /api/v1/butler/dispatches` | 查询 `limit,offset`，可选 `source,device_id,status`；客户端读取 `items`，以及记录的 `client_message_id,conversation_id,route.employee_name,status,created_at,text,ack_text` |

客户端状态包括 `dispatched,running,completed,failed,expired`；结果页面嵌入对应员工会话。500 字符是已观察到的前端限制，服务端限制未独立验证；`client_message_id` 的存在也不等于服务端幂等保证。尚未验证大管家的市场选人范围、自动安装行为、计费规则、派发幂等、会话逐条归属及成果检查能力，未发现可证实的纯规划或候选白名单接口。

`server/bxagi-butler.mjs` **默认只读**，提供能力开关、当前 BXAGI 账号派发历史和按已保存 client ID 的原因核对。它固定官方域名，使用服务端 BXAGI 凭据，拒绝重定向，限制响应大小与超时；普通历史输出仅保留记录 ID、会话 ID、脱敏岗位名称、状态和时间，不透传 `text`、`ack_text`、错误正文或未知字段。原因核对固定读取最多 100 条历史，只接受精确 client ID 的唯一匹配；失败摘要限 400 字并脱敏，未知结构、配置与环境转储不返回，没有可靠原因则为 `null`。默认 `dispatchEnabled:false`；`marketRoutingVerified:false`、`ownershipVerified:false` 和 `deliveryVerified:false` 保持未核实边界，当前账号读取不替代逐条会话归属核验。

只有显式 `enableCoordinationDispatch:true` 才提供 `dispatchCoordination({text,clientMessageId})`，提交官方 `{text,mode:"command",client_message_id}`。当前唯一写调用入口为限时、固定账号和生产任务的内部 `butler-diagnostic` 能力，发送不超过 500 字的工具与清单交付建议请求；它不自动应用建议。诊断任务按账号、BXAGI subject 和生产任务 ID 建立独立持久记录，先保存 32 位 client ID、固定文本 hash、原子租约和待核对写标记，再发送一次。重复或并发请求只使用同一记录；未知结果停止重发，后续只能只读核对。这个客户端单次锁不证明 BXAGI 服务端提供 exactly-once 派发。被接受且有合法会话 ID 仅记录 `advice_dispatched`，不代表建议有效、会话归属已验收或素材生产完成；只有核实新会话归属后才读取建议。文本中的禁执行要求也不证明上游权限被隔离。

2026-10-14 14:04:56Z 唯一真实诊断 POST 使用 client ID `b5e9fe5aa81d49a0916c85fc207f627b`，未取得有效派发回执，先记录 `advice_needs_reconciliation`。官方历史显示路由为“通用助理”、状态 `failed`、会话 ID 为 `null`。14:12:30Z 同 ID 只读核对取得失败原因：“404: 未找到员工 general_assistant 对应的主对话”，本地诊断记录转为 `advice_failed_remote`，结果不明标记解除。这次大管家调用没有帮助视频生产；原视频任务和文件保持原样，没有安装通用助理、改写主会话或重派诊断。

`buildBxagiButlerCoordinationBrief()` 仅构造不超过 500 字符的协调草稿，包含有界事实和官方市场候选 ID，要求只给岗位建议与步骤，禁止安装、购买、生产、投放和修改预算。该纯函数不发送任务，文本约束不声称上游已提供对应权限隔离。大管家记录显示 completed 仍不能完成本站素材任务；成品完成依旧需要实际文件收取、内容检查及归档。

## 专属执行会话

| 实际 API | 观察到的响应/用途 |
| --- | --- |
| `GET /api/v1/app-conversations?ids={id}` | 会话数组；读取匹配的 `id`，以及 `node_id,selected_repository,memory_space_name,agent_type,employee_id,execution_status,sandbox_status,participants` |
| `POST /api/v1/app-conversations` | 创建响应包含启动任务 `id`；客户端还读取 `agent_server_url`，本模块不暴露或连接这个地址 |
| `GET /api/v1/app-conversations/start-tasks?ids={taskId}` | 任务数组，包含 `id,status,detail,request,app_conversation_id` |
| `GET /api/v1/agents` | 官方已注册执行智能体；能力标签不当作工具权限证明 |

`createConversation({employee,jobId})` 先读取员工已有授权会话、安装账本和节点，复用核实的节点、工作区、记忆空间，为本地 UUID 任务创建专属会话。提交 `employee_id,node_id,selected_repository,memory_space_name,agent_type,title,parent_conversation_id` 及已有仓库分支/提供商，并显式设置 `enable_plan_mode:false`。原资源为 `PlanAgent` 时先从官方智能体目录核实 CodeActAgent，再显式创建执行模式；缺少工作区采用 `default`，旧响应未提供 Agent 类型时采用 `AgiAgent`。

生产编排在读回实际会话并确认同一员工后检查 `agent_type`；若为 PlanAgent 或 ReadOnlyAgent，在启动运行时、上传文件和发送指令前停止，不能把市场岗位名称当作执行权限。合法 UUID 的带连字符与紧凑形式仅用于身份等价核对，实际请求仍保留上游返回的 ID。

创建阶段不发送 `initial_message`；需要等待实际素材上传后再发送工作任务。模块返回 `{startTaskId,liveVerified:false}`。

启动任务 `READY` **仅表示真实会话 `app_conversation_id` 创建完成**。它不代表员工完成素材、文件已入库或广告已投放。`getStartTask()` 返回 `{startTaskId,status,conversationId,liveVerified:false}`；`READY` 没有会话 ID 会被拒绝。

会话状态在公开 UI 中包括 `running,awaiting_user_input,awaiting_user_confirmation,idle,paused,stopped,finished`；Sandbox 状态包括 `RUNNING,STARTING,ERROR,PAUSED,STOPPED,MISSING`。模块保留实际返回值，不把无法识别的状态映射为成功。

上传前以 `GET /api/v1/conversations/{id}/runtime/ensure?project_name={ownedRepository}` 核验运行环境，接受 `ready,starting,missing`，不公开运行时地址或密钥。这是可能启动运行时的接口，只读成果收取不能调用它。

## 上传与任务消息

`uploadFile({conversationId,directory,filename,blob})` 调用实际同源接口：

```text
POST /api/v1/conversations/{conversationId}/files/upload?path={directory}
Content-Type: multipart/form-data (由运行时自动生成边界)
file: 实际二进制文件
```

上传目录限定为 `bxagi-advertising/<UUID>/input`。底层上传协议允许非空文件最多 64MiB，当前平台编排向员工转交单个输入的上限为 16MiB；原始 R2 存储上限为 64MiB。路径穿越、编码穿越、控制字符和外部 URL 不可用。上游未给出固定上传业务 schema，因此返回值只记录 HTTP `transportStatus` 与请求的相对路径，不宣称已经产生优化成品。

`CodeTab` 将选中目录原样传给 `params.path`，不强加 `/workspace/` 前缀。现场任务已核实上述任务相对目录：会话文件视图和节点代理均能读取实际源文件与 brief，员工也在同任务 output 目录写出文件。这是该账号与节点的一次实证，不保证所有部署的存储行为。直接运行时的 `/api/file/upload/{encodedAbsolutePath}` 属于另一接口，不能据此改变会话文件代理契约。

主客户端虽然导出 `POST /api/conversations/{id}/events`，现场调用返回 404，当前不使用它派发，也不在 WebSocket 失败后回退重发。`sendMessage()` 采用官网实际聊天的 WebSocket 主通路：

```text
wss://bxagi.xinlx.com/sockets/events/{conversationId}?resend_all=true&resend_limit=100&resend_sort_order=TIMESTAMP_DESC
Sec-WebSocket-Protocol: bxc-jwt-<server-only token>
{"role":"user","content":[{"type":"text","text":"任务内容"}]}
```

Worker 使用固定官方 HTTPS 地址发起 WebSocket Upgrade；令牌只在服务端子协议头，不进 URL。先重新读取所属会话及已有事件；若已找到该任务完整指令的真实 user MessageEvent，则返回此前已送达回执。否则只握手一次、发送一次，并要求匹配同会话、用户角色、消息全文和事件 ID 的实际回显。保存 `eventId`、`alreadyDelivered` 或 `deliveryEvidence`；`freshEchoVerified:false` 不把回放事件误称为刚刚发送的因果证明。现场已取得真实回执，但回执不是员工完成或文件合格证明。

## 真实输出文件

本模块使用公开文件客户端实际提供的节点代理，不连接员工运行时外域：

```text
GET /api/nodes/{nodeId}/file/download-relative/{encodedRelativePath}?project_name={repository}
Authorization: Bearer <server-only token>
X-User-Id: <server-verified subject>
```

文件路径逐段编码，保留 `/`。同源代理由 BXAGI 继续验证节点、工作区与用户权限。关联 `conversation` 必须由编排服务先通过当前用户的真实会话查询获得；浏览器不能直接指定任意节点对象给下载方法。

输出限定在 `bxagi-advertising/<UUID>/output/...`。`readArtifact()` 返回响应头过滤后的 `Response`，实际字节流最多 16MiB，声明长度和流式计数均受限，重定向被拒绝。`readManifest()` 只读取该任务输出目录的 `manifest.json`，最多 256KiB，必须是 JSON 对象。

manifest 是广告编排服务对员工提出的交付格式要求，不是声称 BXAGI 已有的新接口。编排层还须验证任务 ID、版本、源素材归属、输出 MIME/魔数、大小、尺寸和实际文件内容，保存到 R2 后才完成素材任务。`readManifest()` 本身不会把任意对象转换为成功成品。清单通常声明完整的任务 output 相对路径；若员工仅返回安全裸文件名且与 `filename` 精确一致，可将其解析到当前任务的 `bxagi-advertising/<UUID>/output/`。这仅规范当前任务内的路径，不改变远端文件或再次派发。含目录、绝对路径、URL、编码穿越或路径穿越的非任务路径不能借此被接受；重复路径仍被拒绝。

PNG 检查完整区块、CRC 和有界解压；MP4 检查完整容器、唯一视频轨道及视频头/媒体时间头中的尺寸和时长。MP4 的 `width,height,duration` 是实际文件容器元数据，不是逐帧解码结果；`technicalChecks.fullDecode:false` 保持明确，不自动证明 H.264、yuv420p、24fps、faststart、约 10 秒的播放、运动效果或中文完整可读。这些规格仍需对收取文件做独立编码探测、完整解码及视觉验收。结构检查不保证画面或文字正确。现场首版 PNG 曾通过结构检查但中文错误，已标记 rejected 并保留历史；补充有许可的中文字体后，同一员工交付 v2，通过完整解码、文字可读性及事实内容检查。该流程测试样张的通过不能代替商业质量或其他场景验收。

## 事件、错误与执行边界

`getEvents()` 使用 `GET /api/v1/conversation/{id}/events/search?limit=100&sort_order=TIMESTAMP_DESC`，验证 `{items:[...]}`。保留可见 `MessageEvent` 的文本与 `ActionEvent/ObservationEvent` 的类型、执行状态更新；去除任意动作参数、图片 URL、凭据与 runtime 密钥。`FinishAction` 或“完成了”文本不能替代实际输出入库。

执行状态按返回事件顺序和当前指令回执边界判断，不用上游事件时间与本地时钟直接比较来推断完成。补救消息已确认但新事件尚未索引时，使用本地回执后的短暂宽限避免读取旧 finished。员工明确结束而 manifest 缺失时记录 `bxagi_delivery_missing`，不无限等待、不自动重发；手动收取可重试检查真实文件。

`collectProduction(id)` 是独立收取路径：重新核验账号、市场岗位、安装根会话、实际任务及原输入归属，只读远端文件并在本地验证归档。已确认发送的受限任务可在原派发期限后收取；这不授权创建会话、启动运行时、安装员工、上传或再次发送。

显式执行模式修复使用官方 `POST /api/v1/agents/switch`，仅针对已绑定任务与员工，必须以实际会话读回确认结果。当前历史 PlanAgent 任务的一次切换未核实，保留 `needs_reconciliation`，未重复切换。修复派发需要独立的新鲜任务授权、原子锁和写前持久标记；任何远端写入结果不明都停止自动重试。

所有请求使用有限超时（默认 15 秒，上限 20 秒），禁用重定向；JSON 和文件响应都有流式大小限制。错误不会复述上游响应正文、网络异常详情或凭据。不自动重试写请求；POST 连接中断、超时、5xx 或无法解析回执时保留 `uncertain: true`，编排服务应核对远端状态而不是重复新建任务。

本模块只承担 BXAGI 真实协议适配。用户会话管理、任务派发租约、文件入库、素材版本、预算约束和广告平台写入由各自服务负责。AGI 的文本回答不能替代真实广告账户授权、广告平台成功读回或转化数据。

## 验证

`tests/bxagi-workforce.test.mjs`、`tests/bxagi-marketplace.test.mjs`、`tests/bxagi-message-transport.test.mjs` 及编排测试覆盖市场与账号归属、专属执行会话、运行时状态、输入与消息协议、真实字节校验、写入不明状态及超时。这些自动化测试使用夹具，不是远端执行证据。现场单次生产的具体文件与质量结论单独记录在 [VERIFICATION.md](VERIFICATION.md)；未进行真实广告投放。

## 2026-10-15 通用助理初始化与官方大管家协调

新增 `bxagi-butler-bootstrap.mjs`，使用当前官方 general-chat、sessions-view、employee-hire 客户端的已观察协议：固定内置 `general_assistant` 免费初始化或 `conversation_exists:false` 主会话修复调用 `/api/v1/employees/install`。官方固定内置免费标签、模板、默认日程策略、账号自有在线节点与安装状态均重新核验；过期/付费/未知状态不走此路径，不调用续费或重置。独立持久预约与原子租约记录发送前 pending；只有安装回执和真实根会话归属读回一致才视为 ready，未知发送不自动重试。普通 BXAGI 用户可通过空体 `POST /bxagi/butler/initialize` 请求初始化。

官方市场说明雇佣后会自动创建模板日程；公开安装客户端未提供已证实的跳过日程参数。2026-10-15 对固定模板只读取得的唯一“每周反思周报”已审核为内置记忆维护：回顾工作与用户纠正，核对、补充和清理 `MEMORY.md` 及知识图谱中的教训，最后在本会话输出四节周报。其正文不包含外发、购买或广告投放指令，作为已请求启用大管家的附属能力纳入固定策略，不因此授予任意定时任务权限。

该例外要求恰好一条日程，名称精确为“每周反思周报”、类型为 `weekly`，完整 `message` 只统一空白后与代码中的审核常量精确匹配。`config` 必须恰好包含 `weekly_day`、`weekly_time`、`drift_minutes`：星期接受整数 0–6、完整小写英文星期或“周一”至“周日”／“星期一”至“星期日”；时间为合法 `HH:mm`；漂移为 0–60 的整数。这些是本地接受范围，不声称已观察到官方使用每一种编码。额外任务、未知字段、正文变化或非法配置继续阻止初始化；`enabled` 缺失或为 `null` 只表示未覆盖默认，不能解释为已停用。

匹配后 readiness 返回 `standardBuiltinReflection:true`，仅证明符合固定策略，不证明周报已创建或执行。私有 `butler-inspection` 可显式读取脱敏正文预览、时间白名单、字段名与逐项策略检查；普通 readiness 和初始化响应不返回正文。此路径不单独创建、触发或修改定时任务，也不为普通市场激活增加日程许可开关。

2026-10-15 只读核对当前官方构建，确认 `general_mode` 与 `butler_mode` 是独立的客户端开关，不能把两者同时为真当作大管家初始化前提：

- [大管家页面 `butler-DEwHXofN.js`](https://bxagi.xinlx.com/assets/butler-DEwHXofN.js) 的页面访问与派发历史读取仅检查 `butler_mode`，该文件没有 `general_mode` 条件。[大管家 API 客户端 `butler-DWlwPouw.js`](https://bxagi.xinlx.com/assets/butler-DWlwPouw.js) 使用固定官方派发接口。
- [通用聊天页面 `general-chat-YJXoaxho.js`](https://bxagi.xinlx.com/assets/general-chat-YJXoaxho.js) 使用 `general_mode` 控制 `/chat` 页面。[员工市场 `employee-hire-Bezwyiv5.js`](https://bxagi.xinlx.com/assets/employee-hire-Bezwyiv5.js) 仅在 `general_mode` 开启时从普通目录排除固定 `general_assistant` 模板，并改为展示独立内置卡；关闭时该模板仍保留在普通市场目录。专属卡片的可见性不等于该员工的安装权限。
- [主客户端 `index-Clajrf8i.js`](https://bxagi.xinlx.com/assets/index-Clajrf8i.js) 分别控制通用助理与大管家的导航项，其员工安装请求函数没有 `general_mode` 前置条件。上述结论来自公开客户端，不能替代服务端的实际授权结果；官方拒绝仍按真实响应处理。

因此 bootstrap 的 `enabled` 仅依据实际 `butler_mode`，另以 `generalChatEnabled` 返回通用聊天页面开关，不修改上游开关。固定模板、免费承诺、过期状态、日程、节点与主会话归属检查继续独立执行。这项客户端协议修复本身不能证明初始化或大管家调度已验收。

`BXAGI_BUTLER_ENABLED=true` 时，生产任务新增 `official_butler` 协调阶段：向官方大管家发送最多500字的候选市场岗位、项目目标和实际素材类型/数量摘要，请求岗位及步骤建议。保存本次随机 requestId、输入签名、发送前事件边界与回执；只接受当前账号通用助理主会话里本次完整用户指令后的匹配 JSON 回复，严格核验当前可执行市场岗位。官方接口本身不保证目标会话；不匹配回执保留实际会话ID及未知标记而不重派。协调建议核实后，现有市场生产流程另行建立执行会话、上传素材、获取真实指令 ACK、回收清单与文件。建议不被当成生产完成或广告授权。

已有任务按持久化 mode 继续，开关变化不迁移运行中的任务。线上实测结论另记 `VERIFICATION.md`；本段描述实现协议，不声称现场验收通过。

初始化、调度与实际产出分别留证：初始化需要安装回执和所属根会话读回；调度需要官方回执、所属会话及本次事件边界内的有效建议；成品需要执行员工的真实交付文件收取、技术检查与归档。任一阶段成功均不能替代后续阶段的证据。
