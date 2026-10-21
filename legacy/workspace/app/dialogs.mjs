import { esc } from './ui.mjs';

/** One dialog lifecycle, reused by confirmation, quality detail and campaign forms. */
export function createModalManager(document) {
  let activeClose = null;
  function dismiss() {
    activeClose?.('cancel');
  }
  function activate(root) {
    const previous = document.activeElement;
    let finish;
    let closed = false;
    const result = new Promise(resolve => {
      finish = resolve;
    });
    const close = value => {
      if (closed) return;
      closed = true;
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      if (activeClose === close) activeClose = null;
      previous?.focus?.();
      finish(value);
    };
    const onKey = event => {
      if (event.key === 'Escape') close('cancel');
      if (event.key !== 'Tab') return;
      const focusable = Array.from(root.querySelectorAll('button:not([disabled]),input,select,textarea,a[href]'));
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    root.querySelectorAll('[data-modal-value]').forEach(button => button.addEventListener('click', () => close(button.dataset.modalValue)));
    root.querySelector('.modal-backdrop')?.addEventListener('click', event => {
      if (event.target === event.currentTarget) close('cancel');
    });
    document.addEventListener('keydown', onKey);
    root.querySelector('input,button')?.focus();
    activeClose = close;
    return {
      close,
      result
    };
  }
  function mount(title, body, buttons) {
    dismiss();
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">${esc(title)}</h2>${body}<div class="actions">${buttons.map(button => `<button class="btn ${button.primary ? 'primary' : ''} ${button.danger ? 'danger' : ''}" data-modal-value="${esc(button.value)}">${esc(button.label)}</button>`).join('')}</div></section></div>`;
    return activate(root);
  }
  return {
    dismiss,
    activate,
    mount
  };
}
