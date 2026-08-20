/**
 * Fenced JSON extraction, shared by the artifacts that end in one — review
 * documents (```findings) and plan drafts (```plan).
 *
 * The closing fence is found by parsing, not by regex: the block ends at the
 * first ``` where the JSON is valid. A non-greedy match once ended a findings
 * block at a ``` *inside* a JSON string (a fenced code suggestion in a review
 * comment), truncated the JSON, and a full review posted as an empty one.
 */

export interface FencedJson {
  value: unknown;
  /** offsets of the whole fence in the source, opening marker to closing ``` */
  start: number;
  end: number;
}

export function extractFencedJson(text: string, names: string[]): FencedJson | undefined {
  const open = new RegExp('```(?:' + names.join('|') + ')[^\\S\\n]*\\n?', 'g');
  for (let match = open.exec(text); match; match = open.exec(text)) {
    const bodyStart = match.index + match[0].length;
    for (let close = text.indexOf('```', bodyStart); close !== -1; close = text.indexOf('```', close + 3)) {
      try {
        const value: unknown = JSON.parse(text.slice(bodyStart, close));
        return { value, start: match.index, end: close + 3 };
      } catch {
        // an inner fence mid-string — keep scanning for the real closer
      }
    }
  }
  return undefined;
}

export function hasFenceOpening(text: string, names: string[]): boolean {
  return new RegExp('```(?:' + names.join('|') + ')[^\\S\\n]*\\n?').test(text);
}

/** The text with the fence removed — what a published document should carry. */
export function stripFence(text: string, names: string[]): string {
  const fence = extractFencedJson(text, names);
  if (!fence) return text.trim();
  return (text.slice(0, fence.start) + text.slice(fence.end)).trim();
}
