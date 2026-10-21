export const pages = [['overview', '工作台概览', 'grid'], ['studio', '素材生产', 'video'], ['quality', '质量验收', 'shield'], ['campaigns', '投放运营', 'send'], ['insights', '增长分析', 'chart'], ['products', '产品线', 'layers'], ['settings', '设置', 'settings']];
export function pageFromHash(hash) {
  const page = String(hash || '').replace(/^#\/?/, '').split('?')[0];
  return pages.some(([key]) => key === page) ? page : 'overview';
}
/** Hash routes work with static file hosting and native Back/Forward navigation. */
export function createHashRouter({
  window,
  onNavigate
}) {
  let current = null;
  const sync = () => {
    const page = pageFromHash(window.location?.hash);
    if (current !== page) {
      current = page;
      onNavigate(page);
    }
  };
  return {
    start() {
      window.addEventListener?.('hashchange', sync);
      sync();
    },
    stop() {
      window.removeEventListener?.('hashchange', sync);
    },
    navigate(page) {
      if (!pages.some(([key]) => key === page)) return;
      if (window.location) window.location.hash = page;
      // Update immediately; the ensuing hashchange only applies a changed route.
      if (current !== page) {
        current = page;
        onNavigate(page);
      }
    }
  };
}
