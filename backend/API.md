# 本地生产服务 API

本服务实际接收原片、保存字幕、规划完整句片段、运行 FFmpeg 队列并生成 MP4。广告计划和建议只保存在本地，未接入广告账户，不会创建广告或消耗预算。

## 启动

```bash
python backend/server.py --host 127.0.0.1 --port 8765 --data-dir backend/data --workers 2
```

需要 Python 3.10+、`ffmpeg` 和 `ffprobe`。默认流程不需要 pip 包、模型账户或网络调用。打开 `http://127.0.0.1:8765/` 使用同源工作台。数据保存在指定目录的 `state.sqlite3`、`assets/` 和 `outputs/`，服务重启后仍可查询。

| 环境变量 | 默认或用途 |
|---|---|
| `BX_HOST` | `127.0.0.1`；对外监听必须配置 token |
| `BX_PORT` | `8765` |
| `BX_DATA_DIR` | `backend/data` |
| `BX_WORKERS` | `2`；允许 1–4 个编码工作线程 |
| `BX_API_TOKEN` | 为空时仅限本机开发；配置后所有 API 除 health 都要求 Bearer token |
| `BX_MAX_UPLOAD_MB` | `512`；允许设置 1–4096 |
| `BX_ALLOWED_ORIGINS` | 默认无跨域来源；逗号分隔精确 origin，不接受 `*` |

同源请求和无 Origin 的命令行客户端可使用服务。其他浏览器来源需要显式列入 `BX_ALLOWED_ORIGINS`。无 token 模式同时检查 loopback Host，防止浏览器跨站请求和 DNS rebinding。token 是单用户服务凭证，尚无多用户权限体系。远程部署应配置 HTTPS 反向代理；服务本身提供 HTTP。

## 代码结构

`server.py` 保留原来的启动参数和公共导入接口，是兼容入口。实际代码位于 `bxagi/`：`http.py` 只处理路由、鉴权、请求与文件传输；`service.py` 负责素材、字幕、规划、投放草案和任务生命周期；`repository.py` 管理 SQLite 事务、表结构与审计；`media.py` 负责依赖检测、FFmpeg 编码和完整解码；`transcripts.py`、`campaigns.py` 提供独立规则；`common.py` 集中版本、限制和错误定义；`cli.py` 处理启动与停止。可选推理适配器仍是 `ai_adapter.py`。

健康接口和 HTTP 服务标识使用同一版本常量，当前为 `1.1.0`。也可从项目根目录用 `python -m backend.server` 启动；数据格式与 API 字段保持兼容。

## 通用约定

JSON 请求使用 `Content-Type: application/json`。视频上传使用原始文件字节，不使用 multipart。所有请求体需要 `Content-Length`，不接受 chunked transfer。JSON 最大 3 MB，SRT 最大 2 MB/10,000 条。错误返回 HTTP 4xx/5xx 与 `{"error":"说明"}`。标识符是服务生成的 32 位十六进制值。

配置 token 后，请求头为 `Authorization: Bearer <token>`，下载也必须使用该头；不接受 query token。健康响应、审计事件不包含凭证。

## 路由

| 方法和路径 | 请求或响应 |
|---|---|
| `GET /api/health` | 公共健康检查，含 ffmpeg/ffprobe、auth_required、llm_configured、asr_configured |
| `GET /api/capabilities` | 实际能力与未配置集成，含模型/ASR 状态及边界容差 |
| `POST /api/assets` | 视频原始字节，`X-Filename` 可用 URL 编码中文名；返回 id、name、duration、width、height、has_audio、sha256 |
| `GET /api/assets` | `{"assets":[...]}`；最近 500 个，不返回物理文件路径 |
| `POST /api/assets/:id/transcript` | `{"srt":"..."}`；返回 `{"segments":[{"id":1,"start":0,"end":2,"text":"完整句。"}]}` |
| `POST /api/assets/:id/plan` | `{"count":3,"min_duration":5,"max_duration":45,"strategy":"hook","use_ai":false}`；返回 clips、engine、说明 |
| `POST /api/assets/:id/transcribe` | `{"engine":"local"}`；仅显式运行已配置本地 ASR，详见下文 |
| `POST /api/jobs` | `{"asset_id":"...","title":"...","clips":[{"start":0,"end":5}],"format":"portrait","burn_subtitles":false}`；返回 id、status |
| `GET /api/jobs` | `{"jobs":[...]}`；最近 500 个 |
| `GET /api/jobs/:id` | clips、status、gates、error；仅 passed 输出含 output_url |
| `GET /api/jobs/:id/download` | 通过全部门禁才返回 MP4；失败或未完成返回 409 |
| `GET /api/audit` | `{"events":[...]}`；最近 500 条服务事件，不保存字幕原文或凭证 |
| `POST /api/campaigns` | 创建本地草案，见预算字段说明 |
| `GET /api/campaigns` | `{"campaigns":[...]}` |
| `POST /api/campaigns/:id/metrics` | 导入一次指标快照并返回本地建议，未执行广告动作 |

## 剪辑与两项门禁

默认规则规划仅使用导入 SRT。以句号、问号、叹号、中文对应标点或省略号结束的字幕为句尾，允许末尾引号；跨多个字幕块的句子合并。候选片段从句首开始，到完整句句尾结束，不足指定数量时返回较少片段。`hook`、`narrative`、`selling` 等策略参数兼容工作台；当前规则引擎按时间顺序选择，并不声称做语义排名或预测爆款。缺少 SRT 返回 422。

