# 常读剧目只读接口适配器

本模块为后台同步提供**直接 HTTP 单页读取**，不操作浏览器、不读取 Cookie、不逐屏抓取。平台查询应读取已同步的本地剧库，后台按限流要求更新数据。页面查询耗时与常读数据的新鲜度是两个指标；本模块不能保证上游响应或全量同步在 1–2 秒内完成。

## 当前接通状态

- 2026-10-21 从官方文档页加载的公开元数据核实端原生短剧／漫剧列表协议，默认内置 `GET /novelsale/openapi/content/aweme_series/list/v1/`。来源详见 [研究记录](UPSTREAM_RESEARCH_2026-10-21.md)。
- 已实现签名、配置校验、总数分页、长整数 ID 无损解析、单页规范化及错误分类；测试使用注入的本地响应。
- **API 凭据和账号权限尚未验证，未完成真实常读数据连通验收。** `configuration().configured` 只表示协议就绪，不代表取得数据。
- 未设置环境变量时使用内置协议；显式空值或非法自定义配置返回 503，不静默回退。协议就绪不会自行启动抓取，用户仍须配置凭据并启动任务。
- 该模块只同步剧目元数据，**不下载视频、不获取或创建推广链接、不创建广告或产生投放费用**。来源链接仅用于显示，适配器不会请求它。

## 接入前需要核实

1. 常读提供的真实 `distributor_id` 和 `secret_key`；网页登录密码不能替代 API 签名密钥。
2. 一次真实响应样例与后台抽样对照；公开协议已取得，实际账号响应仍需验收。
3. 账号接口权限、限流要求、发布时间与在架状态字段的准确含义。

内置协议适用端原生业务 `19/20/21/22`：付费短剧／免费短剧／付费漫剧／免费漫剧。它们是文档业务范围，不是单条剧目的付费／免费判断依据。管理员可用服务端环境变量 `CHANGDU_CATALOG_CONTRACT` 覆盖为其他已核实协议。**协议不能通过普通用户的 HTTP 请求随意改写。** 用户凭据由内容源服务加密保存，仅在服务器解密后传入适配器；不要写入协议、源码、浏览器存储或日志。

## 协议格式

默认内置的官方端原生协议如下，无需手工配置环境变量：

```json
{
  "version": 1,
  "path": "/novelsale/openapi/content/aweme_series/list/v1/",
  "query": { "sort_field": 8, "sort_type": 1 },
  "pageSize": 100,
  "pageSizeParam": "page_size",
  "itemsPath": "data",
  "pagination": {
    "type": "page",
    "parameter": "page_index",
    "initial": 0,
    "totalPath": "total",
    "maxPage": 10000
  },
  "fields": {
    "externalId": "book_id",
    "title": "book_name",
    "episodeCount": "episode_amount",
    "releaseStatus": "publish_status"
  }
}
```

页码依据文档 `page_index >= 0` 和通用分页示例从 0 开始；真实账号验收时须核对首页与总数。默认按创建时间降序，**不是按内容更新时间增量**。`query` 仅接受抖音专辑 ID／版本 ID／番茄原书 ID，不支持剧名；本站按剧名搜索走已入库剧库。请求筛选 `publish_status` 的 0/1 与响应的 1/2/3 含义不同，默认不加状态筛选。响应状态保留原值，不自动判定投放授权。

时间格式和时区、授权状态枚举未明确；默认不映射时间。付费／免费不从单集价格、标题或账号名称推断。以下为其他已核实接口可用的**自定义结构模板**，路径占位符故意不可执行：

```json
{
  "version": 1,
  "path": "<已核实的 /novelsale/openapi/ 只读路径>",
  "query": {},
  "pageSize": 50,
  "pageSizeParam": "page_size",
  "itemsPath": "result.items",
  "pagination": {
    "type": "cursor",
    "parameter": "offset",
    "initial": "0",
    "hasMorePath": "has_more",
    "nextPath": "next_offset"
  },
  "fields": {
    "externalId": "id",
    "title": "name",
    "episodeCount": "episodes",
    "releaseStatus": "status",
    "publishedAt": "published_at",
    "sourceUpdatedAt": "updated_at",
    "businessMode": "mode",
    "sourceUrl": "source_url"
  },
  "timeoutMs": 8000
}
```

模板中的参数名、字段名仅示意配置结构，**不是已验证的常读字段**。

