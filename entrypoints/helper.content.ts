import { discoverOtpTarget } from '../lib/otp-form';
import { normalizeOrigin } from '../lib/origin';
import { send } from '../lib/messaging';
import { fillButtonLabel } from '../lib/i18n';

export default defineContentScript({
  matches: ['https://*/*'],
  registration: 'runtime',
  async main(ctx) {
    const origin = normalizeOrigin(location.origin);
    if (!await send<boolean>({ type: 'helper:status', origin }) || ctx.isInvalid) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.canokeyTotpHelper = 'true';
    button.textContent = 'C';
    button.title = fillButtonLabel;
    button.setAttribute('aria-label', fillButtonLabel);
    button.style.cssText = 'width:28px;height:28px;margin-left:6px;border:1px solid #009b83;border-radius:50%;background:#fff;color:#007965;font:600 14px system-ui;cursor:pointer;vertical-align:middle;z-index:2147483647;';
    let anchor: HTMLInputElement | undefined;
    let frame = 0;

    function placeButton() {
      frame = 0;
      if (document.activeElement === button && anchor?.isConnected) return;
      const fields = discoverOtpTarget().target?.elements;
      const field = fields?.at(-1);
      anchor = field;
      if (!field?.parentElement) button.remove();
      else if (field.nextElementSibling !== button) field.insertAdjacentElement('afterend', button);
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(placeButton);
    }

    button.addEventListener('click', (event) => {
      if (!event.isTrusted || !anchor?.isConnected) return;
      anchor.focus({ preventScroll: true });
      void send({ type: 'helper:clicked', origin }).catch((error: unknown) => {
        button.title = (error as Error).message;
      });
    });

    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('focusin', schedule);
    const refresh = (message: { type?: string }) => {
      if (message?.type !== 'helper:refresh') return;
      void send<boolean>({ type: 'helper:status', origin }).then((allowed) => {
        if (!allowed) ctx.abort();
      }).catch(() => ctx.abort());
    };
    chrome.runtime.onMessage.addListener(refresh);
    ctx.onInvalidated(() => {
      observer.disconnect();
      document.removeEventListener('focusin', schedule);
      chrome.runtime.onMessage.removeListener(refresh);
      cancelAnimationFrame(frame);
      button.remove();
    });
    placeButton();
  },
});
