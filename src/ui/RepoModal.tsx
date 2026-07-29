import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { RepoConfig } from '../core/types.js';
import { theme } from '../theme.js';

/** Pick a repo to re-dispatch a task into (fresh worktree + session). */
export function RepoModal(props: {
  taskLabel: string;
  repos: RepoConfig[];
  current?: string;
  /** task has a usable "do" triage that can travel with the re-dispatch */
  hasTriage?: boolean;
  onSubmit: (repo: RepoConfig, opts: { retriage: boolean }) => void;
  onCancel: () => void;
}) {
  const { taskLabel, repos, current, hasTriage, onSubmit, onCancel } = props;
  const [cursor, setCursor] = useState(() => {
    const idx = repos.findIndex((r) => r.name === current);
    return idx === -1 ? 0 : idx;
  });

  useInput((input, key) => {
    if (key.escape || input === 'q') onCancel();
    if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === 'j') setCursor((c) => Math.min(repos.length - 1, c + 1));
    if (key.return) onSubmit(repos[cursor], { retriage: false });
    if (input === 't') onSubmit(repos[cursor], { retriage: true });
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={theme.key} paddingX={2}>
      <Text bold color={theme.key}>
        re-dispatch {taskLabel} — pick repo
      </Text>
      <Text dimColor>fresh worktree + session in the chosen repo; old worktree is left behind</Text>
      {repos.map((repo, i) => (
        <Text key={repo.name} inverse={i === cursor} wrap="truncate">
          {repo.name === current ? '● ' : '  '}
          {repo.name.padEnd(36)} <Text dimColor>{repo.path}</Text>
        </Text>
      ))}
      <Text dimColor>
        {hasTriage
          ? 'enter: re-dispatch keeping triage plan · t: re-dispatch + fresh triage · esc: cancel'
          : 'enter: re-dispatch (will triage) · esc: cancel'}
      </Text>
    </Box>
  );
}
