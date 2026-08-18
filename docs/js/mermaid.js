// Render ```mermaid fences ourselves.
//
// Material has its own mermaid integration, but in this setup it replaces the
// fence with an empty <div class="mermaid"> and never fills it — the source is
// gone by the time anything can render it. Doing it here is a few lines, and it
// fails visibly rather than silently.
//
// The fence keeps the class `mermaid-src` so Material's integration ignores it.
// GitHub renders ```mermaid natively and never sees any of this.
(() => {
  const SRC = 'https://unpkg.com/mermaid@11/dist/mermaid.min.js';

  const blocks = () => document.querySelectorAll('pre.mermaid-src');

  const theme = () =>
    document.body.dataset.mdColorScheme === 'slate' ? 'dark' : 'default';

  async function render() {
    const found = blocks();
    if (!found.length) return;
    if (!window.mermaid) await load();
    window.mermaid.initialize({ startOnLoad: false, theme: theme(), securityLevel: 'strict' });
    for (const pre of found) {
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = pre.textContent;
      pre.replaceWith(div);
    }
    await window.mermaid.run({ nodes: document.querySelectorAll('div.mermaid') });
  }

  function load() {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SRC;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`could not load ${SRC}`));
      document.head.appendChild(s);
    });
  }

  const go = () => void render().catch((err) => console.error('mermaid:', err));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();
