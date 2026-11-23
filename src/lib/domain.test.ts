import { describe, expect, it } from 'vitest';
import {
  appReducer,
  getBuildComparison,
  getDashboardMetrics,
  parseStoredState,
  validateDisposition,
  validateIssueDraft,
  validateIssueDraftBase,
  type AppState,
  type Build,
  type Issue,
  type Playtest,
  type Project,
  type Reply,
} from './domain';

const project: Project = {
  id: 'project-1',
  name: '星轨修理铺',
  genre: '解谜',
  summary: '修复星轨的短流程解谜原型',
  targetPlayer: '喜欢轻量解谜的新玩家',
  intendedExperience: '先困惑，再因发现规则而产生掌握感',
  createdAt: '2026-11-01T08:00:00.000Z',
};

const firstBuild: Build = {
  id: 'build-1',
  projectId: project.id,
  version: '0.1.0',
  url: 'https://example.com/game-v1',
  notes: '首个可玩版本',
  previousBuildId: undefined,
  addressedIssueIds: [],
  createdAt: '2026-11-02T08:00:00.000Z',
};

const playtest: Playtest = {
  id: 'test-1',
  projectId: project.id,
  buildId: firstBuild.id,
  title: '首次体验测试',
  objective: '验证玩家是否理解核心规则',
  task: '在没有作者提示的情况下完成第一关',
  targetCount: 5,
  status: 'running',
  createdAt: '2026-11-03T08:00:00.000Z',
};

function makeIssue(id: string, decision: 'pending' | 'accepted' = 'pending'): Issue {
  return {
    id,
    projectId: project.id,
    buildId: firstBuild.id,
    playtestId: playtest.id,
    title: '没有发现可交互节点',
    category: '目标与规则',
    severity: 'major',
    observation: '玩家在第一个场景停留后连续点击了背景两次，没有点击节点。',
    evidence: '录屏 00:42–01:18；玩家原话：“我不知道哪里能点。”',
    interpretation: '可交互节点与背景的视觉层级可能过近。',
    recommendation: '下一轮只调整节点反馈，再观察同一任务。',
    occurrenceCount: 1,
    occurrenceTotal: 1,
    testerName: '测试者 A',
    createdAt: '2026-11-03T09:00:00.000Z',
    disposition: {
      decision,
      reason: decision === 'accepted' ? '阻碍核心规则理解' : '',
      nextAction: decision === 'accepted' ? '增强节点 hover 与首次进入时的反馈' : '',
    },
  };
}

function baseState(): AppState {
  return {
    projects: [project],
    builds: [firstBuild],
    playtests: [playtest],
    issues: [makeIssue('issue-1', 'accepted'), makeIssue('issue-2', 'accepted')],
    retests: [],
    replies: [],
  };
}

const nextBuild: Build = {
  id: 'build-2',
  projectId: project.id,
  version: '0.2.0',
  url: 'https://example.com/game-v2',
  notes: '调整节点反馈',
  previousBuildId: firstBuild.id,
  addressedIssueIds: ['issue-1', 'issue-2'],
  createdAt: '2026-11-08T08:00:00.000Z',
};

describe('试玩问题证据规则', () => {
  it('拒绝缺少原始证据的问题草稿', () => {
    const issue = makeIssue('issue-draft');
    expect(validateIssueDraft({ ...issue, evidence: '  ' }).join(' ')).toContain('原始证据');
    expect(validateIssueDraft(issue)).toEqual([]);
  });

  it('采纳问题时必须给出下一版动作', () => {
    expect(validateDisposition({ decision: 'accepted', reason: '', nextAction: '' }).join(' ')).toContain('下一版动作');
    expect(validateDisposition({ decision: 'rejected', reason: '', nextAction: '' }).join(' ')).toContain('处置理由');
    expect(validateDisposition({ decision: 'accepted', reason: '', nextAction: '调整节点反馈' })).toEqual([]);
  });
});

