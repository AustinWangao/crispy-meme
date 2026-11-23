import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Clock3, FileText, Plus, X } from 'lucide-react';
import {
  createPost,
  createPostReply,
  fetchSession,
  identityEnabled,
  listProjectPosts,
  setPostDisposition,
  type PostCategory,
  type PostDecision,
  type PostSeverity,
  type ServerPost,
  type SessionPayload,
} from './lib/identity';

const categories: PostCategory[] = ['功能缺陷', '目标与规则', '操作与反馈', '难度与节奏', '玩家体验', '玩法偏好'];

const severityLabels: Record<PostSeverity, string> = {
  blocker: '阻断',
  major: '严重',
  minor: '一般',
  preference: '偏好',
};

const decisionLabels: Record<PostDecision, string> = {
  pending: '待处置',
  accepted: '已采纳',
  deferred: '已搁置',
  rejected: '已拒绝',
};

const roleLabels = {
  creator: '作者',
  tester: '试玩者',
  observer: '旁观者',
} as const;

type Filter = 'all' | 'pending' | 'accepted' | 'draft';
type DecisionInput = Exclude<PostDecision, 'pending'>;

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(value));
}

function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'orange' | 'red' }) {
  return <span className={`status-chip status-${tone}`}>{children}</span>;
}

export function ServerPosts() {
  if (!identityEnabled) return null;
  return <ServerPostsInner />;
}

