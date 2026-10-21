import { APP_VERSION } from '../app/config.mjs';
import { productLines } from '../domain.mjs';
import { esc, icon, header, list, featureText, DISTRIBUTION_URL } from '../app/ui.mjs';
export function products({}) {
  return `${header('一套工作区，三条产品线', '生产、投放、反馈共享素材与数据。当前交付边界和后续集成清晰可见。', `<a class="btn primary" href="${DISTRIBUTION_URL}" download>${icon('download')}下载部署包</a>`, 'PRODUCT PORTFOLIO')}<div class="grid three">${productLines.map((p, i) => `<article class="card product">
<div class="card-body">
<div class="product-num">PRODUCT 0${i + 1}</div>
<div class="product-glyph">${icon(['video', 'send', 'chart'][i])}</div>
<h2>${esc(p.name)}</h2>
<p>${esc(p.subtitle)}</p>
<span class="badge purple">${i === 0 ? '生产服务可运行' : i === 1 ? '本地计划已实现' : '导入数据可分析'}</span>
<h3>当前可用</h3>
<ul>${list(p.available || p.features).map(f => `<li>${esc(featureText(f))}</li>`).join('')}</ul>
<h3>待接入 / 待实现</h3>
<ul>${list(p.pending).map(f => `<li>${esc(featureText(f))}</li>`).join('')}</ul>
</div>
<div class="product-footer">
<strong>交付方式</strong> ${esc(Array.isArray(p.delivery) ? p.delivery.join(' / ') : p.delivery || '独立部署 + 统一工作区')}<br>
<strong>计量口径</strong> ${esc(typeof p.metering === 'object' ? JSON.stringify(p.metering) : p.metering || '按实际任务与数据记录计量')}</div>
</article>`).join('')}</div>
<div class="card section-space">
<div class="card-head">
<h2>交付与集成边界</h2>
<span class="badge">MVP ${APP_VERSION}</span>
</div>
<div class="table-scroll">
<table>
<thead>
<tr>
<th>能力</th>
<th>当前交付</th>
<th>启用条件</th>
</tr>
</thead>
<tbody>
<tr>
<td>
<strong>视频片段规划与生产</strong>
</td>
<td>规则选段、手动编辑、浏览器草稿、FFmpeg 队列</td>
<td>原始视频 + SRT；正式生产需部署服务</td>
</tr>
<tr>
<td>
<strong>素材质量验收</strong>
</td>
<td>时间与语句检查；服务端真实媒体解码</td>
<td>正式下载只对验收通过的输出开放</td>
</tr>
<tr>
<td>
<strong>投放运营</strong>
</td>
<td>本地计划、CSV 导入、预算建议</td>
<td>自动执行需平台接口、授权与审批链，当前未接入</td>
</tr>
<tr>
<td>
<strong>AI 语义规划与语音识别</strong>
</td>
<td>兼容模型规划 + 本地 faster-whisper 适配器；默认未配置</td>
<td>需要真实模型接口 / ASR 依赖与显式选择；当前工作台默认规则规划；语义验收仍待实现</td>
</tr>
<tr>
<td>
<strong>增长反馈</strong>
</td>
<td>实际报表汇总与数据完整性检查</td>
<td>跨平台归因、自动回传待集成</td>
</tr>
</tbody>
</table>
</div>
</div>`;
}
