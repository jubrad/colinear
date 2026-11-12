import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { rankHits, type CodeHit, type CodeSearchResult, type HitKind, type SearchMode } from '../core/symbols.js';
import { palette, theme } from '../theme.js';
import { spinFrame, useFrame } from './ChatLog.js';
import { TextArea } from './TextArea.js';

type Phase = 'symbol' | 'query' | 'loading' | 'results';

const TAG: Record<HitKind, string> = { def: 'def ', call: 'call', ref: 'ref ', import: 'use ' };
const TAG_COLOR: Record<HitKind, string> = palette(() => ({ def: theme.accent, call: theme.key, ref: theme.dim, import: theme.dim }));

/** The last search, kept by the diff so `/` + enter goes straight back to it. */
export interface SearchMemo {
  result: CodeSearchResult;
  cursor: number;
}

/**
 * Searching the checkout from the annotated diff: `/` for text, `*` for the
 * call sites of a symbol on the cursor's line. The popup's contents — the frame
 * is the caller's Popup.
 *
 * A result is somewhere to go, not something to read here: enter takes the
 * diff to that line, widening the file or opening it if the change never
 * touched it, so a caller is read in the same view, with the same margin, as
 * the code it calls.
 */
export function CodeSearch(props: {
  /** `refs` with symbols starts on the pick-a-symbol list; otherwise on the input */
  mode: SearchMode;
  symbols?: string[];
  /** a symbol already chosen — the word cursor's — searched for at once, no list */
  start?: string;
  width: number;
  height: number;
  last?: SearchMemo;
  run: (mode: SearchMode, query: string) => Promise<CodeSearchResult>;
  /** is this file part of the change — those hits are marked, and ranked first */
  inChange: (file: string) => boolean;
  onPick: (hit: CodeHit, memo: SearchMemo) => void;
  onCancel: () => void;
}) {
  const { width, height, run, inChange, onPick, onCancel } = props;
  const symbols = props.symbols ?? [];
  const [mode, setMode] = useState<SearchMode>(props.mode);
  const [phase, setPhase] = useState<Phase>(props.mode === 'refs' && symbols.length ? 'symbol' : 'query');
  const [symIdx, setSymIdx] = useState(0);
  // `/` starts from the last pattern, so enter on it reopens those results
  const [query, setQuery] = useState(props.mode === 'grep' && props.last?.result.mode === 'grep' ? props.last.result.query : '');
  const [result, setResult] = useState<CodeSearchResult | undefined>(props.last?.result);
  const [cursor, setCursor] = useState(props.last?.cursor ?? 0);
  const frame = useFrame(phase === 'loading');
  /** the search a reply belongs to — a slow one answered after a newer one is dropped */
  const ticket = useRef(0);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);
  useEffect(() => void (props.start && search('refs', props.start)), []);

  const hits = useMemo(() => (result ? rankHits(result.hits, inChange) : []), [result, inChange]);

  const search = (m: SearchMode, q: string) => {
    const text = q.trim();
    if (!text) return;
    if (result && result.mode === m && result.query === text && !result.error) {
      setPhase('results');
      return;
    }
    const mine = ++ticket.current;
    setMode(m);
    setPhase('loading');
    void run(m, text).then((r) => {
      if (!live.current || mine !== ticket.current) return;
      setResult(r);
      setCursor(0);
      setPhase('results');
    });
  };

  // title, input/status, summary, footer and a spare row: the list gets the rest
  const listRows = Math.max(1, height - 5);
  const top = Math.max(0, Math.min(cursor - Math.floor(listRows / 2), hits.length - listRows));

  useInput((input, key) => {
    if (phase === 'query') {
      if (key.escape) return result ? setPhase('results') : onCancel();
      // the input decides what kind of search enter runs
      if (key.tab) return setMode((m) => (m === 'grep' ? 'refs' : 'grep'));
      return; // the text area has the rest, enter included
    }
    if (key.escape || input === 'q') return onCancel();
    if (phase === 'loading') return;
    if (phase === 'symbol') {
      if (input === 'k' || key.downArrow) setSymIdx((i) => Math.min(symbols.length - 1, i + 1));
      if (input === 'i' || key.upArrow) setSymIdx((i) => Math.max(0, i - 1));
      if (key.return && symbols[symIdx]) search('refs', symbols[symIdx]);
      if (input === '/') {
        setQuery(symbols[symIdx] ?? '');
        setPhase('query');
      }
      return;
    }
    // results
    const last = Math.max(0, hits.length - 1);
    if (input === 'k' || key.downArrow) setCursor((c) => Math.min(last, c + 1));
    if (input === 'i' || key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.pageDown || input === ' ') setCursor((c) => Math.min(last, c + listRows));
    if (key.pageUp) setCursor((c) => Math.max(0, c - listRows));
    if (input === 'g') setCursor(0);
    if (input === 'G') setCursor(last);
    if (key.return && hits[cursor] && result) onPick(hits[cursor], { result, cursor });
    if (input === '/') {
      setQuery(result?.query ?? '');
      setPhase('query');
    }
  });

  const title =
    phase === 'symbol'
      ? 'call sites of…'
      : result && phase === 'results'
        ? result.mode === 'refs'
          ? `call sites of ${result.query}`
          : `search: ${result.query}`
        : mode === 'refs'
          ? 'call sites of a symbol'
          : 'search the checkout';

  const pathRoom = Math.max(12, Math.floor(width * 0.4));

  return (
    <Box flexDirection="column" flexShrink={0} height={height}>
      <Text bold color={theme.key} wrap="truncate">
        {title}
      </Text>

      {phase === 'query' && (
        <Box>
          <Text color={theme.accent}>{mode === 'refs' ? 'symbol  ' : 'pattern '}</Text>
          <TextArea
            value={query}
            onChange={setQuery}
            focus
            width={width - 8}
            height={1}
            submitOnEnter
            placeholder={mode === 'refs' ? 'a name — whole-word, every file' : 'a regex — case-insensitive unless it has a capital'}
            onSubmit={() => search(mode, query)}
          />
        </Box>
      )}
      {phase === 'loading' && (
        <Text color={theme.accent} wrap="truncate">
          {spinFrame(frame)} {mode === 'refs' ? 'finding call sites' : 'searching'}…
        </Text>
      )}
      {(phase === 'symbol' || phase === 'results') && <Text> </Text>}

      {phase === 'symbol' &&
        symbols.slice(Math.max(0, symIdx - listRows + 1), Math.max(0, symIdx - listRows + 1) + listRows).map((s) => {
          const here = s === symbols[symIdx];
          return (
            <Text key={s} inverse={here} bold={here} wrap="truncate">
              {' '}
              {s}
              {s === symbols[0] ? <Text dimColor>{'  '}best guess</Text> : null}{' '}
            </Text>
          );
        })}

      {phase === 'results' && result && (
        <>
          <Text wrap="truncate" color={result.error ? theme.err : undefined} dimColor={!result.error}>
            {result.error ?? summary(result, hits, inChange)}
          </Text>
          {hits.slice(top, top + listRows).map((h, i) => {
            const here = top + i === cursor;
            const where = `${shorten(h.file, pathRoom)}:${h.line}`;
            return (
              <Text key={`${h.file}:${h.line}:${top + i}`} inverse={here} wrap="truncate">
                {h.kind ? <Text color={here ? undefined : TAG_COLOR[h.kind]}>{TAG[h.kind]} </Text> : null}
                <Text color={here ? undefined : theme.warn}>{inChange(h.file) ? '*' : ' '}</Text>
                <Text dimColor={!here}> {where}  </Text>
                <Text>{h.text}</Text>
              </Text>
            );
          })}
        </>
      )}

      <Box flexGrow={1} />
      <Text dimColor wrap="truncate">
        {phase === 'query'
          ? `enter searches · tab: ${mode === 'refs' ? 'text instead' : 'call sites instead'} · esc ${result ? 'back' : 'closes'}`
          : phase === 'symbol'
            ? 'i/k pick · enter lists its call sites · / type another · esc'
            : phase === 'results'
              ? 'i/k move · enter goes there in the diff · / search again · esc'
              : 'esc closes'}
      </Text>
    </Box>
  );
}

