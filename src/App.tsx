import { useEffect, useReducer, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileText,
  FlaskConical,
  FolderKanban,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  Plus,
  RotateCcw,
  Target,
  X,
} from 'lucide-react';
import {
  appReducer,
  emptyState,
  getDashboardMetrics,
  parseStoredState,
  validateDisposition,
  validateIssueDraft,
  validateIssueDraftBase,
  type AppState,
  type Build,
  type Decision,
  type Issue,
  type IssueCategory,
  type Playtest,
  type Project,
  type Retest,
  type RetestOutcome,
  type Severity,
} from './lib/domain';

const STORAGE_KEY = 'replay-state-v1';
type View = 'overview' | 'builds' | 'playtests' | 'retests';
type ModalState =
  | { type: 'project' }
  | { type: 'build'; next: boolean }
  | { type: 'playtest' }
  | { type: 'issue' }
  | { type: 'thread'; issueId?: string }
  | { type: 'disposition'; issueId: string; decision: Exclude<Decision, 'pending'> }
  | null;

const navigation: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: '总览', icon: LayoutDashboard },
  { id: 'builds', label: '项目与版本', icon: FolderKanban },
  { id: 'playtests', label: '试玩任务', icon: FlaskConical },
  { id: 'retests', label: '复测中心', icon: RotateCcw },
];

const decisionLabels: Record<Decision, string> = {
  pending: '待处置',
  accepted: '已采纳',
  deferred: '已搁置',
  rejected: '已拒绝',
};

const severityLabels: Record<Severity, string> = {
  blocker: '阻断',
  major: '严重',
  minor: '一般',
  preference: '偏好',
};

const outcomeLabels: Record<RetestOutcome, string> = {
  pending: '待复测',
  'not-reproduced': '本轮未复现',
  reproduced: '仍然复现',
};

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formValue(data: FormData, key: string) {
  return String(data.get(key) ?? '').trim();
}

function formatDate(value?: string) {
  if (!value) return '尚未记录';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(value));
}

interface ModalProps {
  title: string;
  eyebrow: string;
  children: ReactNode;
  onClose: () => void;
}

function Modal({ title, eyebrow, children, onClose }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const firstField = panelRef.current?.querySelector<HTMLElement>('input, textarea, select, button');
    firstField?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={panelRef}>
        <div className="modal-heading">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2 id="modal-title">{title}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭弹窗" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function FormActions({ submitLabel }: { submitLabel: string }) {
  return (
    <div className="form-actions">
      <span>带 * 为必填项</span>
      <button className="button button-primary" type="submit">
        {submitLabel}
        <ArrowRight size={17} />
      </button>
    </div>
  );
}

function ProjectForm({ onSave }: { onSave: (project: Project) => void }) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSave({
      id: createId('project'),
      name: formValue(data, 'name'),
      genre: formValue(data, 'genre'),
      summary: formValue(data, 'summary'),
      targetPlayer: formValue(data, 'targetPlayer'),
      intendedExperience: formValue(data, 'intendedExperience'),
      createdAt: new Date().toISOString(),
    });
  };

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <div className="field field-full">
        <label htmlFor="project-name">项目名称</label>
        <input id="project-name" name="name" required placeholder="例如：星轨修理铺" />
      </div>
      <div className="field field-full">
        <label htmlFor="project-genre">类型</label>
        <input id="project-genre" name="genre" required placeholder="解谜、动作、模拟经营…" />
      </div>
      <div className="field field-full">
        <label htmlFor="project-summary">项目简介</label>
        <textarea id="project-summary" name="summary" required rows={3} placeholder="用一句话说明当前可玩原型" />
      </div>
      <div className="field">
        <label htmlFor="target-player">目标玩家</label>
        <textarea id="target-player" name="targetPlayer" required rows={3} placeholder="这次希望谁来玩？" />
      </div>
      <div className="field">
        <label htmlFor="intended-experience">目标体验</label>
        <textarea id="intended-experience" name="intendedExperience" required rows={3} placeholder="希望玩家经历什么感受？" />
      </div>
      <div className="field-full">
        <FormActions submitLabel="创建项目" />
      </div>
    </form>
  );
}

function BuildForm({
  next,
  acceptedIssues,
  onSave,
}: {
  next: boolean;
  acceptedIssues: Issue[];
  onSave: (version: string, url: string, notes: string) => void;
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSave(formValue(data, 'version'), formValue(data, 'url'), formValue(data, 'notes'));
  };

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      {next && (
        <div className="form-notice field-full">
          <ListChecks size={19} />
          <div>
            <strong>本版将复测 {acceptedIssues.length} 项已采纳问题</strong>
            <span>{acceptedIssues.map((issue) => issue.title).join('、')}</span>
          </div>
        </div>
      )}
      <div className="field field-full">
        <label htmlFor="build-version">版本号</label>
        <input id="build-version" name="version" required placeholder={next ? '例如：0.2.0' : '例如：0.1.0'} />
      </div>
      <div className="field field-full">
        <label htmlFor="build-url">可玩链接</label>
        <input id="build-url" name="url" type="url" required placeholder="https://" />
        <small>填写测试者无需作者解释即可打开的版本地址。</small>
      </div>
      <div className="field field-full">
        <label htmlFor="build-notes">本版修改</label>
        <textarea id="build-notes" name="notes" required rows={4} placeholder="记录可验证的改动，不写“全面优化”" />
      </div>
      <div className="field-full">
        <FormActions submitLabel="保存版本" />
      </div>
    </form>
  );
}

