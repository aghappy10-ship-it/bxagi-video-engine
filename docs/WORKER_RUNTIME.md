# 视频处理与效果监测执行器

`worker/run.py` 是 Python 3 标准库与系统 FFmpeg/ffprobe 的常驻执行器。连续 `all` 模式分三路运行：广告监测线程调用 `/api/v2/worker/tick`，独立 BXAGI 任务同步线程调用 `/api/v2/worker/bxagi-tick`，视频主循环领取本地处理租约。三个循环各用独立客户端；远端 BXAGI 素材同步与长视频编码都不会阻塞预算监测。视频从受租约保护的原始素材接口下载，实际编码为 MP4，完整解码检查通过后上传入库。任务、来源、成品和审计仍属于原用户。

产品的公开入口使用 BXAGI 登录，项目、素材、员工与投放计划的用户归属来自服务端验证的 BXAGI 会话。计算执行器使用独立的 `APP_WORKER_SECRET` 服务认证，不需要普通用户登录，不提交或伪造用户身份请求头。

## 启动

准备 Python 3.10+、包含 `libx264`/AAC 的 FFmpeg 和 ffprobe。在部署执行器的机器上，以受保护的环境变量提供以下配置，密钥不写入源代码或下载包：

| 变量 | 用途 |
| --- | --- |
| `BXAGI_BASE_URL` | 已部署站点的 HTTPS 域名，或以 `/api/v2` 结尾的地址 |
| `APP_WORKER_SECRET` | 与站点服务端相同的计算员工密钥 |
| `SITES_SERVICE_TOKEN` | 可选；仅历史部署启用了托管主机的私有访问限制时使用，自动发送 `OAI-Sites-Authorization`。公开 BXAGI 登录入口不需要此变量 |
| `BXAGI_POLL_SECONDS` | 轮询间隔，默认 30 秒，范围 5–60 秒 |
| `BXAGI_PROCESS_TIMEOUT` | 单视频总处理时限，默认 900 秒，范围 10–1200 秒 |
| `BXAGI_NETWORK_TIMEOUT` | 单次网络超时，默认 45 秒，范围 1–120 秒 |

```sh
python3 worker/run.py --once
python3 worker/run.py --poll-seconds 30
python3 worker/run.py --mode ads --poll-seconds 30
python3 worker/run.py --mode bxagi --poll-seconds 30
python3 worker/run.py --mode video --poll-seconds 30
```

`--mode` 默认为 `all`；`ads` 只监测投放，`bxagi` 只同步远端 BXAGI 任务，这两种模式都不需要 FFmpeg；`video` 只领取并处理视频。`--once all` 按广告监测、BXAGI 同步、本地视频处理的顺序运行一轮后退出；退出码 0 为正常完成或没有任务，1 为本轮处理/网络失败，2 为配置或身份验证错误。计算员工密钥被拒绝，或可选的托管主机服务认证返回 401/403，会停止所有循环并终止正在运行的 FFmpeg；远端 BXAGI 账号过期若以正常 200 响应的任务状态 `requires_login` 返回，只暂停对应用户任务，继续广告监测。SIGINT/SIGTERM 会清理子进程和临时文件。长期运行应交给部署机器上的服务管理器，故障重启由它负责。代码不会创建服务器、安装模型、下载依赖或自行发起新的付费投放计划。测试工作区的运行不能证明生产环境已部署常驻服务。

对于 systemd，可使用以下服务配置并按部署目录调整路径。环境文件由运维创建，权限应为 0600；文件中的密钥需要来自站点配置，不能使用示例文本作为实际密钥。

```ini
[Unit]
Description=BXAGI video compute and ad monitoring
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bxagi-worker
WorkingDirectory=/opt/bxagi
EnvironmentFile=/etc/bxagi-worker.env
ExecStart=/usr/bin/python3 /opt/bxagi/worker/run.py
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
UMask=0077

[Install]
WantedBy=multi-user.target
```

## 视频能力与边界

