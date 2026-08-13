import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useMemo, useState } from 'react';
import { theme } from '../theme.js';

export interface Candidate {
  label: string;
  value: string;
}

export function fuzzyMatch(haystack: string, needle: string): boolean {
  // an empty needle is "no query", not "matches the first thing you tried"
  if (!needle) return false;
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

/** prefix > substring > subsequence */
export function rank(candidates: Candidate[], q: string): Candidate[] {
  const lq = q.toLowerCase();
  if (!lq) return candidates;
  return candidates
    .map((c) => {
      const lc = c.label.toLowerCase();
      const score = lc.startsWith(lq) ? 0 : lc.includes(lq) ? 1 : fuzzyMatch(lc, lq) ? 2 : -1;
      return { c, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.c);
}

/**
 * A k9s-style prompt bar. Tab completes to the top candidate, enter submits,
 * esc cancels. Candidates are ranked against the first word of the value so
 * `:issues cloud`-style args survive completion.
 */
export function CommandBar(props: {
  prefix: string;
  candidates?: Candidate[];
  placeholder?: string;
  initial?: string;
  /** called on every keystroke (live filters) */
  onChange?: (value: string) => void;
  onSubmit: (value: string, top?: Candidate) => void;
  onCancel: () => void;
}) {
  const { prefix, candidates = [], placeholder, initial = '', onChange, onSubmit, onCancel } = props;
  const [value, setValue] = useState(initial);

  const [head, tail] = useMemo(() => {
    const idx = value.indexOf(' ');
    return idx === -1 ? [value, ''] : [value.slice(0, idx), value.slice(idx)];
  }, [value]);

  const ranked = useMemo(() => rank(candidates, head), [candidates, head]);

  useInput((_input, key) => {
    if (key.tab && ranked[0]) {
      setValue(ranked[0].value + tail);
      onChange?.(ranked[0].value + tail);
    }
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.key} bold>
          {prefix}
        </Text>
        <TextInput
          value={value}
          placeholder={placeholder}
          onChange={(v) => {
            setValue(v);
            onChange?.(v);
          }}
          onSubmit={(v) => onSubmit(v, ranked[0])}
        />
      </Box>
      {candidates.length > 0 && ranked.length > 0 && (
        <Text wrap="truncate">
          {'  '}
          {ranked.slice(0, 6).map((c, i) => (
            <Text key={c.value} bold={i === 0} color={i === 0 ? theme.selection : theme.dim}>
              {c.label}
              {i < Math.min(ranked.length, 6) - 1 ? '  ·  ' : ''}
            </Text>
          ))}
        </Text>
      )}
    </Box>
  );
}