/** "12 call sites — 2 def · 7 call · 3 ref · * 4 in this change", or a match count. */
function summary(result: CodeSearchResult, hits: CodeHit[], inChange: (file: string) => boolean): string {
  if (!hits.length) return result.mode === 'refs' ? `nothing in the checkout mentions ${result.query}` : 'no matches';
  const mine = hits.filter((h) => inChange(h.file)).length;
  const files = new Set(hits.map((h) => h.file)).size;
  const more = result.truncated ? ` (first ${hits.length} shown)` : '';
  const marked = mine ? ` · * ${mine} in this change` : '';
  if (result.mode === 'grep') return `${hits.length} match${hits.length === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}${more}${marked}`;
  const count = (k: HitKind) => hits.filter((h) => h.kind === k).length;
  const parts = (['def', 'call', 'ref', 'import'] as HitKind[])
    .filter((k) => count(k))
    .map((k) => `${count(k)} ${TAG[k].trim()}`);
  return `${hits.length} in ${files} file${files === 1 ? '' : 's'}${more} — ${parts.join(' · ')}${marked}`;
}

/** A path cut from the left, keeping the file name — the part you recognise. */
function shorten(path: string, room: number): string {
  return path.length <= room ? path : `…${path.slice(path.length - room + 1)}`;
}