| 项 | 要求 |
| --- | --- |
| `version` | 必须为数字 `1`。未知属性直接拒绝。 |
| `path` | `/novelsale/openapi/` 开头的精确路径；只允许字母、数字、`_`、`-` 和路径分隔符。禁止完整 URL、查询、片段、编码转义、点路径及创建／修改等写操作词。固定源为 `https://openapi.changdupingtai.com`，固定方法为 GET。 |
| `query` | 可选静态参数对象，最多 30 项；值仅字符串或安全整数。不允许密钥、签名、分销商 ID、分页参数等覆盖。 |
| `pageSize` / `pageSizeParam` | 明确的每页数量及其参数名，数量为 `1–100`。 |
| `itemsPath` | 响应中的列表路径，支持安全的点分隔属性，例如 `result.items`。 |
| `fields` | `externalId`、`title` 必填；其他映射可省略。字段映射是相对于每条记录的路径。 |
| `pagination` | 明确配置游标或页码。页码模式支持 `totalPath` 或 `hasMorePath` 二选一，不能混用。`maxPage` 可限制页码上限。 |
| `timeoutMs` | 可选，默认 8000；必须为 `1–8000` 毫秒。超时涵盖请求和流式读取。 |

如果经文档核实为页码分页，将 `pagination` 改成以下结构；`initial` 必须为非负安全整数，且不能再设置 `nextPath`：

```json
{
  "type": "page",
  "parameter": "page_index",
  "initial": 0,
  "hasMorePath": "has_more"
}
```

`hasMorePath` 对应的响应值必须为布尔值。游标模式中，仅在 `hasMore=true` 时读取 `nextPath`；其值必须为非空字符串或非负安全整数。下一游标与当前游标重复、续页为空、缺少分页证据时，整页拒绝，不推进同步进度。总数分页要求 `total` 为非负安全整数，并核对当前页应有条数；短页、总数冲突或超出页码上限时拒绝整页，保留上个检查点。此保护不能把变化中的分页快照变成稳定快照；重复扫描与 ID 去重负责最终更新。

## 调用接口

```js
import { createChangduCatalogAdapter } from '../server/adapters/changdu-catalog.mjs';

const adapter = createChangduCatalogAdapter({ env });
const { configured, reason } = adapter.configuration();
// configured 只表示协议配置可用，不表示账号已验证或已拉到真实数据。

const page = await adapter.fetchPage({
  distributorId: decryptedSource.distributorId, // 数字形式的字符串
  secretKey: decryptedSource.secretKey,
  cursor: savedCursor ?? null,
});
// page: { items: [...], hasMore: boolean, nextCursor: string | null }
```

`fetcher` 和 `now` 只作为测试依赖注入。适配器一次只发送一个 GET，不重试、不自行遍历分页、不启动定时器。后台同步服务负责按租户和内容源隔离数据、幂等入库、分页完成后的检查点、任务租约与限流。端原生列表标注主管账号维度 3 QPS，通用限流错误建议降至 1 QPS 以下；本平台保留共享至多 1 QPS 的保守限制和退避。

## 签名与数据保护

GET 参数包括 `distributor_id`。按参数名升序排列，将每个未编码参数值转成字符串后拼接 `|`：

```text
param_str = value_1 + "|" + value_2 + "|" + ...
sign = lower_case(md5(distributor_id + secret_key + unix_seconds + param_str))
```

`header-ts` 和 `header-sign` 放入请求头。`secret_key` 只参与本地签名计算，不加入请求头、URL 或请求体。请求拒绝跳转；响应最大 2 MiB，按流读取并在超限或超时后取消。错误固定为安全中文描述，不携带上游响应体、请求 URL、签名或密钥。

## 规范化字段

| 输出字段 | 处理规则 |
| --- | --- |
| `externalId` | 字符串完整保留；JSON 整数先无损解析，超出安全数值范围的整数保留全部位数，再转为字符串保存。负数、不合法或已失真的数值 ID 拒绝。 |
| `title` | 必须为非空字符串，移除两侧空白。 |
| `episodeCount` | 仅接受非负安全整数，否则 `null`。 |
| `releaseStatus` | 保留源标量的字符串表示；不推断“已授权”或“可投放”。 |
| `publishedAt` / `sourceUpdatedAt` | 仅接受带时区的 ISO 日期字符串并转 UTC；不猜数值是秒或毫秒，其他格式为 `null`。 |
| `businessMode` | 源字段严格为 `paid` / `free` 才对应付费／免费，其他为 `unknown`。若上游编码不同，须核实后增加明确映射支持。 |
| `sourceUrl` | 仅保留不含账号密码的合法 HTTPS 地址，否则 `null`。不代表已下载、已授权或可直接投放。 |

