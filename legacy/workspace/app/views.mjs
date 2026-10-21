import { APP_VERSION } from './config.mjs';
import { pages } from './routing.mjs';
import { icon, button, demoNotice, DISTRIBUTION_URL } from './ui.mjs';
import { overview } from '../pages/overview.mjs';
import { studio } from '../pages/studio.mjs';
import { quality } from '../pages/quality.mjs';
import { campaigns } from '../pages/campaigns.mjs';
import { insights } from '../pages/insights.mjs';
import { products } from '../pages/products.mjs';
import { settings } from '../pages/settings.mjs';
export const pageRenderers = {
  overview,
  studio,
  quality,
  campaigns,
  insights,
  products,
  settings
};
export function renderShell(model) {
  const {
    workspace,
    state
  } = model;
  const page = pages.find(p => p[0] === state.page) || pages[0];
  return `<div class="shell ${state.navOpen ? 'nav-open' : ''}">
<button class="nav-backdrop" data-action="close-nav" aria-label="关闭导航"></button><aside class="sidebar"><button class="sidebar-close" data-action="close-nav" aria-label="关闭导航">${icon('close')}</button>
<a class="brand" href="#overview" data-page="overview" aria-label="BXAGI 工作台">
<span class="brand-mark">${icon('mark')}</span>
<span>BXAGI<small>VIDEO INTELLIGENCE</small>
</span>
</a>
<div class="nav-label">工作空间 / WORKSPACE</div>
<nav class="nav" aria-label="工作台导航">${pages.slice(0, 6).map(p => `<button class="nav-item ${p[0] === state.page ? 'active' : ''}" data-page="${p[0]}" ${p[0] === state.page ? 'aria-current="page"' : ''}>${icon(p[2])}<span>${p[1]}</span>
</button>`).join('')}</nav>
<div class="nav-label" style="margin-top:23px">管理 / MANAGEMENT</div>
<button class="nav-item ${state.page === 'settings' ? 'active' : ''}" data-page="settings" ${state.page === 'settings' ? 'aria-current="page"' : ''}>${icon('settings')}<span>设置</span>
</button>
<div class="sidebar-bottom">
<div class="runtime-card">
<strong>
<span class="dot">
</span> 可部署的生产工作台</strong>
<p>本地运行 · 自主掌控数据<br>FFmpeg 生产服务可独立部署</p>
<a href="${DISTRIBUTION_URL}" download>${icon('download')}下载完整部署包</a>
</div>
<div class="sidebar-foot">BXAGI SUITE / MVP ${APP_VERSION}</div>
</div>
</aside>
<main class="main" id="main-content" tabindex="-1">
<div class="topbar">
<div class="breadcrumb">
<button class="mobile-menu" data-action="toggle-nav" aria-expanded="${state.navOpen}" aria-label="展开导航">${icon('menu')}</button>
<span>工作空间</span>
<span>/</span>
<strong>${page[1]}</strong>
</div>
<div class="top-actions">
<span class="work-status">
<span class="dot" style="background:${state.backend.healthy ? '#50c8a7' : '#aea1e4'}">
</span>${state.backend.healthy ? '生产服务在线' : '本地工作区'}</span>
<span class="badge purple">${state.backend.healthy ? 'FFmpeg 生产模式' : '浏览器模式'}</span>
<div class="avatar" aria-label="本地工作区">BX</div>
</div>
</div>
<div class="content">${demoNotice(workspace)}${(pageRenderers[state.page] || overview)(model)}<footer class="page-footer">
<span>BXAGI · 让每一条素材有据可验</span>
<span>数据保存在当前浏览器 · 视频文件需重新选择 · 投放动作需接入授权平台</span>
</footer>
</div>
</main>
</div>`;
}
