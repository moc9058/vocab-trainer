(() => {
  if (window.top !== window || !/^https?:$/.test(location.protocol) || document.contentType === 'application/pdf') return;
  const labels = ['safariAnalyze', 'safariTooLong', 'safariPanelOpen', 'safariTab'].map(key => browser.i18n.getMessage(key));
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  button.textContent = labels[0]; button.hidden = true;
  button.style.cssText = 'position:fixed;border:1px solid #818cf8;background:#312e81;color:white;border-radius:8px;padding:10px 16px;font:16px system-ui;cursor:pointer;';
  shadow.append(button); document.documentElement.append(host);
  let snapshot = '', timer, dragging = false, pending = false, context, bind, frame, fallbackTimer;
  const forbidden = node => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest('input,textarea,[contenteditable]:not([contenteditable="false"]),canvas,select,embed,object');
  function update() {
    if (dragging || pending) return;
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount || forbidden(s.anchorNode) || forbidden(s.focusNode) || forbidden(document.activeElement)) { button.hidden = true; return; }
    const range = s.getRangeAt(0);
    // Reject a selection crossing a forbidden element too, not only its endpoints.
    if ([...document.querySelectorAll('input,textarea,[contenteditable]:not([contenteditable="false"]),canvas,select,embed,object')].some(e => range.intersectsNode(e))) { button.hidden = true; return; }
    const text = s.toString();
    if (!text.trim()) { button.hidden = true; return; }
    snapshot = text;
    const rects = range.getClientRects(), rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
    const v = window.visualViewport;
    const left = v?.offsetLeft ?? 0, top = v?.offsetTop ?? 0, width = v?.width ?? innerWidth, height = v?.height ?? innerHeight;
    button.hidden = false;
    button.style.left = `${Math.max(left + 4, Math.min(rect.right + 6, left + width - 140))}px`;
    button.style.top = `${Math.max(top + 4, Math.min(rect.bottom + 6, top + height - 60))}px`;
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 180); };
  document.addEventListener('selectionchange', schedule);
  document.addEventListener('pointerdown', e => { if (!e.composedPath().includes(button)) dragging = true; });
  document.addEventListener('pointerup', () => { dragging = false; schedule(); });
  document.addEventListener('pointercancel', () => { dragging = false; schedule(); });
  document.addEventListener('keyup', schedule);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { button.hidden = true; } });
  window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule); window.visualViewport?.addEventListener('scroll', schedule);
  button.addEventListener('pointerdown', e => e.preventDefault());
  const fallback = async () => {
    if (!context || !bind) return;
    const r = await browser.runtime.sendMessage({ type: 'fallback', context, bind });
    if (!r.error) { frame?.remove(); frame = undefined; context = undefined; bind = undefined; }
  };
  button.addEventListener('click', async e => {
    if (!e.isTrusted || pending) return;
    const text = snapshot; // Preserve before focus changes.
    if (!text.trim()) return;
    if (text.length > 8000) { alert(labels[1]); return; }
    if (context) { alert(labels[2]); return; }
    pending = true; button.hidden = true;
    try {
      const r = await browser.runtime.sendMessage({ type: 'selection', text, title: document.title });
      if (r.error) throw new Error(r.error);
      context = r.id; bind = r.bind;
      frame = document.createElement('iframe');
      frame.title = browser.i18n.getMessage('extensionName'); frame.src = r.url;
      frame.style.cssText = 'position:fixed;right:0;top:0;width:min(600px,100vw);height:100dvh;border:0;background:#111827;box-shadow:0 0 12px #0008;';
      frame.addEventListener('load', () => {
        // Target only the extension document; the surrounding page cannot read this secret.
        try { frame.contentWindow.postMessage({ type: 'vocab-bind', context, bind }, r.url); }
        catch { void fallback(); }
      });
      shadow.append(frame);
      // CSP can prevent load. Keep the selected operation and open the same UI in a tab.
      fallbackTimer = setTimeout(() => void fallback(), 4000);
    } catch (err) { alert(String(err)); }
    finally { pending = false; }
  });
  browser.runtime.onMessage.addListener(message => {
    if (message.context !== context) return;
    if (message.type === 'bound') { clearTimeout(fallbackTimer); bind = undefined; }
    if (message.type === 'dismiss') { clearTimeout(fallbackTimer); frame?.remove(); frame = undefined; context = undefined; bind = undefined; }
  });
})();