当前云端默认派发保留全片的竖版适配。执行器按源宽高等比缩放并补边，输出竖版 720×1280、方版 720×720 或横版 1280×720；保留源音轨，转换为 AAC。它不添加未经验证的广告文案，不生成配音，不判断剧情语义，也不宣称完成视觉理解或自动精彩片段选择。

可选明确时间段配方为 `trim: {startSeconds, endSeconds, basis: "explicit_timestamps"}`，同时设置 `preserveFullVideo: false`、`semanticCut: false`。时间段必须落在真实 ffprobe 时长范围内，缺少明确时间段会拒绝处理。当前产品默认配方不包含时间段剪辑。

单个原始素材和成片最多 64 MiB，真实源时长不超过 7200 秒；输入视频尺寸限制为每边 8192 像素且总像素不超过 33554432。输出平均码率随时长降低以控制文件大小。编码完成后检查实际宽高、时长与全片解码；超时、文件损坏、文件截断或输出超限均不创建成品。每个任务租约 30 分钟，一次只领取一个任务；过期任务最多尝试三次，旧租约不能读取素材或覆盖成品。

执行器只连接配置的站点地址，拒绝 HTTP 重定向；除 localhost 测试外要求 HTTPS。日志只包含固定事件、计数、输出尺寸及时长，不包含密钥、完整网络响应或原素材文本。FFmpeg 限制为本地文件/pipe 协议与 MP4/MOV/WebM 容器，避免媒体内嵌网络资源访问。运行计算员工属于可信服务权限，不替代站点的用户身份或允许用户访问他人数据。

## 投放监测

`tick` 监测所有已到同步时间的有效投放计划的预算；只有开启自动优化的计划才允许相应自动优化操作。实际平台操作由服务端适配器执行，并受用户预算上限、真实平台权限与数据可用性约束。没有投放账户、访问权限或真实转化数据时，执行器不会伪造投放成功、订单收入或 ROI。素材迭代任务的生成与成品生成是不同步骤：该执行器处理视频任务，连接 BXAGI 后，素材迭代由实际已雇佣员工交付真实文件；本地视频处理仍为独立辅助能力。

`bxagi-tick` 使用同一计算员工服务密钥，同步已存在的 BXAGI 远端任务，并为已开启自动优化、数据归属一致且保存的 BXAGI 身份有效的计划派发下一轮素材任务；不会创建新投放计划或自行提高预算，也不伪造普通用户登录身份。BXAGI 账号凭据和用户归属由站点服务端处理，执行器不接收或记录用户 BXAGI 登录令牌。服务端按阶段推进远端任务与素材导入，避免一次长请求批量拉取全部素材；该线程失败或超时不会挤占广告监测线程。

在没有部署这个执行器或其他调度服务时，站点 `/system/health` 的 `backgroundScheduling` 保持 `false`，不能将页面已发布描述为已完成全天候后台调度。

## 已验证内容

`node --test tests/worker-runner.test.mjs` 使用真实生成的视频、生产 HTTP API、实际部署 SQL 的 SQLite 实例和 R2 流接口测试夹具，运行 Python `--once`，再独立完整解码已保存的 MP4。普通用户接口通过仅测试进程可用的 BXAGI 身份解析依赖注入绑定固定测试用户；生产接口不接受这些测试标识，也不读取第三方用户身份头作为登录认证。视频辅助夹具不伪造远端 BXAGI 已连接或员工执行。计算接口仍使用真实的员工密钥与任务租约，不需要用户身份注入。另验证明确时间段剪辑、员工认证、错误租约、未完整解码的提交、超限成片、损坏视频、跨域重定向、租约重试上限、编码期间的独立监测与身份验证失败停机、无 FFmpeg 的广告/BXAGI 监测模式、慢 BXAGI 请求期间的独立预算监测、提交中断后的成片保留与恢复。这些测试没有操作浏览器，也没有使用真实 BXAGI 用户会话、广告账户或付费投放。
