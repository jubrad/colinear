/** k9s-inspired palette. Ink accepts named colors and hex. */
export const theme = {
  /** hotkeys, logo, highlights */
  key: '#ff8700',
  accent: 'cyan',
  border: '#5f87af',
  borderFocus: '#87d7ff',
  ok: 'green',
  /** GitHub's own merged purple — merged is not just another kind of green */
  merged: '#a371f7',
  /** changes requested: needs work, and shouldn't read as an error */
  changes: '#ff7ac6',
  warn: 'yellow',
  err: 'red',
  info: 'magenta',
  /**
   * Informational review findings. Deliberately off the red → yellow → green
   * ramp: an annotation explaining what code does is not a mild problem, and
   * anything on that ramp reads as one.
   */
  annotation: '#5fafff',
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
  tracking: '#5fafff',
  cancelled: 'gray',
};

/** Review statuses get their own scale: idle → working → decided. */
export const REVIEW_COLORS: Record<string, string> = {
  pending: 'gray',
  queued: 'gray',
  reviewing: 'yellow',
  ready: '#87d7ff',
  posting: 'yellow',
  commented: 'cyan',
  approved: 'green',
  changes_requested: '#ff8700',
  stale: 'gray',
  error: 'red',
};