function ServerPostsInner() {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [projectId, setProjectId] = useState('');
  const [posts, setPosts] = useState<ServerPost[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [composing, setComposing] = useState(false);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [replyTarget, setReplyTarget] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [decisionState, setDecisionState] = useState<{ postId: string; decision: DecisionInput } | null>(null);
  const [reason, setReason] = useState('');
  const [nextAction, setNextAction] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  const membership = session?.memberships.find((item) => item.projectId === projectId);
  const isCreator = membership?.role === 'creator';

  const loadSession = useCallback(async () => {
    const payload = await fetchSession();
    setSession(payload);
    if (!payload || payload.memberships.length === 0) {
      setPosts([]);
      setProjectId('');
      return payload;
    }
    setProjectId((current) =>
      payload.memberships.some((item) => item.projectId === current) ? current : payload.memberships[0].projectId,
    );
    return payload;
  }, []);

  useEffect(() => {
    const sync = () => {
      void loadSession().catch(() => setError('无法连接身份服务'));
    };
    sync();
    window.addEventListener('replay-identity-changed', sync);
    return () => window.removeEventListener('replay-identity-changed', sync);
  }, [loadSession]);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError('');
    try {
      const data = await listProjectPosts(id);
      setPosts(data.posts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载服务端证据帖失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!projectId) return;
    void load(projectId);
  }, [projectId, load]);

  async function savePost(draft: boolean) {
    const form = formRef.current;
    if (!form || !projectId) return;
    const data = new FormData(form);
    const input = {
      title: String(data.get('title') ?? '').trim(),
      category: String(data.get('category') ?? '目标与规则') as PostCategory,
      severity: String(data.get('severity') ?? 'major') as PostSeverity,
      observation: String(data.get('observation') ?? '').trim(),
      evidence: String(data.get('evidence') ?? '').trim(),
      interpretation: String(data.get('interpretation') ?? '').trim(),
      buildId: String(data.get('buildId') ?? '').trim() || undefined,
      draft,
    };

    const nextErrors: string[] = [];
    if (!input.title) nextErrors.push('请填写问题标题');
    if (!input.observation) nextErrors.push('请填写实际观察');
    if (!draft && !input.evidence) nextErrors.push('发布需要原始证据，或先存为草稿');
    if (nextErrors.length) {
      setFormErrors(nextErrors);
      return;
    }

    setBusy(true);
    setError('');
    setFormErrors([]);
    try {
      await createPost(projectId, input);
      form.reset();
      setComposing(false);
      setNotice(draft ? '草稿已保存到服务端' : '证据帖已发布到服务端');
      await load(projectId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发布失败');
    } finally {
      setBusy(false);
    }
  }

  async function submitReply(postId: string) {
    const body = replyBody.trim();
    if (!body || !projectId) return;
    setBusy(true);
    setError('');
    try {
      await createPostReply(postId, body);
      setReplyTarget('');
      setReplyBody('');
      await load(projectId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '回复失败');
    } finally {
      setBusy(false);
    }
  }

  function openDecision(postId: string, decision: DecisionInput) {
    setDecisionState({ postId, decision });
    setReason('');
    setNextAction('');
    setError('');
  }

  async function submitDecision(event: FormEvent) {
    event.preventDefault();
    if (!decisionState || !projectId) return;
    const nextErrors: string[] = [];
    if (decisionState.decision === 'accepted' && !nextAction.trim()) nextErrors.push('采纳时必须填写下一版动作');
    if (decisionState.decision !== 'accepted' && !reason.trim()) nextErrors.push('搁置或拒绝时必须填写理由');
    if (nextErrors.length) {
      setError(nextErrors.join('；'));
      return;
    }

    setBusy(true);
    setError('');
    try {
      await setPostDisposition(decisionState.postId, {
        decision: decisionState.decision,
        reason: reason.trim(),
        nextAction: nextAction.trim(),
      });
      setDecisionState(null);
      setNotice('处置已保存到服务端');
      await load(projectId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '处置失败');
    } finally {
      setBusy(false);
    }
  }

  const visiblePosts = posts.filter((post) => {
    if (filter === 'all') return true;
    if (filter === 'draft') return post.draft;
    if (filter === 'accepted') return !post.draft && post.disposition.decision === 'accepted';
    return !post.draft && post.disposition.decision === 'pending';
  });

  return (
    <section className="content-panel server-posts">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">SERVER EVIDENCE</span>
          <h2>服务端证据帖</h2>
        </div>
        {session && session.memberships.length > 0 && (
          <div className="thread-toolbar">
            <select aria-label="选择服务端项目" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {session.memberships.map((item) => (
                <option key={item.projectId} value={item.projectId}>
                  {item.name}
                </option>
              ))}
            </select>
            <select aria-label="筛选服务端证据帖" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
              <option value="all">全部</option>
              <option value="pending">待处置</option>
              <option value="accepted">已采纳</option>
              <option value="draft">草稿</option>
            </select>
            <button className="button button-secondary" type="button" onClick={() => setComposing((value) => !value)}>
              <Plus size={18} />
              {composing ? '收起编辑器' : '发一条证据帖'}
            </button>
          </div>
        )}
      </div>
      <p className="detail-lead">存于服务端，与本机草稿分开；作者身份由登录会话决定，前端无法伪造。</p>

      {!session && (
        <div className="inline-empty">
          <FileText size={20} />
          <span>登录后在这里查看和发布服务端证据帖。</span>
        </div>
      )}

      {session && session.memberships.length === 0 && (
        <div className="inline-empty">
          <FileText size={20} />
          <span>当前账号还没有加入项目。先创建项目或兑换试玩码。</span>
        </div>
      )}

      {composing && projectId && (
        <form
          ref={formRef}
          className="form-grid server-post-form"
          onSubmit={(event) => {
            event.preventDefault();
            void savePost(false);
          }}
        >
          {formErrors.length > 0 && (
            <div className="form-error field-full" role="alert">
              {formErrors.join('；')}
            </div>
          )}
          <div className="field field-full">
            <label htmlFor="sp-title">问题标题</label>
            <input id="sp-title" name="title" placeholder="描述可观察的问题，不写抽象评价" />
          </div>
          <div className="field">
            <label htmlFor="sp-category">问题类型</label>
            <select id="sp-category" name="category" defaultValue="目标与规则">
              {categories.map((category) => (
                <option key={category}>{category}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sp-severity">影响程度</label>
            <select id="sp-severity" name="severity" defaultValue="major">
              {(Object.keys(severityLabels) as PostSeverity[]).map((severity) => (
                <option key={severity} value={severity}>
                  {severityLabels[severity]}
                </option>
              ))}
            </select>
          </div>
          <div className="field field-full">
            <label htmlFor="sp-observation">实际观察</label>
            <textarea id="sp-observation" name="observation" rows={3} placeholder="玩家做了什么？发生在什么任务与情境？" />
          </div>
          <div className="field field-full">
            <label htmlFor="sp-evidence">原始证据</label>
            <textarea id="sp-evidence" name="evidence" rows={3} placeholder="录屏时间点、玩家原话、截图或链接；没有证据只能存为草稿" />
          </div>
          <div className="field field-full">
            <label htmlFor="sp-interpretation">解释假设</label>
            <textarea id="sp-interpretation" name="interpretation" rows={2} placeholder="可能原因，保留不确定性" />
          </div>
          <div className="field field-full">
            <label htmlFor="sp-build">版本标识（可选）</label>
            <input id="sp-build" name="buildId" placeholder="例如：0.2.0" />
          </div>
          <div className="form-actions field-full">
            <span>{isCreator ? '发布后你可以直接处置' : '发布后由项目作者处置'}</span>
            <div className="form-action-buttons">
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => void savePost(true)}>
                存为草稿
              </button>
              <button className="button button-primary" type="submit" disabled={busy}>
                发布证据帖
              </button>
            </div>
          </div>
        </form>
      )}

      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {notice && <p className="identity-note">{notice}</p>}

      {loading ? (
        <div className="inline-empty">
          <FileText size={20} />
          <span>正在加载服务端证据帖…</span>
        </div>
      ) : visiblePosts.length === 0 ? (
        <div className="inline-empty">
          <FileText size={20} />
          <span>{posts.length === 0 ? '这个项目还没有服务端证据帖。' : '当前筛选下没有帖子。'}</span>
        </div>
      ) : (
        <div className="thread-list">
          {visiblePosts.map((post) => (
            <article className={`thread-card ${post.draft ? 'is-draft' : ''}`} key={post.postId}>
              <div className="issue-meta">
                {post.draft ? (
                  <Chip>草稿</Chip>
                ) : (
                  <Chip tone={post.severity === 'blocker' || post.severity === 'major' ? 'red' : 'neutral'}>
                    {severityLabels[post.severity]}
                  </Chip>
                )}
                {!post.draft && (
                  <Chip
                    tone={
                      post.disposition.decision === 'accepted'
                        ? 'green'
                        : post.disposition.decision === 'pending'
                          ? 'orange'
                          : 'neutral'
                    }
                  >
                    {decisionLabels[post.disposition.decision]}
                  </Chip>
                )}
                <span>{post.category}</span>
                <span>
                  {roleLabels[post.author.role]} · {post.author.displayName}
                </span>
              </div>
              <h3>{post.title}</h3>
              <div className="evidence-grid">
                <div>
                  <span>实际观察</span>
                  <p>{post.observation}</p>
                </div>
                {post.evidence && (
                  <div>
                    <span>原始证据</span>
                    <p>{post.evidence}</p>
                  </div>
                )}
                {post.interpretation && (
                  <div>
                    <span>解释假设</span>
                    <p>{post.interpretation}</p>
                  </div>
                )}
              </div>

              {isCreator && !post.draft && post.disposition.decision === 'pending' && decisionState?.postId !== post.postId && (
                <div className="thread-card-actions is-decision">
                  <span className="thread-decision-label">作者处置</span>
                  <button className="decision-button accept" type="button" disabled={busy} onClick={() => openDecision(post.postId, 'accepted')}>
                    <Check size={16} />
                    采纳
                  </button>
                  <button className="decision-button" type="button" disabled={busy} onClick={() => openDecision(post.postId, 'deferred')}>
                    <Clock3 size={16} />
                    搁置
                  </button>
                  <button className="decision-button" type="button" disabled={busy} onClick={() => openDecision(post.postId, 'rejected')}>
                    <X size={16} />
                    拒绝
                  </button>
                </div>
              )}

              {decisionState?.postId === post.postId && (
                <form className="form-grid server-decision-form" onSubmit={submitDecision}>
                  <div className="field field-full">
                    <label htmlFor={`sp-decision-${post.postId}`}>
                      {decisionState.decision === 'accepted' ? '下一版动作（必填）' : '处置理由（必填）'}
                    </label>
                    {decisionState.decision === 'accepted' ? (
                      <textarea
                        id={`sp-decision-${post.postId}`}
                        rows={2}
                        value={nextAction}
                        onChange={(event) => setNextAction(event.target.value)}
                        placeholder="下一版具体改什么，如何复测？"
                      />
                    ) : (
                      <textarea
                        id={`sp-decision-${post.postId}`}
                        rows={2}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder="说明搁置或拒绝的理由"
                      />
                    )}
                  </div>
                  <div className="form-action-buttons">
                    <button className="button button-primary" type="submit" disabled={busy}>
                      确认处置
                    </button>
                    <button className="button button-secondary" type="button" onClick={() => setDecisionState(null)}>
                      取消
                    </button>
                  </div>
                </form>
              )}

              {!post.draft && post.disposition.decision !== 'pending' && (
                <div className="thread-decision-result">
                  <strong>{post.disposition.decision === 'accepted' ? '下一版动作' : '处置理由'}</strong>
                  <p>{post.disposition.decision === 'accepted' ? post.disposition.nextAction : post.disposition.reason}</p>
                </div>
              )}

              {!post.draft && (
                <div className="thread-replies">
                  <div className="thread-replies-head">
                    <span>{post.replies.length > 0 ? `${post.replies.length} 条回复` : '还没有回复'}</span>
                    {replyTarget !== post.postId && (
                      <button
                        className="decision-button"
                        type="button"
                        onClick={() => {
                          setReplyTarget(post.postId);
                          setReplyBody('');
                        }}
                      >
                        回复
                      </button>
                    )}
                  </div>
                  {post.replies.map((reply) => (
                    <div className="reply-item" key={reply.replyId}>
                      <div className="reply-item-head">
                        <strong>{reply.author.displayName}</strong>
                        <span>
                          {roleLabels[reply.author.role]} · {formatDate(reply.createdAt)}
                        </span>
                      </div>
                      <p>{reply.body}</p>
                    </div>
                  ))}
                  {replyTarget === post.postId && (
                    <form
                      className="reply-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitReply(post.postId);
                      }}
                    >
                      <textarea
                        aria-label="服务端回复内容"
                        rows={3}
                        placeholder="补充证据、提出反问，或说明下一步。"
                        value={replyBody}
                        onChange={(event) => setReplyBody(event.target.value)}
                      />
                      <div className="reply-form-actions">
                        <button className="button button-primary" type="submit" disabled={busy || !replyBody.trim()}>
                          发送回复
                        </button>
                        <button
                          className="button button-secondary"
                          type="button"
                          onClick={() => {
                            setReplyTarget('');
                            setReplyBody('');
                          }}
                        >
                          取消
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
