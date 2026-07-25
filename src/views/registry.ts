import type { ComponentType } from 'react';
import type { Candidate } from '../ui/CommandBar.js';
import { BoardView, boardKeys } from './BoardView.js';
import { IssuesView, issuesKeys } from './IssuesView.js';

export interface ViewDef {
  name: string;
  aliases: string[];
  describe: string;
  Component: ComponentType<{ param?: string }>;
  keys: Array<[string, string]>;
}

export const views: ViewDef[] = [
  {
    name: 'issues',
    aliases: ['i', 'is'],
    describe: 'browse & dispatch Linear issues',
    Component: IssuesView,
    keys: issuesKeys,
  },
  {
    name: 'board',
    aliases: ['b', 'bo'],
    describe: 'agent kanban board',
    Component: BoardView,
    keys: boardKeys,
  },
];

export function findView(nameOrAlias: string): ViewDef | undefined {
  const n = nameOrAlias.toLowerCase();
  return views.find((v) => v.name === n || v.aliases.includes(n));
}

export function commandCandidates(): Candidate[] {
  return views.map((v) => ({ label: `${v.name} — ${v.describe}`, value: v.name }));
}
