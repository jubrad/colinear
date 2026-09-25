// Render ```mermaid fences ourselves, in the page's own colours.
//
// Material has a mermaid integration, but in this setup it replaces the fence
// with an empty <div class="mermaid"> and never fills it — the source is gone
// before anything can render it. Hence the fence class `mermaid-src`, which
// Material ignores, and this file.
//
// Colours come from Material's CSS custom properties rather than one of
// mermaid's built-in themes: a theme picked by name is a second opinion about
// what the page looks like, and it was wrong — dark diagrams on a light page.
// Reading the variables means the diagram cannot disagree with the text beside
// it, in either palette.
//
// GitHub renders ```mermaid natively and never sees any of this.
(() => {
  const SRC = 'https://unpkg.com/mermaid@11/dist/mermaid.min.js';

  const css = (name, fallback) =>
    getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;

  function themeVariables() {
    const fg = css('--md-default-fg-color', '#000');
    const bg = css('--md-default-bg-color', '#fff');
    const faint = css('--md-default-fg-color--lighter', '#0000001f');
    const line = css('--md-default-fg-color--light', '#0000008a');
    const surface = css('--md-code-bg-color', '#f5f5f5');
    return {
      darkMode: css('--md-default-bg-color', '#fff') !== '#fff' && isDark(),
      fontFamily: css('--md-text-font-family', 'system-ui, sans-serif'),
      background: bg,
      // nodes: a code-block surface, so they read as part of the page
      primaryColor: surface,
      primaryTextColor: fg,
      primaryBorderColor: line,
      secondaryColor: surface,
      tertiaryColor: bg,
      lineColor: line,
      textColor: fg,
      // the chip behind an edge label was opaque grey; the page background
      // makes it disappear into the diagram the way a label should
      edgeLabelBackground: bg,
      // sequence diagrams name everything separately
      actorBkg: surface,
      actorBorder: line,
      actorTextColor: fg,
      actorLineColor: faint,
      signalColor: line,
      signalTextColor: fg,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: line,
      labelTextColor: fg,
      loopTextColor: fg,
      noteBkgColor: surface,
      noteBorderColor: line,
      noteTextColor: fg,
      sequenceNumberColor: bg,
    };
  }

  const isDark = () => document.body.dataset.mdColorScheme === 'slate';

  async function render() {
    const fences = document.querySelectorAll('pre.mermaid-src');
    for (const pre of fences) {
      const div = document.createElement('div');
      div.className = 'mermaid';
      // keep the source: a palette toggle has to re-render from it
      div.dataset.src = pre.textContent;
      pre.replaceWith(div);
    }
    const nodes = document.querySelectorAll('div.mermaid');
    if (!nodes.length) return;
    if (!window.mermaid) await load();
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: themeVariables(),
    });
    for (const node of nodes) {
      node.removeAttribute('data-processed');
      node.textContent = node.dataset.src;
    }
    await window.mermaid.run({ nodes });
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

  // the light/dark toggle rewrites the variables under us
  new MutationObserver(go).observe(document.body, {
    attributes: true,
    attributeFilter: ['data-md-color-scheme'],
  });
})();
