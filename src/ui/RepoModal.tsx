import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { RepoConfig } from '../core/types.js';
import { theme } from '../theme.js';

/** Pick a repo to re-dispatch a task into (fresh worktree + session). */
export function RepoModal(props: {
  taskLabel: string;
  repos: RepoConfig[];
  current?: string;
  onSubmit: (repo: RepoConfig) => void;
  onCancel: () => void;
}) {
  const { taskLabel, repos, current, onSubmit, onCancel } = props;
  const [cursor, setCursor] = useState(() => {
    const idx = repos.findIndex((r) => r.name === current);
    return idx === -1 ? 0 : idx;
  });

  useInput((input, key) => {
    if (key.escape || input === 'q') onCancel();
    if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === 'j') setCursor((c) => Math.min(repos.length - 1, c + 1));
    if (key.return) onSubmit(repos[cursor]);
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
      <Text dimColor>enter: re-dispatch · esc: cancel</Text>
    </Box>
  );
}