正式生产队列包含两项独立检查：

1. `sentence_boundary`：各片段起止时间匹配字幕完整句边界，容差 80 ms。没有字幕为 `unverified`，无法匹配为 `fail`。这只验证导入字幕的标点和时间结构，不验证字幕是否准确描述实际语音、剧情是否完整或语言是否自然。
2. `media_decode`：生成实际文件后，FFprobe 核验目标画幅和合计时长，再用 FFmpeg 完整解码视频/音频。任意一步失败时为 `fail`。

两项均为 `pass` 才置为 `passed` 并允许正式下载。失败时保存原因并删除输出。格式为 `landscape` 1280×720、`portrait` 720×1280、`square` 720×720；按原比例缩放并填充黑边，避免拉伸。多片段实际编码后合并为一个 MP4。字幕烧录需要 FFmpeg 的 `subtitles/libass` 滤镜；服务检测可用性，缺少时拒绝该选项。中日韩字幕另外检测可用字体；没有字体时拒绝烧录而不输出方框缺字。Debian/Ubuntu 可安装 `fonts-noto-cjk`，Windows 检测系统微软雅黑/宋体等；其他系统需有 fontconfig 字体登记。能力接口的 `cjk_font_available` 显示检查结果。

支持 FFmpeg 的 MP4/MOV、Matroska/WebM、AVI、MPEG 与 MPEG-TS 本地视频容器。禁止网络协议和播放列表 demuxer；不将文件名、标题或字幕拼接到 shell。最长原片 12 小时，每个任务合计输出最多 1 小时、100 个片段。队列最多等待 100 个任务，默认 2 个并发工作线程，每次 FFmpeg 步骤最长 10 分钟。大素材或慢机器超过限制会保存失败原因。

任务状态是 `queued → running → passed/failed`。启动时保留 queued 任务继续执行，将此前 running 任务标记为中断失败，避免把未完成文件当作成功。当前没有自动重试或取消接口，失败任务需要新建。

## 可选真实模型和转写

模型路径默认关闭。只有设置 `BX_MODEL_ENABLED=true`、`BX_MODEL_BASE_URL`、`BX_MODEL_API_KEY`、`BX_MODEL_NAME` 并在规划请求里显式指定 `use_ai:true`，才向兼容 Chat Completions 的服务发送导入字幕。HTTPS 提供商或 loopback HTTP 端点可用；无配置或禁用返回 503，不使用伪造模型结果回退。模型返回的字幕索引、范围、时长、重叠和完整句标点重新验证，不接受凭空时间戳。返回提供商实际 token usage；未提供 usage 时为 null；成本没有计价数据时为 null。

可选本地转写要求已安装 `faster-whisper`，并将 `BX_WHISPER_MODEL` 指向已存在的本地模型目录；不下载模型。`POST /api/assets/:id/transcribe` 的 `engine:'local'` 是明确执行请求，可能占用 CPU 和较长时间。成功返回 srt、segments、language、engine、inference_verified；原文进入该素材字幕。转写准确性仍须人工校对，正式输出仍执行两项门禁。此可选路径需要额外依赖；未安装时服务核心功能正常。

模型/ASR 配置状态不是效果验证；`inference_verified` 只在本次实际推理成功的响应上为 true。独立测试使用本地受控 HTTP 服务器验证真实请求和响应验证逻辑，不能据此声称任何商业模型或 ASR 权重已经验收。详细配置见 [AI_SETUP.md](../docs/AI_SETUP.md)。

## 广告草案与建议

创建草案接受 `name`、`daily_budget`、`target_roi`、`max_daily_budget`、`min_spend`，也兼容对应 camelCase 字段。默认分别为 100、1.5、1000、100。预算不得超过其填写的草案上限。`status:'draft'`、`execution:'not_connected'` 明确未接入平台。

指标请求为 `{"spend":200,"revenue":600,"conversions":5,"has_conversion":true,"data_fresh":true}`。每次请求视为完整快照，缺失字段不会沿用上一份指标，缺失转化为未知。无效或非有限金额拒绝请求；null 金额保留为未知。标记数据是否新鲜及转化是否有效由导入者提供，当前没有平台自动核验或定时拉取。

建议规则与工作台一致：数据过期保持预算且 ROI 为 null；有效数据预算超过 `min(1000, max_daily_budget)` 进入人工审批；未知转化不计算 ROI，消耗达到日预算时仅给节奏暂停建议；样本未达 min_spend 保持；ROI 小于 target_roi×0.65 建议暂停；ROI ≥ target_roi×1.15 且转化次数 ≥3 建议增加 20%，超过上限转为人工审批；其他情况保持。暂停建议不会把草案预算改为 0。`newBudget` 是建议值，超上限的审批建议可以显示提议金额，但不会实际执行。ROI 使用收入/消耗，不包含利润率、归因或因果推断。

## 验证

```bash
python -m unittest discover -s backend -p 'test_*.py' -v
```

测试生成真实视频并通过 HTTP 上传、字幕导入、规划、排队、下载，再用 FFprobe/FFmpeg验证实际输出；同时验证认证、句界拒绝、损坏媒体、无字幕、指标缺失和重启恢复。适配器测试验证兼容 API 的真实本地 HTTP 请求及严格响应验证。
