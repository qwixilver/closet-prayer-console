// SPDX-License-Identifier: GPL-3.0-only
export function observePickerFrame(step) {
  let frame;
  let observer;
  let loaded = false;
  let reloaded = false;
  let received = false;
  function onLoad() {
    if (!loaded) { loaded = true; step('picker-frame-loaded'); }
    else if (!reloaded) { reloaded = true; step('picker-frame-reloaded'); }
  }
  function onMessage(event) {
    // Observe transport only. Never inspect message contents or use them to
    // authorize a file; selection must still come from Google's Picker callback.
    if (!received && frame && event.origin === 'https://docs.google.com' && event.source === frame.contentWindow) {
      received = true;
      step('picker-frame-message');
    }
  }
  function findFrame() {
    const frames = [...document.querySelectorAll('iframe')].filter(candidate => {
      try {
        const url = new URL(candidate.src);
        return url.origin === 'https://docs.google.com' && url.pathname === '/picker';
      } catch { return false; }
    });
    if (frames.length !== 1) return;
    frame = frames[0];
    frame.addEventListener('load', onLoad);
    observer?.disconnect();
  }
  // The real SDK can insert its frame asynchronously after setVisible returns.
  findFrame();
  if (!frame) {
    observer = new MutationObserver(findFrame);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  }
  window.addEventListener('message', onMessage);
  return () => {
    observer?.disconnect();
    frame?.removeEventListener('load', onLoad);
    window.removeEventListener('message', onMessage);
  };
}
