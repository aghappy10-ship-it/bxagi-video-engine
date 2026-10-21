# Mac 与 Windows 并行开发

仓库：`https://github.com/aghappy10-ship-it/bxagi-video-engine`，私有。

这份仓库以当前 BXAGI 源码的干净快照为初始基线，包含原项目中尚未提交的业务修改。原 `site` 目录及其历史保留在原位置。托管身份配置、数据库、素材、依赖和嵌套源码压缩包不随 GitHub 同步。

## 两边首次运行

安装 Git、Node.js 22.13+（建议使用两边相同的 Node 24 系列版本），登录有仓库权限的 GitHub 账号。可以用 GitHub Desktop 完成登录和克隆。

```sh
git clone https://github.com/aghappy10-ship-it/bxagi-video-engine.git
cd bxagi-video-engine
npm ci
npm run setup:local
npm run dev
```

浏览器打开终端显示的本机地址，默认是 `http://localhost:5173`。

`setup:local` 为每个克隆生成自己的 `.dev.vars`，并只迁移本地 D1 数据库。再次运行保留已有密钥。它不会创建云端数据库、登录生产账号、部署网站或启动自动投放。

`npm run dev` 使用独立开发路径，不需要 `.openai/hosting.json`。数据库和文件存储属于本机；GitHub 同步源码不会同步实际素材、员工任务、BXAGI 登录状态或用户数据。

## 同时做两个任务

先保持 `main` 干净并同步，然后每个任务建立自己的分支。

Mac 示例：

```sh
git switch main
git pull --ff-only
git switch -c mac/material-ui
```

Windows 示例：

```sh
git switch main
git pull --ff-only
git switch -c windows/catalog-api
```

在各自项目目录打开 Codex 或 Claude Code，并说明这次任务负责的范围。分支名按任务变化，不需要长期固定成前端或后端。

完成一项任务后，查看 `git diff`，提交明确的源码文件并推送：

```sh
git status
git diff
git add <本次修改的文件>
git commit -m "Describe the change"
git push -u origin HEAD
```

在 GitHub 创建 Pull Request，检查差异和测试结果后合入 `main`。另一台电脑回到干净的 `main`，执行 `git pull --ff-only` 取得合并后的结果。

GitHub 是提交后的同步，不会自动实时同步未提交的修改。两边同时改到同一段代码时仍需处理合并冲突。

## 同一台机器上同时跑多个 Agent

每个会改代码的任务使用一个 worktree：

```sh
git worktree add -b task/player ../bxagi-player main
git worktree add -b task/catalog ../bxagi-catalog main
```

每个 worktree 分别执行 `npm ci` 与 `npm run setup:local`，并给开发服务指定不同端口：

```sh
npm run dev -- --port 5174
```

每台电脑只有一个服务时，两边都用 5173 没问题；同机才需要不同端口。若配置了共同的外部数据库或服务，分支和 worktree 不会自动隔离这些外部数据。

## 远控与 GitHub 的分工

GitHub 负责代码版本、双机同步和合并。Mac 想运行 Windows 独有环境、查看桌面软件或使用显卡时，另外使用远程桌面或 SSH。GitHub 不会让 Mac 自动调用 Windows 的 GPU，也不替代远程桌面。

双机各自开发时，Windows 关闭不影响 Mac 编辑本地源码。只有借用 Windows 执行任务时，Windows 才必须开机在线。

## 验证范围

新增脚本需要在目标系统安装依赖后运行。交付记录区分脚本语法、当前 Windows 环境的本地烟雾验证和实际 Mac 验证；没有连接 Mac 时不能宣称 Mac 端已验证。

AI 工具在各自机器上独立登录；不要把 Claude、Codex 或 GitHub 的认证文件提交到仓库。项目的 `.gitignore` 已排除本地环境变量、运行数据和依赖。
