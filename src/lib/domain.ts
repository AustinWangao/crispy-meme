export type IssueCategory = '功能缺陷' | '目标与规则' | '操作与反馈' | '难度与节奏' | '玩家体验' | '玩法偏好';
export type Severity = 'blocker' | 'major' | 'minor' | 'preference';
export type Decision = 'pending' | 'accepted' | 'deferred' | 'rejected';
export type RetestOutcome = 'pending' | 'not-reproduced' | 'reproduced';

export interface Project {
  id: string;
  name: string;
  genre: string;
  summary: string;
  targetPlayer: string;
  intendedExperience: string;
  createdAt: string;
}

export interface Build {
  id: string;
  projectId: string;
  version: string;
  url: string;
  notes: string;
  previousBuildId?: string;
  addressedIssueIds: string[];
  createdAt: string;
}

export interface Playtest {
  id: string;
  projectId: string;
  buildId: string;
  title: string;
  objective: string;
  task: string;
  targetCount: number;
  status: 'recruiting' | 'running' | 'complete';
  createdAt: string;
}

export interface Disposition {
  decision: Decision;
  reason: string;
  nextAction: string;
}

export interface Issue {
  id: string;
  projectId: string;
  buildId: string;
  playtestId?: string;
  title: string;
  category: IssueCategory;
  severity: Severity;
  observation: string;
  evidence: string;
  interpretation: string;
  recommendation: string;
  occurrenceCount: number;
  occurrenceTotal: number;
  testerName: string;
  createdAt: string;
  draft?: boolean;
  disposition: Disposition;
}

export interface Retest {
  id: string;
  projectId: string;
  buildId: string;
  issueId: string;
  outcome: RetestOutcome;
  note: string;
  testedAt?: string;
}

export interface Reply {
  id: string;
  issueId: string;
  projectId: string;
  buildId: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface AppState {
  projects: Project[];
  builds: Build[];
  playtests: Playtest[];
  issues: Issue[];
  retests: Retest[];
  replies: Reply[];
}

export type AppAction =
  | { type: 'project/add'; project: Project }
  | { type: 'build/add'; build: Build }
  | { type: 'playtest/add'; playtest: Playtest }
  | { type: 'playtest/status'; playtestId: string; status: Playtest['status'] }
  | { type: 'issue/add'; issue: Issue }
  | { type: 'issue/update'; issue: Issue }
  | { type: 'issue/disposition'; issueId: string; disposition: Disposition }
  | { type: 'retest/update'; retestId: string; outcome: RetestOutcome; note: string; testedAt?: string }
  | { type: 'reply/add'; reply: Reply }
  | { type: 'state/replace'; state: AppState };

export const emptyState: AppState = {
  projects: [],
  builds: [],
  playtests: [],
  issues: [],
  retests: [],
  replies: [],
};

export function validateIssueDraftBase(issue: Pick<Issue, 'title' | 'observation'>): string[] {
  const errors: string[] = [];
  if (!issue.title.trim()) errors.push('请填写问题标题');
  if (!issue.observation.trim()) errors.push('请填写实际观察，而不是修改建议');
  return errors;
}

export function validateIssueDraft(issue: Pick<Issue, 'title' | 'observation' | 'evidence'>): string[] {
  const errors = validateIssueDraftBase(issue);
  if (!issue.evidence.trim()) errors.push('请提供原始证据，如时间点、玩家原话或录屏链接');
  return errors;
}

export function validateDisposition(disposition: Disposition): string[] {
  const errors: string[] = [];
  if (disposition.decision === 'accepted' && !disposition.nextAction.trim()) {
    errors.push('采纳后必须填写下一版动作');
  }
  if (['deferred', 'rejected'].includes(disposition.decision) && !disposition.reason.trim()) {
    errors.push('搁置或拒绝时必须填写处置理由');
  }
  return errors;
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'project/add':
      return { ...state, projects: [action.project, ...state.projects] };
    case 'build/add': {
      const newRetests = action.build.addressedIssueIds.flatMap((issueId) => {
        const issue = state.issues.find((item) => item.id === issueId);
        if (!issue || issue.disposition.decision !== 'accepted') return [];
        return [{
          id: `retest-${action.build.id}-${issueId}`,
          projectId: action.build.projectId,
          buildId: action.build.id,
          issueId,
          outcome: 'pending' as const,
          note: '',
        }];
      });
      return {
        ...state,
        builds: [action.build, ...state.builds],
        retests: [...state.retests, ...newRetests],
      };
    }
    case 'playtest/add':
      return { ...state, playtests: [action.playtest, ...state.playtests] };
    case 'playtest/status':
      return {
        ...state,
        playtests: state.playtests.map((playtest) =>
          playtest.id === action.playtestId ? { ...playtest, status: action.status } : playtest,
        ),
      };
    case 'issue/add':
      return { ...state, issues: [action.issue, ...state.issues] };
    case 'issue/update':
      return {
        ...state,
        issues: state.issues.map((issue) => (issue.id === action.issue.id ? action.issue : issue)),
      };
    case 'issue/disposition':
      return {
        ...state,
        issues: state.issues.map((issue) =>
          issue.id === action.issueId ? { ...issue, disposition: action.disposition } : issue,
        ),
      };
    case 'retest/update':
      return {
        ...state,
        retests: state.retests.map((retest) =>
          retest.id === action.retestId
            ? { ...retest, outcome: action.outcome, note: action.note, testedAt: action.testedAt }
            : retest,
        ),
      };
    case 'reply/add':
      return { ...state, replies: [...state.replies, action.reply] };
    case 'state/replace':
      return action.state;
  }
}

export function getBuildComparison(state: AppState, buildId: string) {
  const build = state.builds.find((item) => item.id === buildId);
  if (!build?.previousBuildId) return undefined;
  const previousBuild = state.builds.find((item) => item.id === build.previousBuildId);
  if (!previousBuild) return undefined;

  const items = state.retests
    .filter((retest) => retest.buildId === buildId)
    .flatMap((retest) => {
      const issue = state.issues.find((item) => item.id === retest.issueId);
      return issue ? [{ retest, issue }] : [];
    });

  return {
    build,
    previousBuild,
    items,
    newIssues: state.issues.filter((issue) => issue.buildId === buildId && !issue.draft),
  };
}

export function getDashboardMetrics(state: AppState) {
  const completedLoops = state.builds.filter((build) => {
    if (!build.previousBuildId) return false;
    const retests = state.retests.filter((retest) => retest.buildId === build.id);
    return retests.length > 0 && retests.every((retest) => retest.outcome !== 'pending');
  }).length;

  return {
    activeProjects: state.projects.length,
    runningTests: state.playtests.filter((playtest) => playtest.status !== 'complete').length,
    pendingIssues: state.issues.filter((issue) => !issue.draft && issue.disposition.decision === 'pending').length,
    completedLoops,
  };
}

export function parseStoredState(raw: string | null, fallback: AppState): AppState {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<AppState>;
    const keys: (keyof AppState)[] = ['projects', 'builds', 'playtests', 'issues', 'retests'];
    if (!keys.every((key) => Array.isArray(parsed[key]))) return fallback;
    return {
      ...(parsed as AppState),
      replies: Array.isArray(parsed.replies) ? parsed.replies : [],
    };
  } catch {
    return fallback;
  }
}