describe('版本迭代闭环', () => {
  it('创建下一版时自动把已采纳问题加入待复测清单', () => {
    const state = appReducer(baseState(), { type: 'build/add', build: nextBuild });
    expect(state.retests).toHaveLength(2);
    expect(state.retests.every((retest) => retest.outcome === 'pending')).toBe(true);
    expect(state.retests.map((retest) => retest.issueId)).toEqual(['issue-1', 'issue-2']);
  });

  it('只有全部复测项完成后才计为完整闭环', () => {
    let state = appReducer(baseState(), { type: 'build/add', build: nextBuild });
    expect(getDashboardMetrics(state).completedLoops).toBe(0);

    state = appReducer(state, {
      type: 'retest/update',
      retestId: 'retest-build-2-issue-1',
      outcome: 'not-reproduced',
      note: '两名玩家均完成了节点交互',
      testedAt: '2026-11-09T08:00:00.000Z',
    });
    expect(getDashboardMetrics(state).completedLoops).toBe(0);

    state = appReducer(state, {
      type: 'retest/update',
      retestId: 'retest-build-2-issue-2',
      outcome: 'reproduced',
      note: '一名玩家仍未发现节点',
      testedAt: '2026-11-09T08:00:00.000Z',
    });
    expect(getDashboardMetrics(state).completedLoops).toBe(1);
  });

  it('复测对比保留原问题证据并区分新版本问题', () => {
    let state = appReducer(baseState(), { type: 'build/add', build: nextBuild });
    const newIssue = { ...makeIssue('issue-3'), buildId: nextBuild.id, title: '新的反馈问题' };
    state = appReducer(state, { type: 'issue/add', issue: newIssue });

    const comparison = getBuildComparison(state, nextBuild.id);
    expect(comparison?.previousBuild.id).toBe(firstBuild.id);
    expect(comparison?.items[0].issue.evidence).toContain('录屏');
    expect(comparison?.newIssues.map((issue) => issue.id)).toEqual(['issue-3']);
  });

  it('支持创建项目、发起试玩并记录作者处置', () => {
    let state: AppState = { projects: [], builds: [], playtests: [], issues: [], retests: [], replies: [] };
    state = appReducer(state, { type: 'project/add', project });
    state = appReducer(state, { type: 'build/add', build: firstBuild });
    state = appReducer(state, { type: 'playtest/add', playtest });
    state = appReducer(state, { type: 'issue/add', issue: makeIssue('issue-pending') });
    state = appReducer(state, {
      type: 'issue/disposition',
      issueId: 'issue-pending',
      disposition: { decision: 'accepted', reason: '影响首次体验', nextAction: '补充节点反馈' },
    });
    state = appReducer(state, { type: 'playtest/status', playtestId: playtest.id, status: 'complete' });

    expect(state.projects).toHaveLength(1);
    expect(state.playtests[0].status).toBe('complete');
    expect(state.issues[0].disposition.nextAction).toBe('补充节点反馈');
  });

  it('缓存损坏时恢复可信的初始状态', () => {
    const fallback = baseState();
    expect(parseStoredState('{broken', fallback)).toEqual(fallback);
    expect(parseStoredState(JSON.stringify(fallback), { ...fallback, projects: [] })).toEqual(fallback);
    const empty: AppState = { projects: [], builds: [], playtests: [], issues: [], retests: [], replies: [] };
    expect(appReducer(fallback, { type: 'state/replace', state: empty })).toEqual(empty);
  });
});

describe('项目内讨论：版本时间线与证据帖', () => {
  it('证据帖可以只绑定版本，不依赖试玩任务', () => {
    let state: AppState = { projects: [project], builds: [firstBuild], playtests: [], issues: [], retests: [], replies: [] };
    const thread: Issue = { ...makeIssue('thread-1'), playtestId: undefined, draft: false };
    state = appReducer(state, { type: 'issue/add', issue: thread });

    expect(state.issues[0].playtestId).toBeUndefined();
    expect(state.issues[0].buildId).toBe(firstBuild.id);
  });

  it('没有原始证据的帖子只能存为草稿，发布必须补证据', () => {
    const thread = { ...makeIssue('thread-draft'), playtestId: undefined, evidence: '' };

    expect(validateIssueDraftBase(thread)).toEqual([]);
    expect(validateIssueDraft(thread).join(' ')).toContain('原始证据');
    expect(validateIssueDraftBase({ ...thread, title: '  ' }).join(' ')).toContain('标题');
  });

  it('草稿不计入待处置问题，也不算版本对比中的新问题', () => {
    let state = appReducer(baseState(), { type: 'build/add', build: nextBuild });
    const draft: Issue = {
      ...makeIssue('thread-draft'),
      buildId: nextBuild.id,
      playtestId: undefined,
      draft: true,
    };
    state = appReducer(state, { type: 'issue/add', issue: draft });

    expect(getDashboardMetrics(state).pendingIssues).toBe(0);
    expect(getBuildComparison(state, nextBuild.id)?.newIssues).toHaveLength(0);

    state = appReducer(state, { type: 'issue/update', issue: { ...draft, evidence: '录屏 02:10', draft: false } });

    expect(getDashboardMetrics(state).pendingIssues).toBe(1);
    expect(getBuildComparison(state, nextBuild.id)?.newIssues.map((issue) => issue.id)).toEqual(['thread-draft']);
  });

  it('回复挂在证据帖上，旧缓存缺少回复字段时自动补空', () => {
    const reply: Reply = {
      id: 'reply-1',
      issueId: 'issue-1',
      projectId: project.id,
      buildId: firstBuild.id,
      author: '我',
      body: '同一场景第二次测试也停在这里',
      createdAt: '2026-11-04T09:00:00.000Z',
    };

    const state = appReducer(baseState(), { type: 'reply/add', reply });
    expect(state.replies).toEqual([reply]);

    const legacy = JSON.stringify({ ...baseState(), replies: undefined });
    expect(parseStoredState(legacy, emptyLegacyState()).replies).toEqual([]);
    expect(parseStoredState(JSON.stringify(state), baseState()).replies).toHaveLength(1);
  });
});

function emptyLegacyState(): AppState {
  return { projects: [], builds: [], playtests: [], issues: [], retests: [], replies: [] };
}
