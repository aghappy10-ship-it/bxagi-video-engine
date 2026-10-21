# 配置真实模型规划与本地语音识别

这两个可选适配器已经实现。默认不发送模型请求，不下载模型，也不把规则规划显示成模型推理。当前交付验证覆盖本地模拟 HTTP 服务、鉴权请求、严格输出校验及不可用状态；未配置付费模型凭据，未运行真实供应商推理，未安装或运行本地语音模型。

## 模型规划

服务器环境中配置四项，重启服务：

```bash
export BX_MODEL_ENABLED=true
export BX_MODEL_BASE_URL=https://api.openai.com/v1
export BX_MODEL_API_KEY=your-server-side-key
export BX_MODEL_NAME=your-provider-model-name
```

可使用支持 OpenAI Chat Completions JSON 对象输出格式的兼容服务。URL 是 API 基础路径，代码追加 `/chat/completions`；生产 URL 要求 HTTPS，HTTP 仅允许本机测试。供应商需要支持请求中的 `response_format: {"type":"json_object"}`、`temperature` 和 `max_tokens`；不支持时请求会明确失败，不会悄悄切换成其他引擎。选择模型时应确认供应商对这些参数的支持。

只有服务端明确调用 `plan_clips(...)` 才发送请求。服务端接口的规划操作需要显式 `use_ai: true`；常规规则规划不需要这些配置。状态接口公开 `configured`、模型名称和缺失配置项名称，不公开密钥或供应商基础地址。

输入必须是带原始时间戳的 SRT 转录片段。模型选择 `start_cue`、`end_cue`，服务端从原始转录映射开始和结束秒数，再验证片段数量、有限数值、索引边界、时长、非重叠和句末标点。模型不能指定文件路径或新时间戳。失败会返回明确错误，不能作为合格视频进入导出流程。

句子完整性校验基于原始字幕的句末标点与时间边界。它能阻止在跨字幕的未完句中间截断，但不能证明字幕文本、音视频内容、语义、事实或营销合规性正确。未带标点或不准确的 ASR 文本需要复核和修订。

响应返回供应商实际提供的 `prompt_tokens`、`completion_tokens` 和 `total_tokens`。未返回则为 `null`；费用为 `null`，没有硬编码费率、宣称 0.20 元成本或伪造使用量。请求超时为 45 秒，转录最多 100,000 字符，最多 12 个选段，每段最长 300 秒。大量转录需要先分批整理。供应商 HTTP 重定向会被拒绝，避免把 Bearer 密钥转发到其他地址。

## 本地 ASR

这是一项单独启用的可选依赖：

```bash
python -m pip install faster-whisper
export BX_WHISPER_MODEL=/absolute/path/to/existing/ctranslate2-whisper-model
```

模型目录必须提前由运营者准备，不能填远程模型名称。目录应包含所选 CTranslate2 Whisper 模型的完整权重、配置和分词文件。代码传入 `local_files_only=True`，并以 CPU / int8 运行；不会隐式下载模型。目录存在并不代表文件完整或适配器已经通过真实推理验证。

`transcribe_local(media_path)` 使用已上传的本地媒体生成带秒数的 `segments` 和 SRT。没有依赖或目录时明确不可用；缺失模型文件、媒体格式不支持或推理失败时明确返回错误。首次识别耗时与音频时长及服务器性能有关，输出文字和标点仍需复核。

## 已验证与未验证

| 能力 | 交付状态 |
| --- | --- |
| 真实兼容 API 请求、Bearer 鉴权、JSON 提取、原始时间映射 | 代码已实现；本地模拟服务测试通过 |
| 无配置时禁止联网，错误不泄漏密钥 | 测试覆盖 |
| 越界、重叠、未完句、时长超限、截断及错误响应拒绝 | 测试覆盖 |
| 实际供应商模型质量、费用、吞吐与可用性 | 未运行真实推理；需要运营者配置并验收 |
| 本地 ASR、离线模型加载、SRT 输出 | 代码已实现；依赖及本地权重未配置，未运行真实识别 |
| TTS、自动配音、语义合规验收、多平台广告投放 | 不在这两个适配器的实现范围 |

运行适配器检查：

```bash
python -m unittest discover -s backend -p test_ai_adapter.py -v
```

该检查使用本机假服务模拟供应商响应，不会调用付费 API。
