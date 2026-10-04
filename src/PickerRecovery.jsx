// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function PickerRecovery({ onClose }) {
  const dialog = useRef(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (waiting) {
      const timer = setTimeout(() => setWaiting(false), 45000);
      return () => clearTimeout(timer);
    }
    // A native modal uses the browser's top layer, above Google's iframe and
    // overlay, with keyboard focus available even if the picker is unresponsive.
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, [waiting]);
  function keepChoosing() {
    dialog.current.close();
    setWaiting(true);
  }
  return createPortal(<dialog ref={dialog} className="picker-recovery" aria-labelledby="picker-recovery-title"
    aria-describedby="picker-recovery-description" onCancel={event => { event.preventDefault(); keepChoosing(); }}>
    <p className="eyebrow">Closet Prayer connection</p>
    <h2 id="picker-recovery-title">Still choosing a spreadsheet?</h2>
    <p id="picker-recovery-description">Google has not returned a selection. If you already confirmed one and the picker is stuck, close it here to see the connection report. No spreadsheet data has been read.</p>
    <div className="actions"><button className="primary" autoFocus onClick={onClose}>Close picker and show diagnostics</button>
      <button onClick={keepChoosing}>Keep choosing</button></div>
    <p className="small muted">Using Brave? Cookie blocking can stall Google's picker. Keep Shields on; see <a href="./setup.html#brave-cookies" target="_blank" rel="noopener noreferrer">Brave cookie help</a> for a site-only exception and its privacy tradeoff.</p>
    <p className="small muted">If you keep choosing, this help will return in 45 seconds unless Google responds.</p>
  </dialog>, document.body);
}
