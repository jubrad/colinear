/**
 * Colour themes. Every colour in the UI is one of these tokens, so a theme is
 * nothing but a value for each — Ink takes named ANSI colours and hex alike.
 *
 * `theme`, `STATUS_COLORS` and `REVIEW_COLORS` are one object each for the life
 * of the process, filled in place by `applyTheme`: views read them at render
 * time, so switching is a re-render, not a reload. A map a module builds from
 * them once at import would freeze the colours it saw, so build those with
 * `palette()`, which reads through on every access.
 *
 * Themes colour text and borders only. Ink never paints the terminal's
 * background, so a dark theme wants a dark terminal and a light one a light
 * terminal; `terminal` sticks to the 16 ANSI names and so follows whatever
 * palette the terminal itself has.
 */

export interface ThemeTokens {
  /** hotkeys, logo, highlights */
  key: string;
  accent: string;
  border: string;
  borderFocus: string;
  ok: string;
  /** merged is not just another kind of green */
  merged: string;
  /** changes requested: needs work, and shouldn't read as an error */
  changes: string;
  warn: string;
  err: string;
  info: string;
  /**
   * Informational review findings. Deliberately off the red → yellow → green
   * ramp: an annotation explaining what code does is not a mild problem, and
   * anything on that ramp reads as one.
   */
  annotation: string;
  dim: string;
  /** column header text */
  header: string;
  selection: string;
  /** blocked by another issue: parked, not failing */
  blocked: string;
  /** text drawn on a coloured badge (the crumbs) */
  onBadge: string;
}

export interface ThemeDef {
  label: string;
  /** what background it is drawn for */
  ground: 'dark' | 'light' | 'any';
  tokens: ThemeTokens;
}

export const DEFAULT_THEME = 'colinear';

export const THEMES: Record<string, ThemeDef> = {
  colinear: {
    label: 'the k9s-inspired default',
    ground: 'dark',
    tokens: {
      key: '#ff8700',
      accent: 'cyan',
      border: '#5f87af',
      borderFocus: '#87d7ff',
      ok: 'green',
      merged: '#a371f7',
      changes: '#ff7ac6',
      warn: 'yellow',
      err: 'red',
      info: 'magenta',
      annotation: '#5fafff',
      dim: 'gray',
      header: '#87d7ff',
      selection: '#ffd700',
      blocked: '#af87ff',
      onBadge: 'black',
    },
  },
  terminal: {
    label: "the 16 ANSI colours, in your terminal's own palette",
    ground: 'any',
    tokens: {
      key: 'yellowBright',
      accent: 'cyan',
      border: 'blue',
      borderFocus: 'cyanBright',
      ok: 'green',
      merged: 'magentaBright',
      changes: 'redBright',
      warn: 'yellow',
      err: 'red',
      info: 'magenta',
      annotation: 'blueBright',
      dim: 'gray',
      header: 'cyanBright',
      selection: 'whiteBright',
      blocked: 'blueBright',
      onBadge: 'black',
    },
  },
  'catppuccin-mocha': {
    label: 'Catppuccin Mocha',
    ground: 'dark',
    tokens: {
      key: '#fab387',
      accent: '#94e2d5',
      border: '#585b70',
      borderFocus: '#b4befe',
      ok: '#a6e3a1',
      merged: '#cba6f7',
      changes: '#eba0ac',
      warn: '#f9e2af',
      err: '#f38ba8',
      info: '#f5c2e7',
      annotation: '#89b4fa',
      dim: '#7f849c',
      header: '#89dceb',
      selection: '#f5e0dc',
      blocked: '#b4befe',
      onBadge: '#11111b',
    },
  },
  'catppuccin-latte': {
    label: 'Catppuccin Latte',
    ground: 'light',
    tokens: {
      key: '#fe640b',
      accent: '#179299',
      border: '#acb0be',
      borderFocus: '#7287fd',
      ok: '#40a02b',
      merged: '#8839ef',
      changes: '#e64553',
      warn: '#df8e1d',
      err: '#d20f39',
      info: '#ea76cb',
      annotation: '#1e66f5',
      dim: '#8c8fa1',
      header: '#209fb5',
      selection: '#dc8a78',
      blocked: '#7287fd',
      onBadge: '#eff1f5',
    },
  },
  dracula: {
    label: 'Dracula',
    ground: 'dark',
    tokens: {
      key: '#ffb86c',
      accent: '#8be9fd',
      border: '#6272a4',
      borderFocus: '#bd93f9',
      ok: '#50fa7b',
      merged: '#bd93f9',
      changes: '#ff92df',
      warn: '#f1fa8c',
      err: '#ff5555',
      info: '#ff79c6',
      annotation: '#9580ff',
      dim: '#6272a4',
      header: '#8be9fd',
      selection: '#f8f8f2',
      blocked: '#9580ff',
      onBadge: '#282a36',
    },
  },
  nord: {
    label: 'Nord',
    ground: 'dark',
    tokens: {
      key: '#d08770',
      accent: '#88c0d0',
      border: '#4c566a',
      borderFocus: '#88c0d0',
      ok: '#a3be8c',
      merged: '#b48ead',
      changes: '#d08770',
      warn: '#ebcb8b',
      err: '#bf616a',
      info: '#b48ead',
      annotation: '#81a1c1',
      dim: '#616e88',
      header: '#8fbcbb',
      selection: '#eceff4',
      blocked: '#5e81ac',
      onBadge: '#2e3440',
    },
  },
  'gruvbox-dark': {
    label: 'Gruvbox Dark',
    ground: 'dark',
    tokens: {
      key: '#fe8019',
      accent: '#8ec07c',
      border: '#665c54',
      borderFocus: '#83a598',
      ok: '#b8bb26',
      merged: '#d3869b',
      changes: '#d3869b',
      warn: '#fabd2f',
      err: '#fb4934',
      info: '#d3869b',
      annotation: '#83a598',
      dim: '#928374',
      header: '#83a598',
      selection: '#ebdbb2',
      blocked: '#83a598',
      onBadge: '#282828',
    },
  },
  'tokyo-night': {
    label: 'Tokyo Night',
    ground: 'dark',
    tokens: {
      key: '#ff9e64',
      accent: '#7dcfff',
      border: '#3b4261',
      borderFocus: '#7aa2f7',
      ok: '#9ece6a',
      merged: '#bb9af7',
      changes: '#ff007c',
      warn: '#e0af68',
      err: '#f7768e',
      info: '#bb9af7',
      annotation: '#2ac3de',
      dim: '#565f89',
      header: '#7aa2f7',
      selection: '#c0caf5',
      blocked: '#9d7cd8',
      onBadge: '#1a1b26',
    },
  },
  'solarized-dark': {
    label: 'Solarized Dark',
    ground: 'dark',
    tokens: {
      key: '#cb4b16',
      accent: '#2aa198',
      border: '#586e75',
      borderFocus: '#268bd2',
      ok: '#859900',
      merged: '#6c71c4',
      changes: '#d33682',
      warn: '#b58900',
      err: '#dc322f',
      info: '#d33682',
      annotation: '#268bd2',
      dim: '#657b83',
      header: '#268bd2',
      selection: '#eee8d5',
      blocked: '#6c71c4',
      onBadge: '#002b36',
    },
  },
};

