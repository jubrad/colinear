import { createElement, type ComponentType } from 'react';
import { loadCustomViews } from '../core/customviews.js';
import type { Candidate } from '../ui/CommandBar.js';
import { BoardView, boardKeys } from './BoardView.js';
import { ConfigView, configKeys } from './ConfigView.js';
import { CostsView, costsKeys } from './CostsView.js';
import { ChatView, chatKeys } from './ChatView.js';
import { GcView, gcKeys } from './GcView.js';
import { HelpView, helpKeys } from './HelpView.js';
import { IssuesView, issuesKeys } from './IssuesView.js';
import { ProjectsView, projectsKeys } from './ProjectsView.js';
import { ProjectView, projectKeys } from './ProjectView.js';
import { ReviewsView, reviewsKeys } from './ReviewsView.js';
import { TaskView, taskKeys } from './TaskView.js';

export interface ViewDef {
  name: string;
  aliases: string[];
  describe: string;
  Component: ComponentType<{ param?: string }>;
  keys: Array<[string, string]>;
  custom?: boolean;
}

const builtinViews: ViewDef[] = [
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
  {
    name: 'plan',
    aliases: ['chat'],
    describe: 'project planning chat (:plan PROJECT)',
    Component: ChatView,
    keys: chatKeys,
  },
  {
    name: 'reviews',
    aliases: ['rev', 'pr'],
    describe: 'PRs awaiting my review + assisted pre-review',
    Component: ReviewsView,
    keys: reviewsKeys,
  },
  {
    name: 'costs',
    aliases: ['cost', '$'],
    describe: 'spend per ticket',
    Component: CostsView,
    keys: costsKeys,
  },
  {
    name: 'gc',
    aliases: ['disk'],
    describe: 'worktree disk — reclaim finished checkouts',
    Component: GcView,
    keys: gcKeys,
  },
  {
    name: 'config',
    aliases: ['cfg'],
    describe: 'view & edit colinear config',
    Component: ConfigView,
    keys: configKeys,
  },
  {
    name: 'help',
    aliases: ['h'],
    describe: 'views, keys, custom view schema',
    Component: HelpView,
    keys: helpKeys,
  },
];

export let views: ViewDef[] = [...builtinViews];

/** (Re)load ~/.config/colinear/views/*.json into the registry. Returns count. */
export function reloadCustomViews(): number {
  const specs = loadCustomViews();
  const custom: ViewDef[] = specs.map((spec) => ({
    name: spec.name,
    aliases: spec.aliases ?? [],
    describe: spec.describe ?? `custom view (${spec.name}.json)`,
    Component: (props: { param?: string }) => createElement(IssuesView, { ...props, spec }),
    keys: issuesKeys,
    custom: true,
  }));
  views = [...builtinViews, ...custom.filter((c) => !builtinViews.some((b) => b.name === c.name))];
  return custom.length;
}

reloadCustomViews();

export function findView(nameOrAlias: string): ViewDef | undefined {
  const n = nameOrAlias.toLowerCase();
  return views.find((v) => v.name === n || v.aliases.includes(n));
}

export function commandCandidates(): Candidate[] {
  return [
    ...views.map((v) => ({ label: `${v.name} — ${v.describe}`, value: v.name })),
    { label: 'reload — reload custom views', value: 'reload' },
  ];
}
