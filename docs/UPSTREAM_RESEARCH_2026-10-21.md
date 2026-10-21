# 常读 OpenAPI 与 Vibbit 参考核查

核查日期：2026-10-21。常读是 BXAGI 的业务数据上游；Vibbit 是产品参考。本文核实公开契约，不代表账号已有接口权限、真实取数成功或相关升级已经部署。

## 来源与证据范围

- [常读上手指引](https://www.changdupingtai.com/sale/open-api-document?page=getting-started)及其[公开文档数据](https://www.changdupingtai.com/node/api/platform/distributor/tcc/string/bff_tcc/openapi_getting_started)。
- 文档页面实际加载的[公开接口元数据](https://www.changdupingtai.com/node/api/platform/distributor/tcc/idl_meta)。本次取得 7 个服务、41 个端点；元数据自身的 `generatedAt` 为 `2026-08-24T12:23:50.483Z`，不是本次核查日期。
- 公开页面的 [main.82997699.js](https://lf-new-media.novelquickappstatic.com/obj/novel-fe-new-media/novel-fe/platform-cn/static/js/main.82997699.js)及文档页面脚本用于核对业务类型枚举、标签和深链规则。文档脚本明确使用 `interface_name=<endpoint.name>`；元数据本身没有 `interface_name` 字段。
- 原始证据已保存在项目上级 `research` 目录的 `changdu-openapi-metadata.json`、`changdu-getting-started.json`、`changdu-public-docs-chunk.js` 和 `changdu-public-main.js`。不将完整元数据或第三方代码复制进本文。

本次仅读取公开文档及静态资源，没有登录、读取浏览器凭据、调用签名业务接口或创建推广链。此次证据补足了 2026-10-20 研究中“未取得原生列表和已有推广链契约”的缺口；账号权限与真实响应仍待验证。

## 接入地址、签名与业务范围

业务 API 的固定 origin 是 **`https://openapi.changdupingtai.com`**。`www.changdupingtai.com` 用于文档页面，二者不能混用。

上手指引要求向常读商务取得 `distributor_id` 和 `secret_key`。不同渠道使用对应的 `distributor_id`；能登录网页不等于有 OpenAPI 密钥或某个业务权限。GET 请求签名规则如下：

1. 查询参数包含 `distributor_id`，按参数名升序排列。
2. 拼接各个未编码参数值，每个值后加 `|`，得到 `param_str`。
3. `header-sign = lower_case(md5(distributor_id + secret_key + ts + param_str))`。
4. `header-ts` 是秒级 Unix 时间戳的字符串；两者放请求头。`secret_key` 仅参与服务端计算，不发送给上游。

上手指引的概览示例曾写 URL 参数 `ts/sign`，但其详细 Python 示例和端点 schema 均使用 `header-ts/header-sign` 请求头，应按后者实现。响应业务码 `200` 表示成功；文档元数据接口自身的 `code: 0` 不是业务 API 成功码。

原生接口的字段注解均为 `api.appTypes: "19,20,21,22"`。元数据的 `appTypesText` 仍是数字；以下准确标签来自公开主脚本中的枚举和显示映射：

| appType | 枚举 | 公开标签 |
| --- | --- | --- |
| 19 | `AwemeNativePaySeries` | 抖音端原生付费短剧 |
| 20 | `AwemeNativeFreeSeries` | 抖音端原生免费短剧 |
| 21 | `AwemeNativePayMotionComic` | 抖音端原生付费漫剧 |
| 22 | `AwemeNativeFreeMotionComic` | 抖音端原生免费漫剧 |

这些数字是契约适用范围，**不是原生列表已公开的筛选参数**。两个原生列表响应也没有逐行 `app_type` 字段；BXAGI 应保留经核实的渠道及业务类型归属，不能根据剧名、分类或价格猜测付费／免费。

## 原生短剧／漫剧列表

[GetAwemeSeriesListOpen 文档](https://www.changdupingtai.com/sale/open-api-document?interface_name=GetAwemeSeriesListOpen)

**GET `/novelsale/openapi/content/aweme_series/list/v1/`**，文档频率为每主管账号 **3 次/秒**。

| 参数 | 类型／要求 |
| --- | --- |
| `distributor_id` | 必填 i64，渠道 ID |
| `page_index` | 必填 i32，不超过 10000；端点未说明从 0 还是 1 起算 |
| `page_size` | 必填 i32，不超过 100 |
| `query` | 可选字符串，仅支持抖音专辑 ID、抖音版本 ID、番茄原书 ID；其他内容会报错，不能直接传剧名 |
| `gender` | 可选 i32：0 女频、1 男频、2 通用 |
| `publish_status` | 可选 i32；请求说明是 0 未发布、1 已发布 |
| `sort_field` | 可选 i32，仅支持 8 创建时间，默认按创建时间排序 |
| `sort_type` | 可选 i32：1 降序、2 升序，默认降序 |
| `start_time` / `end_time` | 可选字符串，时间范围筛选；未给格式、时区或边界包含规则 |

另需两项签名请求头。响应为 `code/message/total/data[]`，没有 `has_more/next_offset`。每条记录包括：

- `book_id`（i64，抖音版本 ID）、`playlet_id`（i64，抖音专辑 ID）、`book_name`、`episode_amount`。
- `thumb_url`、`gender`、`category_text`、`abstract`、`douyin_nick_name`、`single_price`。
- `publish_status`、`publish_time`、`estimate_publish_time`、`permission_status`、`create_time`、`delivery_status`。

这里 `publish_status` 的**响应**说明是 1 未发布、2 已发布、3 已下架，与请求筛选编码不同，不得复用同一枚举。`permission_status` 仅注明“授权状态”，未给原生数值定义；`delivery_status` 为可投状态布尔值。时间字段均为字符串，未给准确格式；`single_price` 也未明确金额单位。

`book_id` 是版本 ID，不能与专辑 ID或其他目录的内容 ID 混同。i64 ID 必须在 JSON 解析阶段保留精度，再以字符串保存；事后将已失真的 JavaScript Number 转成字符串无法修复。

分页应使用这个接口的 `total` 和核实后的页码规则，不能假设存在通用 `has_more`。通用上手示例使用 `page_index: 0`，但它调用的是活动接口，不能单凭示例认定原生列表页码起点。创建时间排序也不是内容更新时间游标，不能据此宣称能捕获所有授权、上下架变化。

## 读取已有推广链，与创建分开

[GetAwemePromotionListOpen 文档](https://www.changdupingtai.com/sale/open-api-document?interface_name=GetAwemePromotionListOpen)

**GET `/novelsale/openapi/aweme/promotion/list/v1/`**，仅支持端原生应用，每主管账号 **3 次/秒**。

- 必填查询参数：`distributor_id`（i64）、`page_index`（i32，≤10000）、`page_size`（i32，≤100）、`begin_date`、`end_date`（字符串）。
- 可选查询参数：`book_id`（i64，抖音版本 ID）、`promotion_id`（i64）。
- 必需签名请求头：`header-ts`、`header-sign`。
- 日期参数只写“起始日期／结束日期”，**未注明格式、时区或区间边界**，不能把自行选择的 `YYYY-MM-DD` 当作已确认契约。
- 响应为 `code/message/total/data[]`，可选 `is_truncated` 表示受系统最大条数限制而截断。出现截断不能标为全量完成；需要缩小查询范围或按官方说明处理。

| 响应字段路径 | 含义 |
| --- | --- |
| `data[].aweme_promotion_info.promotion_id` | 已有推广链 ID |
| `data[].aweme_promotion_info.promotion_name` | 推广链名称 |
| `data[].aweme_promotion_info.promotion_url` | 已有推广链地址 |
| `data[].aweme_promotion_info.create_time` | 创建时间 |
| `data[].aweme_book_info.book_id` | 抖音版本 ID |
| `data[].aweme_book_info.book_name` | 作品名称 |
| `data[].aweme_book_info.item_num` | 剧集数量 |
| `data[].aweme_book_info.aweme_publish_name` | 发布账号名称 |
| `data[].ad_panel_open_data` | 可选广告面板信息：模板 ID、名称、起始剧集 |
| `data[].purchase_panel_open_data` | 可选付费面板信息及 `product_list[]`；其中 `pay_fee` 明确为分 |

读取现有链接不需要新建。另一个 [CreateAwemePromotionUrlOpen](https://www.changdupingtai.com/sale/open-api-document?interface_name=CreateAwemePromotionUrlOpen) 是 **POST `/novelsale/openapi/aweme/promotion/create/v1/`**，必填 `distributor_id/book_id/purchase_panel_template_id/promotion_name`；它是独立写操作，本次未调用，也不应成为目录同步的隐含步骤。

通用已有推广链另有 GET `/novelsale/openapi/promotion/list/v1/` 和 `/novelsale/openapi/promotion/list/v2/`，均标注每主管账号 30 次/秒，使用 `offset/limit` 与 `has_more/next_offset`。V1 `limit` 最大 1000，V2 最大 100；响应分别是 `result[].promotion_url` 与 `result[].promotion_info.promotion_url`。它们与原生接口的路径、分页和字段不同，不能直接替换。

## 通用短剧目录、章节与视频素材缺口

[GetSeriesListOpen](https://www.changdupingtai.com/sale/open-api-document?interface_name=GetSeriesListOpen) 为 **GET `/novelsale/openapi/content/series/list/v1/`**，每主管账号 10 次/秒，必填 `distributor_id/page_index/page_size`。可选 `query` 只支持短剧 ID；其他筛选包括 `gender/creation_status/permission_statuses/delivery_status`。响应 `code/message/total/data[]`，作品信息位于 `data[].series_info`，定价信息位于 `data[].media_config`。

通用目录的 `permission_status` 明确为 2 无授权、3 独家授权、4 普通授权，1 有授权已废弃；`delivery_status` 为 0 不可投放、1 可投放、2 即将下架。**这些定义不能未经确认套到原生接口。**

| 接口 | 请求及返回 | 能证明什么 |
| --- | --- | --- |
| GET `/novelsale/openapi/content/chapter_list/v1/`（[GetBookChapterListOpen](https://www.changdupingtai.com/sale/open-api-document?interface_name=GetBookChapterListOpen)） | 必填 `distributor_id/book_id`；返回 `data[].chapter_id/chapter_name/order`，文档写短剧返回全部章节、网文仅前 30 章；10 次/秒 | 章节索引，未给视频地址 |
| GET `/novelsale/openapi/content/chapter_detail/v1/`（[GetChapterContentOpen](https://www.changdupingtai.com/sale/open-api-document?interface_name=GetChapterContentOpen)） | 必填 `distributor_id/book_id/chapter_id`；返回 `chapter_name`，`content` 适用网文类型 1/3/8/12/15/18，`chapter_labels` 适用短剧类型 4/7/10/13；10 次/秒 | 文本或章节标签，不能当作短剧视频下载 |

当前公开元数据中的 `MaterialSvcOpenService` 名为“素材服务”，但 **`endpoints` 为空**。遍历全部端点响应字段后，没有找到经确认的短剧／漫剧源视频 URL、授权下载清单或素材下载协议。推广创建接口的 `download_url` 明确标为商店下载链接；通用推广列表中的下载字段处于推广信息结构，不能据字段名认定为视频源文件。

因此本次可推进“目录 → 已有推广链”的元数据接入；“授权文件 → 下载 → 文件校验 → 可生产素材包”仍需常读提供正式素材接口或官方导出方式。章节列表的 `api.appTypes: "*"` 也不能替代当前原生账号、版本 ID 的实际适用性验证。

## 限流与最小真实验收

各端点分别给出 3、10、30 次/秒等主管账号维度限制；上手指引针对业务码 `500`（访问过快）的建议是将单接口 QPS 控制到 1 以内。保守默认 1 QPS 有依据，但应注明这是保守策略，不能称所有端点官方上限都是 1 QPS。相同主管账号下的多渠道、用户和任务需共享预算并退避。

接入验收先使用一个有权限的渠道：验证页码起点、日期格式和一页原生目录，将完整 ID、名称、业务归属与后台对照；再只读验证一个时间范围内的已有推广链。对重复 ID、空页、总数变化和截断保留失败／待核对状态。上述操作尚未执行，不能用本地测试或公开 schema 代替真实连通结论。

## Vibbit 对 BXAGI 的产品启发

参考 [Vibbit 短剧产品介绍](https://www.vibbit.cn/drama.html)、[能力介绍](https://www.vibbit.cn/skill.html)和[帮助页](https://www.vibbit.cn/help.html)。能力与帮助页已通过公开页面读取；短剧介绍直连超时，使用官方页面的搜索索引文本，索引约两个月前。未进入登录后台，公开描述不能证明其实际服务性能。

值得转为 BXAGI 需求的方向：

1. 分别管理开头高光与结尾钩子候选，保存来源剧集、起止时间、字幕／画面依据，再交给员工选段。
2. 批量组合记录片段重叠、剧集覆盖和真实差异；开头对照、卖点对照能追溯到素材与制作要求。
3. 在已授权、已下载素材上建立 ASR／画面索引，按语义查找；目录名称搜索不等于视频内容检索。
4. 将团队常用制作方案保存为可编辑预设，明确应用后随任务冻结，避免覆盖已采纳任务要求。

官网将“投放数据反哺优化”标为**规划中**，不能当作竞品已有闭环；“日处理 2 万条”“小于 3 分钟”等产能／速度属于营销描述，本次未测量，不用作 BXAGI 的完成证据或效果承诺。本文记录升级依据，不把预设、候选时间轴、批量下载或语义检索的设计视为已实现。
