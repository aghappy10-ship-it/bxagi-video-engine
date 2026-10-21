# 代码结构与维护入口

工作台继续使用原生 ES 模块和 Python 标准库，无需引入前端框架或新增构建步骤。工作区沿用 `bxagi.workspace.v1` 的数据身份和 schema 1。

## 前端

| 模块 | 职责 |
| --- | --- |
| `dist/app.js` | 应用启动入口 |
| `dist/app/controller.mjs` | 连接界面操作、状态和媒体／服务适配器 |
| `dist/app/workspace.mjs` | 工作区校验、持久化、运行时状态 |
| `dist/app/api-client.mjs` | 服务地址校验、请求超时、取消、会话凭证 |
| `dist/app/metrics.mjs` | 指标聚合与当日预算建议 |
| `dist/app/imports.mjs` | CSV 解析、容量及重复记录校验 |
| `dist/app/routing.mjs` | 静态站点 hash 路由与浏览器前进／后退 |
| `dist/app/ui.mjs` / `views.mjs` | 共享组件、页面上下文与工作台外壳 |
| `dist/pages/` | 七个页面各自的呈现 |
| `dist/domain.mjs` | 字幕规划、句界检查和预算规则 |
| `dist/video-engine.mjs` | 浏览器媒体读取及真实草稿录制 |
| `dist/styles/` | 设计变量、基础、布局、组件和响应式样式 |

用户数据校验与呈现分开；凭证留在会话中，不加入工作区导出。调整页面时优先修改对应 `pages/` 文件，调整规则时修改纯业务模块并运行对应测试。

选段算法用关键词前缀和计算窗口分数，只在选定片段后拼接文本，不创建所有候选窗口的长文本。在同一 1,500 条字幕／6 个片段／90 秒最长片长的单次对比中，运行时间由 188 ms 降至 22 ms；150 组不同字幕样本保持相同选段结果。此记录是本环境的工程基准，不是业务日产能承诺。

## 后端

| 模块 | 职责 |
| --- | --- |
| `backend/server.py` | 兼容原启动命令和既有导入 |
| `backend/bxagi/common.py` | 版本、常量、异常和通用值检查 |
| `backend/bxagi/cli.py` | 参数与服务启动 |
| `backend/bxagi/http.py` | HTTP、访问校验、路由与文件传输 |
| `backend/bxagi/service.py` | 应用用例、任务队列、状态和恢复 |
| `backend/bxagi/repository.py` | SQLite、事务和审计 |
| `backend/bxagi/media.py` | 媒体探测、字幕字体、FFmpeg 输出和解码 |
| `backend/bxagi/transcripts.py` | 字幕、句段规划和句界门禁 |
| `backend/bxagi/campaigns.py` | 投放计划规则 |
| `backend/ai_adapter.py` | 明确启用后的模型请求及可选本地转写 |

HTTP 层不直接操作 SQL，也不实现剪辑或预算业务规则。应用服务把任务交给媒体处理模块，只有句界和媒体验收通过的输出才开放正式下载。

## 常用检查

```bash
node --test tests/*.test.mjs
python -m unittest discover -s backend -p "test_*.py" -v
python tests/verify_policy_parity.py
python tests/produce_sample.py
python scripts/package_delivery.py
```

浏览器录制、视觉布局、Windows 和 Docker 的实机验证与这些检查分开记录，不能由模板／规则测试代替。
