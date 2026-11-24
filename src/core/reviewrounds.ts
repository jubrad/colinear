/** Which pass this is, when a review is one of several on the same change. */
export interface ReviewRound {
  n: number;
  max: number;
}

/**
 * What a reviewer should do with knowing its round. Each round it raises is
 * another revision and another review, so the first round says everything
 * that matters at once, a middle round checks what the last one asked for
 * and what the fix disturbed, and the last round keeps to what would stop
 * the change shipping — there is no round after it to answer a nit.
 */
export function roundGuidance(round: ReviewRound | undefined): string {
  if (!round || round.max <= 1) return '';
  const { n, max } = round;
  const head = `## This is review round ${n} of ${max}
Your findings go back to the agent that wrote the code, which revises and commits; then the next round reviews again, until the rounds run out. Every finding costs a revision and a round, so be efficient with them.`;
  if (n <= 1) {
    return `${head}
- This is the first round: raise everything that matters **now**. A problem held back for a later round costs a whole extra revision.
- Group related points into one finding where one fix covers them. Leave out nits unless they are free to fix alongside something else.`;
  }
  if (n < max) {
    return `${head}
- An earlier round's findings were handed back and the agent revised. If \`.colinear-review.md\` still holds them, read them first. Check that each was addressed, and look hard at what the revision itself changed: fixes break things.
- Do not raise again what was fixed, or what the agent pushed back on with a reasonable argument. Raise new problems only if they matter.`;
  }
  return `${head}
- This is the **last** round: nothing you raise gets another review after the revision.
- Raise only what would stop this change shipping: correctness, data loss, security, a broken contract. Put everything else in the prose for the operator, not in the findings.
- If an earlier round's findings were addressed and nothing blocking is left, say so and raise nothing.`;
}