function PlaytestForm({ onSave }: { onSave: (playtest: Playtest) => void }) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSave({
      id: createId('playtest'),
      projectId: '',
      buildId: '',
      title: formValue(data, 'title'),
      objective: formValue(data, 'objective'),
      task: formValue(data, 'task'),
      targetCount: Number(data.get('targetCount')),
      status: 'running',
      createdAt: new Date().toISOString(),
    });
  };

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <div className="field field-full">
        <label htmlFor="playtest-title">试玩标题</label>
        <input id="playtest-title" name="title" required placeholder="例如：首次体验测试" />
      </div>
      <div className="field field-full">
        <label htmlFor="playtest-objective">评测目标</label>
        <textarea id="playtest-objective" name="objective" required rows={3} placeholder="这一轮最想验证什么？只聚焦一个关键问题" />
      </div>
      <div className="field field-full">
        <label htmlFor="playtest-task">试玩任务</label>
        <textarea id="playtest-task" name="task" required rows={3} placeholder="给测试者的具体任务，不透露解法" />
      </div>
      <div className="field field-full">
        <label htmlFor="target-count">目标人数</label>
        <input id="target-count" name="targetCount" type="number" min={1} max={99} defaultValue={5} required />
        <small>形成性试玩用于发现问题，不用于推断总体比例。</small>
      </div>
      <div className="field-full">
        <FormActions submitLabel="创建试玩" />
      </div>
    </form>
  );
}

function IssueForm({ onSave }: { onSave: (issue: Omit<Issue, 'id' | 'projectId' | 'buildId' | 'playtestId' | 'createdAt'>) => void }) {
  const [errors, setErrors] = useState<string[]>([]);
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const draft = {
      title: formValue(data, 'title'),
      observation: formValue(data, 'observation'),
      evidence: formValue(data, 'evidence'),
    };
    const nextErrors = validateIssueDraft(draft);
    if (nextErrors.length) {
      setErrors(nextErrors);
      return;
    }
    onSave({
      ...draft,
      category: formValue(data, 'category') as IssueCategory,
      severity: formValue(data, 'severity') as Severity,
      interpretation: formValue(data, 'interpretation'),
      recommendation: formValue(data, 'recommendation'),
      occurrenceCount: Number(data.get('occurrenceCount')),
      occurrenceTotal: Number(data.get('occurrenceTotal')),
      testerName: formValue(data, 'testerName'),
      disposition: { decision: 'pending', reason: '', nextAction: '' },
    });
  };

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      {errors.length > 0 && <div className="form-error field-full" role="alert">{errors.join('；')}</div>}
      <div className="field field-full">
        <label htmlFor="issue-title">问题标题</label>
        <input id="issue-title" name="title" required placeholder="描述可观察的问题，不写抽象评价" />
      </div>
      <div className="field">
        <label htmlFor="issue-category">问题类型</label>
        <select id="issue-category" name="category" defaultValue="目标与规则">
          {(['功能缺陷', '目标与规则', '操作与反馈', '难度与节奏', '玩家体验', '玩法偏好'] as IssueCategory[]).map((category) => (
            <option key={category}>{category}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="issue-severity">影响程度</label>
        <select id="issue-severity" name="severity" defaultValue="major">
          {(Object.keys(severityLabels) as Severity[]).map((severity) => (
            <option key={severity} value={severity}>{severityLabels[severity]}</option>
          ))}
        </select>
      </div>
      <div className="field field-full">
        <label htmlFor="issue-observation">实际观察</label>
        <textarea id="issue-observation" name="observation" required rows={3} placeholder="玩家做了什么？发生在什么任务与情境？" />
      </div>
      <div className="field field-full">
        <label htmlFor="issue-evidence">原始证据</label>
        <textarea id="issue-evidence" name="evidence" required rows={3} placeholder="录屏时间点、玩家原话、截图或链接；事实与解释分开记录" />
      </div>
      <div className="field">
        <label htmlFor="issue-interpretation">解释假设</label>
        <textarea id="issue-interpretation" name="interpretation" rows={3} placeholder="可能原因，保留不确定性" />
      </div>
      <div className="field">
        <label htmlFor="issue-recommendation">修改建议</label>
        <textarea id="issue-recommendation" name="recommendation" rows={3} placeholder="下一轮可验证的最小改动" />
      </div>
      <div className="field">
        <label htmlFor="tester-name">测试者</label>
        <input id="tester-name" name="testerName" required placeholder="姓名或匿名编号" />
      </div>
      <div className="field field-split">
        <div>
          <label htmlFor="occurrence-count">出现人数</label>
          <input id="occurrence-count" name="occurrenceCount" type="number" min={1} defaultValue={1} required />
        </div>
        <div>
          <label htmlFor="occurrence-total">观察人数</label>
          <input id="occurrence-total" name="occurrenceTotal" type="number" min={1} defaultValue={1} required />
        </div>
      </div>
      <div className="field-full">
        <FormActions submitLabel="保存问题" />
      </div>
    </form>
  );
}

type ThreadPayload = Pick<
  Issue,
  'title' | 'category' | 'severity' | 'observation' | 'evidence' | 'interpretation' | 'testerName' | 'draft'
>;

function ThreadForm({ initial, onSave }: { initial?: Issue; onSave: (payload: ThreadPayload) => void }) {
  const [errors, setErrors] = useState<string[]>([]);
  const formRef = useRef<HTMLFormElement>(null);

  const save = (draft: boolean) => {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    const payload: ThreadPayload = {
      title: formValue(data, 'title'),
      category: formValue(data, 'category') as IssueCategory,
      severity: formValue(data, 'severity') as Severity,
      observation: formValue(data, 'observation'),
      evidence: formValue(data, 'evidence'),
      interpretation: formValue(data, 'interpretation'),
      testerName: formValue(data, 'testerName') || '匿名',
      draft,
    };
    const nextErrors = draft ? validateIssueDraftBase(payload) : validateIssueDraft(payload);
    if (nextErrors.length) {
      setErrors(nextErrors);
      return;
    }
    onSave(payload);
  };

  return (
    <form className="form-grid" ref={formRef} onSubmit={(event) => { event.preventDefault(); save(false); }}>
      {errors.length > 0 && <div className="form-error field-full" role="alert">{errors.join('；')}</div>}
      <div className="field field-full">
        <label htmlFor="thread-title">问题标题</label>
        <input id="thread-title" name="title" defaultValue={initial?.title} placeholder="描述可观察的问题，不写抽象评价" />
      </div>
      <div className="field">
        <label htmlFor="thread-category">问题类型</label>
        <select id="thread-category" name="category" defaultValue={initial?.category ?? '目标与规则'}>
          {(['功能缺陷', '目标与规则', '操作与反馈', '难度与节奏', '玩家体验', '玩法偏好'] as IssueCategory[]).map((category) => (
            <option key={category}>{category}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="thread-severity">影响程度</label>
        <select id="thread-severity" name="severity" defaultValue={initial?.severity ?? 'major'}>
          {(Object.keys(severityLabels) as Severity[]).map((severity) => (
            <option key={severity} value={severity}>{severityLabels[severity]}</option>
          ))}
        </select>
      </div>
      <div className="field field-full">
        <label htmlFor="thread-observation">实际观察</label>
        <textarea id="thread-observation" name="observation" rows={3} defaultValue={initial?.observation} placeholder="玩家做了什么？发生在什么任务与情境？" />
      </div>
      <div className="field field-full">
        <label htmlFor="thread-evidence">原始证据</label>
        <textarea id="thread-evidence" name="evidence" rows={3} defaultValue={initial?.evidence} placeholder="录屏时间点、玩家原话、截图或链接；没有证据只能存为草稿" />
      </div>
      <div className="field field-full">
        <label htmlFor="thread-interpretation">解释假设</label>
        <textarea id="thread-interpretation" name="interpretation" rows={2} defaultValue={initial?.interpretation} placeholder="可能原因，保留不确定性" />
      </div>
      <div className="field field-full">
        <label htmlFor="thread-tester">测试者</label>
        <input id="thread-tester" name="testerName" defaultValue={initial?.testerName} placeholder="姓名或匿名编号" />
      </div>
      <div className="form-actions field-full">
        <span>没有原始证据只能存为草稿</span>
        <div className="form-action-buttons">
          <button className="button button-secondary" type="button" onClick={() => save(true)}>存为草稿</button>
          <button className="button button-primary" type="button" onClick={() => save(false)}>发布证据帖</button>
        </div>
      </div>
    </form>
  );
}

function DispositionForm({
  issue,
  initialDecision,
  onSave,
}: {
  issue: Issue;
  initialDecision: Exclude<Decision, 'pending'>;
  onSave: (decision: Decision, reason: string, nextAction: string) => void;
}) {
  const [errors, setErrors] = useState<string[]>([]);
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const disposition = {
      decision: formValue(data, 'decision') as Decision,
      reason: formValue(data, 'reason'),
      nextAction: formValue(data, 'nextAction'),
    };
    const nextErrors = validateDisposition(disposition);
    if (nextErrors.length) {
      setErrors(nextErrors);
      return;
    }
    onSave(disposition.decision, disposition.reason, disposition.nextAction);
  };

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      {errors.length > 0 && <div className="form-error field-full" role="alert">{errors.join('；')}</div>}
      <blockquote className="issue-quote field-full">“{issue.observation}”</blockquote>
      <fieldset className="decision-options field-full">
        <legend>处置决定</legend>
        {(['accepted', 'deferred', 'rejected'] as const).map((decision) => (
          <label key={decision} className="radio-card">
            <input type="radio" name="decision" value={decision} defaultChecked={decision === initialDecision} />
            <span>{decision === 'accepted' ? '采纳' : decision === 'deferred' ? '搁置' : '拒绝'}</span>
          </label>
        ))}
      </fieldset>
      <div className="field field-full">
        <label htmlFor="next-action">下一版动作</label>
        <textarea id="next-action" name="nextAction" rows={3} defaultValue={initialDecision === 'accepted' ? issue.recommendation : ''} placeholder="采纳时必填：下一版具体改什么，如何复测？" />
      </div>
      <div className="field field-full">
        <label htmlFor="disposition-reason">处置理由</label>
        <textarea id="disposition-reason" name="reason" rows={3} placeholder="搁置或拒绝时必填；也可记录采纳依据" />
      </div>
      <div className="field-full">
        <FormActions submitLabel="确认处置" />
      </div>
    </form>
  );
}

function StatusChip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'orange' | 'red' }) {
  return <span className={`status-chip status-${tone}`}>{children}</span>;
}