export const theme: ThemeTokens = { ...THEMES[DEFAULT_THEME].tokens };

export const STATUS_COLORS: Record<string, string> = {};

/** Review statuses get their own scale: idle → working → decided. */
export const REVIEW_COLORS: Record<string, string> = {};

let current = '';

/** The theme in force. */
export function currentTheme(): string {
  return current;
}

/** Switch every colour in the UI to `name`'s; an unknown name falls back to the default. */
export function applyTheme(name: string | undefined): void {
  const key = name && THEMES[name] ? name : DEFAULT_THEME;
  if (key === current) return;
  current = key;
  Object.assign(theme, THEMES[key].tokens);
  Object.assign(STATUS_COLORS, {
    queued: theme.dim,
    triage: theme.border,
    working: theme.warn,
    checks: theme.warn,
    needs_input: theme.info,
    pr_open: theme.accent,
    done: theme.ok,
    escalated: theme.err,
    error: theme.err,
    interrupted: theme.key,
    blocked: theme.blocked,
    tracking: theme.annotation,
    cancelled: theme.dim,
  });
  Object.assign(REVIEW_COLORS, {
    pending: theme.dim,
    queued: theme.dim,
    reviewing: theme.warn,
    ready: theme.header,
    posting: theme.warn,
    commented: theme.accent,
    approved: theme.ok,
    changes_requested: theme.key,
    stale: theme.dim,
    error: theme.err,
  });
}

/**
 * A colour map built from the theme that stays current when it changes: each
 * read calls `make` again rather than keeping what the theme was at import.
 */
export function palette<T extends object>(make: () => T): T {
  const read = (k: string | symbol) => (make() as Record<string | symbol, unknown>)[k];
  return new Proxy({} as T, {
    get: (_t, k) => read(k),
    has: (_t, k) => k in make(),
    ownKeys: () => Reflect.ownKeys(make()),
    getOwnPropertyDescriptor: (_t, k) =>
      k in make() ? { enumerable: true, configurable: true, value: read(k) } : undefined,
  });
}

applyTheme(DEFAULT_THEME);