## 错误与重试

所有错误均有 `code`、`status`、`retryable`，限流可能附 `retryAfterMs`（最多 1 小时）。适配器不在内部重试。

| 场景 | 错误代码 | 可重试 |
| --- | --- | --- |
| 显式空值／协议非法 | `changdu_contract_invalid`（503） | 否 |
| 凭据缺失／输入游标非法 | `changdu_credentials_missing` / `changdu_cursor_invalid`（400） | 否 |
| 常读业务码 410 / 411 / 412，或 HTTP 401 / 403 | `changdu_auth_failed`（401） | 否；修正配置后重新连接 |
| 常读业务码 413 | `changdu_api_not_enabled`（403），接口功能未开通 | 否；需常读开通对应业务权限 |
| 常读业务码 500，或 HTTP 429 | `changdu_rate_limited`（429） | 是；退避并尊重 `retryAfterMs` |
| 常读业务码 501 | `changdu_upstream_error`（502） | 是 |
| 网络故障／超时 | `changdu_network_error`（502）/ `changdu_timeout`（504） | 是 |
| 其他 HTTP 错误 | `changdu_http_error`（502） | 仅上游 HTTP ≥ 500 |
| 协议不符／超大响应／重定向 | `changdu_response_invalid` / `changdu_response_too_large` / `changdu_redirect_refused`（502） | 否；需要检查已验证协议 |

常读业务响应只接受数字 `code: 200` 为成功。未知业务码不视为成功。

## 验证

```sh
node --test tests/changdu-catalog-adapter.test.mjs
```

测试覆盖默认官方协议、非法覆盖、i64 字段精度、总数／游标／显式续页分页、签名与敏感参数保护、只读路径限制、业务错误分类、HTTP 错误、跳转拒绝、流量上限和完整请求超时。**测试通过只说明本地适配逻辑通过，不等于已经抓到真实常读剧目。**

真实验收还需：配置凭据；返回真实列表并核对总数／样本；实际部署执行器后核对离页同步；记录接口耗时、缓存查询耗时、最新成功同步时间；确认重启后检查点恢复和多用户隔离。真正按更新时间增量的独立队列尚未实现。

## 平台运行方式

- 用户在 **系统管理 → 内容源** 保存凭据，在 **原始素材管理 → 自动抓剧** 启动、暂停和查询。启动接口只保存队列状态并返回 `202`，不等待上游。
- `/api/v2/catalog/items` 只查询当前账号的独立剧库；搜索和翻页不请求常读。查询耗时不包含用户网络、渲染和上游同步耗时。
- `/api/v2/catalog/advance` 每次最多处理一页。无后台健康心跳时，打开的自动抓剧页面按服务端时间推进；页面隐藏或关闭后不能保证持续执行。
- 已运行的后台执行器可通过既有 `/api/v2/worker/background-tick` 推进目录，单轮最多 20 页、预算 25 秒，仍遵守所有用户共用的 1 QPS 闸门。无到期任务立即退出；该代码不等于执行器已部署。
- 每页采用参数化 JSON 批量写入，与检查点在同一事务提交。抓取租约与版本保护覆盖暂停、账号切换和密钥更新；换分销商后不混用旧账号的目录。
- 自动同步在本轮完成后至少等 60 秒再扫描，保留已有记录并更新变化；不是实时推送。持续失败最多自动重试五次，限流等待遵守上游 `Retry-After`。最近 128 个游标哈希用于循环检测，每轮最多 10,000 页，触发保护后停止并保留断点。
- 页面可以随时暂停正在抓取或等待下一轮的任务。暂停后不会自动恢复，需要用户点击继续。

运行本地协议、持久化和界面调度回归：

```sh
node --test tests/changdu-catalog-adapter.test.mjs tests/catalog-api.test.mjs tests/catalog-ui.test.mjs tests/background-scheduler.test.mjs
```

这些测试使用 SQLite 和注入响应；包含 50,000 条剧目查询基准，没有访问真实常读。部署会应用 `0005_melodic_loners.sql` 与 `0006_sad_joseph.sql` 两个增量迁移，不删除旧业务数据。