function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

function App() {
  const [state, dispatch] = useReducer(appReducer, emptyState, (initial) =>
    parseStoredState(window.localStorage.getItem(STORAGE_KEY), initial),
  );
  const [view, setView] = useState<View>('overview');
  const [selectedProjectId, setSelectedProjectId] = useState(() => state.projects[0]?.id ?? '');
  const [selectedBuildId, setSelectedBuildId] = useState('');
  const [selectedPlaytestId, setSelectedPlaytestId] = useState('');
  const [modal, setModal] = useState<ModalState>(null);
  const [threadFilter, setThreadFilter] = useState<'all' | 'pending' | 'accepted' | 'draft'>('all');

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const selectedProject = state.projects.find((project) => project.id === selectedProjectId) ?? state.projects[0];
  const projectBuilds = selectedProject ? state.builds.filter((build) => build.projectId === selectedProject.id) : [];
  const selectedBuild = projectBuilds.find((build) => build.id === selectedBuildId) ?? projectBuilds[0];
  const buildPlaytests = selectedBuild ? state.playtests.filter((playtest) => playtest.buildId === selectedBuild.id) : [];
  const selectedPlaytest = buildPlaytests.find((playtest) => playtest.id === selectedPlaytestId) ?? buildPlaytests[0];
  const projectIssues = selectedProject ? state.issues.filter((issue) => issue.projectId === selectedProject.id) : [];
  const buildIssues = selectedBuild ? projectIssues.filter((issue) => issue.buildId === selectedBuild.id) : [];
  const acceptedIssues = buildIssues.filter((issue) => issue.disposition.decision === 'accepted');
  const projectRetests = selectedProject ? state.retests.filter((retest) => retest.projectId === selectedProject.id) : [];
  const metrics = getDashboardMetrics(state);
  const dispositionIssue = modal?.type === 'disposition' ? state.issues.find((issue) => issue.id === modal.issueId) : undefined;

  const selectProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    setSelectedBuildId('');
    setSelectedPlaytestId('');
    setView('overview');
  };

  const selectBuild = (buildId: string) => {
    setSelectedBuildId(buildId);
    setSelectedPlaytestId('');
  };

  const saveProject = (project: Project) => {
    dispatch({ type: 'project/add', project });
    setSelectedProjectId(project.id);
    setSelectedBuildId('');
    setSelectedPlaytestId('');
    setView('overview');
    setModal(null);
  };

  const saveBuild = (version: string, url: string, notes: string) => {
    if (!selectedProject || modal?.type !== 'build') return;
    const build: Build = {
      id: createId('build'),
      projectId: selectedProject.id,
      version,
      url,
      notes,
      previousBuildId: modal.next ? selectedBuild?.id : undefined,
      addressedIssueIds: modal.next ? acceptedIssues.map((issue) => issue.id) : [],
      createdAt: new Date().toISOString(),
    };
    dispatch({ type: 'build/add', build });
    setSelectedBuildId(build.id);
    setSelectedPlaytestId('');
    setView('builds');
    setModal(null);
  };

  const savePlaytest = (draft: Playtest) => {
    if (!selectedProject || !selectedBuild) return;
    const playtest = { ...draft, projectId: selectedProject.id, buildId: selectedBuild.id };
    dispatch({ type: 'playtest/add', playtest });
    setSelectedPlaytestId(playtest.id);
    setView('playtests');
    setModal(null);
  };

  const saveIssue = (draft: Omit<Issue, 'id' | 'projectId' | 'buildId' | 'playtestId' | 'createdAt'>) => {
    if (!selectedProject || !selectedBuild || !selectedPlaytest) return;
    dispatch({
      type: 'issue/add',
      issue: {
        ...draft,
        id: createId('issue'),
        projectId: selectedProject.id,
        buildId: selectedBuild.id,
        playtestId: selectedPlaytest.id,
        createdAt: new Date().toISOString(),
      },
    });
    setView('playtests');
    setModal(null);
  };

  const saveThread = (payload: ThreadPayload) => {
    if (!selectedProject || !selectedBuild || modal?.type !== 'thread') return;
    const { draft, ...fields } = payload;
    if (modal.issueId) {
      const existing = state.issues.find((issue) => issue.id === modal.issueId);
      if (!existing) return;
      dispatch({ type: 'issue/update', issue: { ...existing, ...fields, draft } });
    } else {
      dispatch({
        type: 'issue/add',
        issue: {
          ...fields,
          id: createId('issue'),
          projectId: selectedProject.id,
          buildId: selectedBuild.id,
          createdAt: new Date().toISOString(),
          recommendation: '',
          draft,
          occurrenceCount: 1,
          occurrenceTotal: 1,
          disposition: { decision: 'pending', reason: '', nextAction: '' },
        },
      });
    }
    setModal(null);
  };

  const pendingRetestCount = selectedBuild
    ? state.retests.filter((retest) => retest.buildId === selectedBuild.id && retest.outcome === 'pending').length
    : 0;

  const renderOverview = () => {
    if (!selectedProject) {
      return (
        <EmptyState
          icon={<FlaskConical size={28} />}
          title="还没有试玩项目"
          description="从一个可玩版本开始，把真实观察变成下一版动作，再用复测验证。"
          action={<button className="button button-primary" type="button" onClick={() => setModal({ type: 'project' })}><Plus size={18} />新建项目</button>}
        />
      );
    }

    const pendingProjectIssues = projectIssues.filter((issue) => issue.disposition.decision === 'pending').length;
    const pendingProjectRetests = projectRetests.filter((retest) => retest.outcome === 'pending').length;
    let nextTitle = '记录这一轮的真实观察';
    let nextDescription = '反馈要留下任务情境、实际行为与原始证据，不只写“手感不好”。';
    let nextAction = <button className="text-link" type="button" onClick={() => setView('playtests')}>查看试玩任务<ArrowUpRight size={16} /></button>;
    if (!selectedBuild) {
      nextTitle = '先保存一个可玩版本';
      nextDescription = '版本号、可玩链接和修改意图，是后续所有证据的定位点。';
      nextAction = <button className="text-link" type="button" onClick={() => setModal({ type: 'build', next: false })}>添加首个版本<ArrowUpRight size={16} /></button>;
    } else if (!selectedPlaytest) {
      nextTitle = '为当前版本发起一次聚焦试玩';
      nextDescription = '一次只验证一个关键问题，避免把任务清单变成问卷清单。';
      nextAction = <button className="text-link" type="button" onClick={() => setModal({ type: 'playtest' })}>发起试玩<ArrowUpRight size={16} /></button>;
    } else if (pendingProjectIssues > 0) {
      nextTitle = `${pendingProjectIssues} 条问题等待作者处置`;
      nextDescription = '采纳就写清下一版动作；搁置或拒绝也要留下理由。';
      nextAction = <button className="text-link" type="button" onClick={() => setView('playtests')}>去处置问题<ArrowUpRight size={16} /></button>;
    } else if (acceptedIssues.length > 0) {
      nextTitle = '把已采纳问题带进下一版';
      nextDescription = '创建下一版后，系统会自动生成对应的待复测清单。';
      nextAction = <button className="text-link" type="button" onClick={() => setModal({ type: 'build', next: true })}>创建下一版<ArrowUpRight size={16} /></button>;
    } else if (pendingProjectRetests > 0) {
      nextTitle = `${pendingProjectRetests} 项修改等待复测`;
      nextDescription = '回到同一任务与原始证据，记录本轮是否仍然复现。';
      nextAction = <button className="text-link" type="button" onClick={() => setView('retests')}>去复测<ArrowUpRight size={16} /></button>;
    }

    return (
      <>
        <section className="metrics-grid" aria-label="工作区指标">
          {[
            { label: '活跃项目', value: metrics.activeProjects, note: '本地工作区', icon: FolderKanban },
            { label: '进行中的试玩', value: metrics.runningTests, note: '招募与执行中', icon: FlaskConical },
            { label: '待处置问题', value: metrics.pendingIssues, note: '需要作者决定', icon: CircleAlert },
            { label: '完整闭环', value: metrics.completedLoops, note: '下一版且完成复测', icon: CheckCircle2 },
          ].map((metric) => (
            <article className="metric-card" key={metric.label}>
              <div className="metric-label"><metric.icon size={17} />{metric.label}</div>
              <strong>{metric.value}</strong>
              <span>{metric.note}</span>
            </article>
          ))}
        </section>

        <div className="overview-layout">
          <section className="next-step-panel">
            <span className="eyebrow">NEXT VERIFIABLE STEP</span>
            <h2>{nextTitle}</h2>
            <p>{nextDescription}</p>
            {nextAction}
            <div className="principle-line"><Check size={16} />证据先于解释，复测先于“已优化”。</div>
          </section>
          <aside className="brief-panel">
            <div className="panel-heading"><span className="eyebrow">PROJECT BRIEF</span><Target size={20} /></div>
            <dl>
              <div><dt>目标玩家</dt><dd>{selectedProject.targetPlayer}</dd></div>
              <div><dt>目标体验</dt><dd>{selectedProject.intendedExperience}</dd></div>
              <div><dt>当前版本</dt><dd>{selectedBuild?.version ?? '尚未保存'}</dd></div>
            </dl>
          </aside>
        </div>

        <section className="content-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">RETEST LOG</span><h2>最近复测</h2></div>
            {projectRetests.length > 0 && <button className="text-link" type="button" onClick={() => setView('retests')}>查看全部<ChevronRight size={16} /></button>}
          </div>
          {projectRetests.length === 0 ? (
            <div className="inline-empty"><RotateCcw size={20} /><span>完成下一版后，已采纳问题会出现在这里等待复测。</span></div>
          ) : (
            <div className="activity-list">
              {[...projectRetests].reverse().slice(0, 4).map((retest) => {
                const issue = state.issues.find((item) => item.id === retest.issueId);
                const build = state.builds.find((item) => item.id === retest.buildId);
                return (
                  <div className="activity-row" key={retest.id}>
                    <span className={`retest-dot outcome-${retest.outcome}`} />
                    <div><strong>{issue?.title ?? '原问题已不存在'}</strong><span>{build?.version} · {formatDate(retest.testedAt)}</span></div>
                    <StatusChip tone={retest.outcome === 'not-reproduced' ? 'green' : retest.outcome === 'reproduced' ? 'red' : 'orange'}>{outcomeLabels[retest.outcome]}</StatusChip>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </>
    );
  };

  const renderBuilds = () => {
    if (!selectedProject) return null;
    if (projectBuilds.length === 0) {
      return (
        <EmptyState
          icon={<FolderKanban size={28} />}
          title="先保存首个可玩版本"
          description="每条试玩证据都会绑定到具体版本，避免不同构建的反馈混在一起。"
          action={<button className="button button-primary" type="button" onClick={() => setModal({ type: 'build', next: false })}><Plus size={18} />添加首个版本</button>}
        />
      );
    }

    const buildThreads = buildIssues.filter((issue) => !issue.draft);
    const buildDrafts = buildIssues.filter((issue) => issue.draft);
    const visibleThreads = [...buildThreads, ...buildDrafts].filter((issue) => {
      if (threadFilter === 'all') return true;
      if (threadFilter === 'draft') return Boolean(issue.draft);
      if (threadFilter === 'accepted') return !issue.draft && issue.disposition.decision === 'accepted';
      return !issue.draft && issue.disposition.decision === 'pending';
    });

    return (
      <>
      <div className="workspace-columns">
        <aside className="item-list-panel">
          <div className="panel-heading"><span className="eyebrow">版本时间线 · {projectBuilds.length}</span></div>
          <div className="selectable-list">
            {projectBuilds.map((build) => {
              const threadCount = state.issues.filter((issue) => issue.buildId === build.id && !issue.draft).length;
              return (
                <button type="button" key={build.id} className={`selectable-item ${selectedBuild?.id === build.id ? 'selected' : ''}`} onClick={() => selectBuild(build.id)}>
                  <span className="item-index">{build.version}</span>
                  <span><strong>{build.notes}</strong><small>{formatDate(build.createdAt)} · {build.previousBuildId ? '迭代版本' : '首个版本'} · {threadCount} 条证据</small></span>
                  <ChevronRight size={17} />
                </button>
              );
            })}
          </div>
        </aside>
        {selectedBuild && (
          <section className="detail-panel">
            <div className="detail-title-row">
              <div><span className="eyebrow">CURRENT BUILD</span><h2>{selectedBuild.version}</h2></div>
              <StatusChip tone="green">可试玩</StatusChip>
            </div>
            <p className="detail-lead">{selectedBuild.notes}</p>
            <a className="build-link" href={selectedBuild.url} target="_blank" rel="noreferrer">打开可玩版本<ExternalLink size={16} /></a>
            {pendingRetestCount > 0 && (
              <div className="retest-banner"><RotateCcw size={20} /><div><strong>{pendingRetestCount} 项待复测</strong><span>已采纳问题已自动关联到当前版本</span></div><button type="button" className="text-link" onClick={() => setView('retests')}>前往复测</button></div>
            )}
            <dl className="detail-facts">
              <div><dt>保存时间</dt><dd>{formatDate(selectedBuild.createdAt)}</dd></div>
              <div><dt>试玩任务</dt><dd>{buildPlaytests.length} 轮</dd></div>
              <div><dt>记录问题</dt><dd>{buildIssues.length} 条</dd></div>
              <div><dt>已采纳</dt><dd>{acceptedIssues.length} 条</dd></div>
            </dl>
            <div className="detail-actions">
              <button className="button button-primary" type="button" onClick={() => setModal({ type: 'playtest' })}><FlaskConical size={18} />发起试玩</button>
              {acceptedIssues.length > 0 && <button className="button button-secondary" type="button" onClick={() => setModal({ type: 'build', next: true })}><Plus size={18} />创建下一版</button>}
            </div>
          </section>
        )}
      </div>
      <section className="content-panel">
        <div className="panel-heading">
          <div><span className="eyebrow">EVIDENCE THREADS</span><h2>证据帖</h2></div>
          <div className="thread-toolbar">
            <select aria-label="筛选证据帖" value={threadFilter} onChange={(event) => setThreadFilter(event.target.value as typeof threadFilter)}>
              <option value="all">全部</option>
              <option value="pending">待处置</option>
              <option value="accepted">已采纳</option>
              <option value="draft">草稿</option>
            </select>
            <button className="button button-secondary" type="button" onClick={() => setModal({ type: 'thread' })}><Plus size={18} />发一条证据帖</button>
          </div>
        </div>
        <p className="detail-lead">帖子绑定当前版本。没有原始证据只能存为草稿；发布后由作者处置，再纳入下一版复测。</p>
        {visibleThreads.length === 0 ? (
          <div className="inline-empty"><FileText size={20} /><span>{buildIssues.length === 0 ? '这个版本还没有讨论。先记录你观察到的行为。' : '当前筛选下没有帖子。'}</span></div>
        ) : (
          <div className="thread-list">
            {visibleThreads.map((issue) => (
              <article className={`thread-card ${issue.draft ? 'is-draft' : ''}`} key={issue.id}>
                <div className="issue-meta">
                  {issue.draft ? <StatusChip tone="neutral">草稿</StatusChip> : <StatusChip tone={issue.severity === 'blocker' || issue.severity === 'major' ? 'red' : 'neutral'}>{severityLabels[issue.severity]}</StatusChip>}
                  {!issue.draft && <StatusChip tone={issue.disposition.decision === 'accepted' ? 'green' : issue.disposition.decision === 'pending' ? 'orange' : 'neutral'}>{decisionLabels[issue.disposition.decision]}</StatusChip>}
                  <span>{issue.category}</span>
                  <span>{issue.testerName || '匿名'}</span>
                </div>
                <h3>{issue.title}</h3>
                <div className="evidence-grid">
                  <div><span>实际观察</span><p>{issue.observation}</p></div>
                  {issue.evidence && <div><span>原始证据</span><p>{issue.evidence}</p></div>}
                  {issue.interpretation && <div><span>解释假设</span><p>{issue.interpretation}</p></div>}
                </div>
                {issue.draft && (
                  <div className="thread-card-actions">
                    <button type="button" className="button button-secondary" onClick={() => setModal({ type: 'thread', issueId: issue.id })}>补充证据并发布</button>
                  </div>
                )}
                {!issue.draft && issue.disposition.decision === 'pending' && (
                  <div className="thread-card-actions is-decision">
                    <span className="thread-decision-label">作者处置</span>
                    <button type="button" className="decision-button accept" onClick={() => setModal({ type: 'disposition', issueId: issue.id, decision: 'accepted' })}><Check size={16} />采纳</button>
                    <button type="button" className="decision-button" onClick={() => setModal({ type: 'disposition', issueId: issue.id, decision: 'deferred' })}><Clock3 size={16} />搁置</button>
                    <button type="button" className="decision-button" onClick={() => setModal({ type: 'disposition', issueId: issue.id, decision: 'rejected' })}><X size={16} />拒绝</button>
                  </div>
                )}
                {!issue.draft && issue.disposition.decision !== 'pending' && (
                  <div className="thread-decision-result">
                    <strong>{issue.disposition.decision === 'accepted' ? '下一版动作' : '处置理由'}</strong>
                    <p>{issue.disposition.decision === 'accepted' ? issue.disposition.nextAction : issue.disposition.reason}</p>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
      </>
    );
  };

  const renderPlaytests = () => {
    if (!selectedProject || !selectedBuild) {
      return <EmptyState icon={<FlaskConical size={28} />} title="先准备一个可玩版本" description="试玩任务必须绑定到确定版本，才能进行后续复测。" action={<button className="button button-primary" type="button" onClick={() => setView('builds')}>前往项目与版本</button>} />;
    }
    if (buildPlaytests.length === 0) {
      return <EmptyState icon={<FlaskConical size={28} />} title="当前版本还没有试玩" description="设置一个聚焦目标与具体任务，让测试者在无作者提示的情况下体验。" action={<button className="button button-primary" type="button" onClick={() => setModal({ type: 'playtest' })}><Plus size={18} />发起试玩</button>} />;
    }

    const currentIssues = selectedPlaytest ? buildIssues.filter((issue) => issue.playtestId === selectedPlaytest.id) : [];
    return (
      <>
        <div className="workspace-columns playtest-columns">
          <aside className="item-list-panel">
            <div className="panel-heading"><span className="eyebrow">PLAYTESTS · {buildPlaytests.length}</span></div>
            <div className="selectable-list">
              {buildPlaytests.map((playtest) => (
                <button type="button" key={playtest.id} className={`selectable-item ${selectedPlaytest?.id === playtest.id ? 'selected' : ''}`} onClick={() => setSelectedPlaytestId(playtest.id)}>
                  <span className="item-index"><FlaskConical size={17} /></span>
                  <span><strong>{playtest.title}</strong><small>{playtest.status === 'complete' ? '已完成' : '进行中'} · 目标 {playtest.targetCount} 人</small></span>
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
          </aside>
          {selectedPlaytest && (
            <section className="detail-panel">
              <div className="detail-title-row">
                <div><span className="eyebrow">{selectedBuild.version} · PLAYTEST</span><h2>{selectedPlaytest.title}</h2></div>
                <StatusChip tone={selectedPlaytest.status === 'complete' ? 'neutral' : 'green'}>{selectedPlaytest.status === 'complete' ? '已完成' : '进行中'}</StatusChip>
              </div>
              <dl className="test-brief">
                <div><dt>评测目标</dt><dd>{selectedPlaytest.objective}</dd></div>
                <div><dt>试玩任务</dt><dd>{selectedPlaytest.task}</dd></div>
              </dl>
              <div className="detail-actions">
                <button className="button button-primary" type="button" onClick={() => setModal({ type: 'issue' })}><Plus size={18} />记录问题</button>
                {selectedPlaytest.status !== 'complete' && <button className="button button-secondary" type="button" onClick={() => dispatch({ type: 'playtest/status', playtestId: selectedPlaytest.id, status: 'complete' })}><Check size={18} />结束试玩</button>}
              </div>
            </section>
          )}
        </div>
        {selectedPlaytest && (
          <section className="content-panel issues-panel">
            <div className="panel-heading"><div><span className="eyebrow">EVIDENCE & DECISIONS</span><h2>问题与作者处置</h2></div><span className="panel-count">{currentIssues.length} 条记录</span></div>
            {currentIssues.length === 0 ? (
              <div className="inline-empty"><FileText size={20} /><span>还没有问题记录。优先保存原始观察，不急着下结论。</span></div>
            ) : (
              <div className="issue-list">
                {currentIssues.map((issue) => (
                  <article className="issue-card" key={issue.id}>
                    <div className="issue-heading">
                      <div><div className="issue-meta"><StatusChip tone={issue.severity === 'blocker' || issue.severity === 'major' ? 'red' : 'neutral'}>{severityLabels[issue.severity]}</StatusChip><span>{issue.category}</span><span>{issue.testerName}</span></div><h3>{issue.title}</h3></div>
                      <StatusChip tone={issue.disposition.decision === 'accepted' ? 'green' : issue.disposition.decision === 'pending' ? 'orange' : 'neutral'}>{decisionLabels[issue.disposition.decision]}</StatusChip>
                    </div>
                    <div className="evidence-grid">
                      <div><span>实际观察</span><p>{issue.observation}</p></div>
                      <div><span>原始证据</span><p>{issue.evidence}</p></div>
                      {issue.interpretation && <div><span>解释假设</span><p>{issue.interpretation}</p></div>}
                      {issue.recommendation && <div><span>修改建议</span><p>{issue.recommendation}</p></div>}
                    </div>
                    {issue.disposition.decision === 'pending' ? (
                      <div className="issue-actions"><span>作者处置</span><button type="button" className="decision-button accept" onClick={() => setModal({ type: 'disposition', issueId: issue.id, decision: 'accepted' })}><Check size={16} />采纳</button><button type="button" className="decision-button" onClick={() => setModal({ type: 'disposition', issueId: issue.id, decision: 'deferred' })}><Clock3 size={16} />搁置</button><button type="button" className="decision-button" onClick={() => setModal({ type: 'disposition', issueId: issue.id, decision: 'rejected' })}><X size={16} />拒绝</button></div>
                    ) : (
                      <div className="disposition-result"><strong>{issue.disposition.decision === 'accepted' ? '下一版动作' : '处置理由'}</strong><p>{issue.disposition.decision === 'accepted' ? issue.disposition.nextAction : issue.disposition.reason}</p></div>
                    )}
                  </article>
                ))}
              </div>
            )}
            {acceptedIssues.length > 0 && <div className="next-build-bar"><div><ListChecks size={21} /><span><strong>{acceptedIssues.length} 条问题已采纳</strong><small>创建下一版后自动生成复测项</small></span></div><button className="button button-primary" type="button" onClick={() => setModal({ type: 'build', next: true })}>创建下一版<ArrowRight size={17} /></button></div>}
          </section>
        )}
      </>
    );
  };

  const renderRetests = () => {
    if (!selectedProject) return null;
    if (projectRetests.length === 0) {
      return <EmptyState icon={<RotateCcw size={28} />} title="还没有待复测项" description="采纳问题并创建下一版后，原问题与证据会自动带入复测中心。" action={<button className="button button-secondary" type="button" onClick={() => setView('playtests')}>查看试玩问题</button>} />;
    }

    return (
      <div className="retest-list">
        {[...projectRetests].reverse().map((retest) => (
          <RetestCard
            key={retest.id}
            retest={retest}
            state={state}
            onSave={(outcome, note) => dispatch({ type: 'retest/update', retestId: retest.id, outcome, note, testedAt: new Date().toISOString() })}
          />
        ))}
      </div>
    );
  };

  const viewCopy: Record<View, { eyebrow: string; title: string; description: string }> = {
    overview: { eyebrow: 'PLAYTEST WORKBENCH', title: selectedProject?.name ?? '让下一版更好', description: selectedProject?.summary ?? '把真实试玩证据，变成可验证的版本迭代。' },
    builds: { eyebrow: selectedProject?.name ?? 'PROJECT', title: '项目与版本', description: '固定每次试玩对应的构建，让反馈有明确坐标。' },
    playtests: { eyebrow: selectedProject?.name ?? 'PLAYTEST', title: '试玩任务', description: '观察真实行为，保留原始证据，再由作者作出处置。' },
    retests: { eyebrow: selectedProject?.name ?? 'RETEST', title: '复测中心', description: '回到原问题与同一任务，只记录本轮是否复现。' },
  };
  const copy = viewCopy[view];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" type="button" onClick={() => setView('overview')} aria-label="复玩首页">
          <span className="brand-mark"><RotateCcw size={22} strokeWidth={2.4} /></span>
          <span><strong>复玩</strong><small>REPLAY</small></span>
        </button>
        <div className="workspace-label">工作区</div>
        <nav className="main-nav" role="tablist" aria-label="工作区视图">
          {navigation.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={view === item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}>
              <item.icon size={19} /><span>{item.label}</span>{item.id === 'retests' && projectRetests.filter((retest) => retest.outcome === 'pending').length > 0 && <span className="nav-badge" aria-hidden="true">{projectRetests.filter((retest) => retest.outcome === 'pending').length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-projects">
          <div className="workspace-label">项目</div>
          {state.projects.length === 0 ? <p>从第一个可玩原型开始。</p> : state.projects.map((project) => (
            <button type="button" key={project.id} className={selectedProject?.id === project.id ? 'selected' : ''} onClick={() => selectProject(project.id)}><span className="project-monogram" aria-hidden="true">{project.name.slice(0, 1)}</span><span>{project.name}</span></button>
          ))}
        </div>
        <div className="sidebar-footer"><HardDrive size={16} /><span>本地工作区<small>数据保存在此浏览器</small></span></div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="local-status"><span />本地已保存</div>
          {state.projects.length > 0 && <button className="button button-quiet" type="button" onClick={() => setModal({ type: 'project' })}><Plus size={17} />新建项目</button>}
        </header>
        <div className="page-content">
          <header className="page-heading">
            <div><span className="eyebrow">{copy.eyebrow}</span><h1>{copy.title}</h1><p>{copy.description}</p></div>
            {view === 'overview' && selectedProject && <div className="iteration-statement"><span>当前焦点</span><strong>{selectedBuild ? `${selectedBuild.version} · ${selectedBuild.notes}` : '建立首个版本'}</strong></div>}
          </header>
          {view === 'overview' && renderOverview()}
          {view === 'builds' && renderBuilds()}
          {view === 'playtests' && renderPlaytests()}
          {view === 'retests' && renderRetests()}
          <footer className="method-note"><span>方法边界</span>形成性试玩用于发现问题与支持版本决策；小样本结果不代表总体玩家比例。</footer>
        </div>
      </main>

      {modal?.type === 'project' && <Modal eyebrow="NEW PROJECT" title="创建一个试玩项目" onClose={() => setModal(null)}><ProjectForm onSave={saveProject} /></Modal>}
      {modal?.type === 'build' && <Modal eyebrow={modal.next ? 'NEXT BUILD' : 'NEW BUILD'} title={modal.next ? '创建下一版' : '保存可玩版本'} onClose={() => setModal(null)}><BuildForm next={modal.next} acceptedIssues={acceptedIssues} onSave={saveBuild} /></Modal>}
      {modal?.type === 'playtest' && <Modal eyebrow={`${selectedBuild?.version ?? ''} · NEW PLAYTEST`} title="发起一次聚焦试玩" onClose={() => setModal(null)}><PlaytestForm onSave={savePlaytest} /></Modal>}
      {modal?.type === 'issue' && <Modal eyebrow={`${selectedPlaytest?.title ?? ''} · NEW ISSUE`} title="记录一条可追溯的问题" onClose={() => setModal(null)}><IssueForm onSave={saveIssue} /></Modal>}
      {modal?.type === 'thread' && <Modal eyebrow={`${selectedBuild?.version ?? ''} · EVIDENCE THREAD`} title={modal.issueId ? '补充证据并发布' : '发一条证据帖'} onClose={() => setModal(null)}><ThreadForm initial={modal.issueId ? state.issues.find((issue) => issue.id === modal.issueId) : undefined} onSave={saveThread} /></Modal>}
      {modal?.type === 'disposition' && dispositionIssue && <Modal eyebrow="AUTHOR DISPOSITION" title="决定这条问题去向" onClose={() => setModal(null)}><DispositionForm issue={dispositionIssue} initialDecision={modal.decision} onSave={(decision, reason, nextAction) => { dispatch({ type: 'issue/disposition', issueId: dispositionIssue.id, disposition: { decision, reason, nextAction } }); setModal(null); }} /></Modal>}
    </div>
  );
}

function RetestCard({
  retest,
  state,
  onSave,
}: {
  retest: Retest;
  state: AppState;
  onSave: (outcome: Exclude<RetestOutcome, 'pending'>, note: string) => void;
}) {
  const [error, setError] = useState('');
  const issue = state.issues.find((item) => item.id === retest.issueId);
  const build = state.builds.find((item) => item.id === retest.buildId);
  const previousBuild = build?.previousBuildId ? state.builds.find((item) => item.id === build.previousBuildId) : undefined;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const outcome = formValue(data, 'outcome') as RetestOutcome;
    if (outcome === 'pending') {
      setError('请选择本轮复测结论');
      return;
    }
    onSave(outcome, formValue(data, 'note'));
  };

  return (
    <form className="retest-card" onSubmit={handleSubmit}>
      <div className="retest-card-heading">
        <div><span className="eyebrow">{previousBuild?.version ?? '上一版'} → {build?.version}</span><h2>{issue?.title ?? '原问题已不存在'}</h2></div>
        <StatusChip tone={retest.outcome === 'not-reproduced' ? 'green' : retest.outcome === 'reproduced' ? 'red' : 'orange'}>{outcomeLabels[retest.outcome]}</StatusChip>
      </div>
      {issue && <div className="original-evidence"><span>原问题证据</span><p>{issue.evidence}</p><small>原观察：{issue.observation}</small></div>}
      {issue?.disposition.nextAction && <div className="next-action"><Check size={17} /><span><strong>本版动作</strong>{issue.disposition.nextAction}</span></div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="retest-form-row">
        <div className="field">
          <label htmlFor={`outcome-${retest.id}`}>复测结论</label>
          <select id={`outcome-${retest.id}`} name="outcome" defaultValue={retest.outcome}>
            <option value="pending">请选择</option>
            <option value="not-reproduced">本轮未复现</option>
            <option value="reproduced">仍然复现</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`note-${retest.id}`}>复测记录</label>
          <textarea id={`note-${retest.id}`} name="note" rows={2} defaultValue={retest.note} placeholder="记录同一任务下的行为与新证据，不写总体比例结论" />
        </div>
      </div>
      <div className="retest-footer"><span>结论仅对本轮观察负责</span><button className="button button-primary" type="submit">保存复测结果<ArrowRight size={17} /></button></div>
    </form>
  );
}

export default App;
