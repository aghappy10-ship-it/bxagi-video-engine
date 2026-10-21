import { esc, icon, button, header, list, DISTRIBUTION_URL } from '../app/ui.mjs';
export function settings({
  workspace,
  state
}) {
  return `${header('工作区设置', '配置生产服务、管理本地数据，或导出可以迁移的工作区。', '', 'WORKSPACE SETTINGS')}<div class="grid two">
<div class="card">
<div class="card-head">
<h2>生产服务连接</h2>
<span class="badge ${state.backend.healthy ? 'green' : 'orange'}">${state.backend.healthy ? '已连接' : '未连接'}</span>
</div>
<div class="card-body">
<div class="field">
<label for="backend-url">服务地址</label>
<input id="backend-url" type="url" value="${esc(state.backend.url)}" placeholder="留空使用当前站点，或 http://127.0.0.1:8765">
<small>当前站点为静态版本时，请先下载部署包并启动 Python 生产服务。</small>
</div>
<div class="field">
<label for="backend-token">API 令牌</label>
<input id="backend-token" type="password" autocomplete="off" value="${esc(state.backend.token)}" placeholder="启用 BX_API_TOKEN 时填写">
<small>地址与令牌仅保留在当前浏览器会话，不写入工作区导出文件。</small>
</div>
<div class="actions">${button('保存并检测连接', 'save-backend', 'primary', 'server')}${button('检测当前连接', 'health', '', 'refresh')}</div>${state.backend.checked ? `<p class="${state.backend.healthy ? 'fine' : 'error-text'}" style="margin-top:17px">${esc(state.backend.detail || '暂无服务详情')}</p>` : ''}<div class="divider">
</div>
<p class="fine">跨域连接需在生产服务配置允许的来源。HTTPS 页面不能连接不安全的 HTTP 地址，请使用同源部署或 HTTPS 服务。</p>
<a href="${DISTRIBUTION_URL}" download class="btn">${icon('download')}下载完整生产服务</a>
</div>
</div>
<div class="card">
<div class="card-head">
<h2>数据与迁移</h2>
<span class="badge">仅当前浏览器</span>
</div>
<div class="card-body">
<div class="toggle-row">
<div>
<strong>导出工作区</strong>
<p>片段计划、字幕、投放计划与报表，不含视频和令牌。</p>
</div>${button('导出 JSON', 'export-workspace', 'small', 'download')}</div>
<div class="divider">
</div>
<div class="toggle-row">
<div>
<strong>导入工作区</strong>
<p>导入会替换当前本地工作区，先验证结构再保存。</p>
</div>${button('导入 JSON', 'import-workspace', 'small', 'upload')}</div>
<input id="workspace-file" class="hidden" type="file" accept=".json,application/json">
<div class="divider">
</div>
<div class="toggle-row">
<div>
<strong>加载演示数据</strong>
<p>用于体验界面；不会执行生产、投放或产生支出。</p>
</div>${button('加载示例', 'load-demo', 'small', 'spark')}</div>
<div class="divider">
</div>
<div class="toggle-row">
<div>
<strong>清空本地工作区</strong>
<p>移除计划、字幕和报表；不删除服务端任务。</p>
</div>${button('清空数据', 'reset-workspace', 'small danger', 'trash')}</div>
</div>
</div>
</div>
<div class="card section-space">
<div class="card-head">
<h2>运行能力</h2>
<span class="badge">透明的交付状态</span>
</div>
<div class="card-body" style="padding-top:0">
<ul class="plain-list">
<li>浏览器模式：真实视频预览、字幕解析、片段编辑与 MediaRecorder 草稿导出。</li>
<li>生产服务模式：原始素材上传、FFmpeg 处理、任务队列、失败恢复、双重验收与正式 MP4 下载。</li>
<li>投放模块：本地管理与建议，当前没有广告平台执行能力。</li>
<li>视频、输出 Blob 和 API 会话不保存在工作区 JSON；刷新后需重新选择视频。</li>
</ul>
</div>
</div>`;
}
