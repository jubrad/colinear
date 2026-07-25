import type { ComponentType } from 'react';
import type { Candidate } from '../ui/CommandBar.js';
import { BoardView, boardKeys } from './BoardView.js';
import { IssuesView, issuesKeys } from './IssuesView.js';
import { ProjectsView, projectsKeys } from './ProjectsView.js';
import { ProjectView, projectKeys } from './ProjectView.js';
import { TaskView, taskKeys } from './TaskView.js';

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
  {
    name: 'task',
    aliases: ['ta'],
    describe: 'task detail + live log (:task CLOUD-123)',
    Component: TaskView,
    keys: taskKeys,
  },
  {
    name: 'projects',
    aliases: ['pj', 'proj'],
    describe: 'Linear projects',
    Component: ProjectsView,
    keys: projectsKeys,
  },
  {
    name: 'project',
    aliases: ['pr'],
    describe: 'project kanban (:project NAME)',
    Component: ProjectView,
    keys: projectKeys,
  },
];

export function findView(nameOrAlias: string): ViewDef | undefined {
  const n = nameOrAlias.toLowerCase();
  return views.find((v) => v.name === n || v.aliases.includes(n));
}

export function commandCandidates(): Candidate[] {
  return views.map((v) => ({ label: `${v.name} — ${v.describe}`, value: v.name }));
}
