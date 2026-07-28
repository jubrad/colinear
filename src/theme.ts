/** k9s-inspired palette. Ink accepts named colors and hex. */
export const theme = {
  /** hotkeys, logo, highlights */
  key: '#ff8700',
  accent: 'cyan',
  border: '#5f87af',
  borderFocus: '#87d7ff',
  ok: 'green',
  warn: 'yellow',
  err: 'red',
  info: 'magenta',
  dim: 'gray',
  /** column header text */
  header: '#87d7ff',
  selection: '#ffd700',
} as const;

export const STATUS_COLORS: Record<string, string> = {
  queued: 'gray',
  triage: '#5f87af',
  working: 'yellow',
  checks: 'yellow',
  needs_input: 'magenta',
  pr_open: 'cyan',
  done: 'green',
  escalated: 'red',
  error: 'red',
  interrupted: '#ff8700',
  blocked: '#af87ff',
};
