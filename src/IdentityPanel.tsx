import { useEffect, useState } from 'react';
import {
  createProject,
  fetchSession,
  identityEnabled,
  issueCode,
  loginWithToken,
  logout,
  redeemCode,
  requestMagicLink,
  type IdentityActor,
  type IdentityMembership,
} from './lib/identity';

export function IdentityPanel() {
  if (!identityEnabled) return null;
  return <IdentityPanelInner />;
}

function IdentityPanelInner() {
  const [actor, setActor] = useState<IdentityActor | null>(null);
  const [memberships, setMemberships] = useState<IdentityMembership[]>([]);
  const [email, setEmail] = useState('');
  const [projectName, setProjectName] = useState('');
  const [code, setCode] = useState('');
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchSession()
      .then((session) => {
        if (!session) return;
        setActor(session.actor);
        setMemberships(session.memberships);
      })
      .catch(() => setError('无法连接身份服务'));
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="identity-panel">
      <div className="workspace-label">身份</div>
      {actor ? (
        <>
          <div className="identity-actor">
            <strong>{actor.displayName}</strong>
            <span>{actor.status === 'unclaimed' ? '匿名试玩者' : '已认证账号'}</span>
          </div>
          {memberships.length > 0 && (
            <ul className="identity-list">
              {memberships.map((membership) => (
                <li key={membership.projectId}>
                  <span>{membership.name}</span>
                  <small>{membership.role === 'creator' ? '作者' : membership.role === 'tester' ? '试玩者' : '旁观者'}</small>
                  {membership.role === 'creator' && (
                    <button
                      type="button"
                      className="identity-link"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const result = await issueCode(membership.projectId);
                          setNotice(`试玩码 ${result.code}（只显示这一次）`);
                        })
                      }
                    >
                      生成试玩码
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="identity-link"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await logout();
                setActor(null);
                setMemberships([]);
                setNotice(null);
              })
            }
          >
            退出登录
          </button>
          <form
            className="identity-form"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                const created = await createProject(projectName);
                const session = await fetchSession();
                if (session) setMemberships(session.memberships);
                setProjectName('');
                setNotice(`已创建「${created.name}」，你现在是作者`);
              });
            }}
          >
            <label htmlFor="identity-project">新建项目</label>
            <div className="identity-inline">
              <input
                id="identity-project"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="项目名称"
              />
              <button type="submit" className="identity-link" disabled={busy || !projectName.trim()}>
                创建
              </button>
            </div>
          </form>
        </>
      ) : (
        <>
          <form
            className="identity-form"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                const link = await requestMagicLink(email);
                setPendingToken(link.token);
                setNotice('登录链接已生成，点击下方按钮完成登录。');
              });
            }}
          >
            <label htmlFor="identity-email">邮箱</label>
            <div className="identity-inline">
              <input
                id="identity-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
              <button type="submit" className="identity-link" disabled={busy || !email}>
                获取登录链接
              </button>
            </div>
          </form>
          {pendingToken && (
            <button
              type="button"
              className="identity-link"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const session = await loginWithToken(pendingToken);
                  setActor(session.actor);
                  setMemberships(session.memberships);
                  setPendingToken(null);
                  setNotice(null);
                })
              }
            >
              用生成的令牌登录
            </button>
          )}
        </>
      )}

      <form
        className="identity-form"
        onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            const result = await redeemCode(code);
            const session = await fetchSession();
            if (session) {
              setActor(session.actor);
              setMemberships(session.memberships);
            }
            setCode('');
            setNotice(`已加入「${result.project.name}」${result.anonymous ? '，当前为匿名试玩者' : ''}`);
          });
        }}
      >
        <label htmlFor="identity-code">试玩码</label>
        <div className="identity-inline">
          <input
            id="identity-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="8 位试玩码"
          />
          <button type="submit" className="identity-link" disabled={busy || code.trim().length < 4}>
            兑换
          </button>
        </div>
      </form>

      {notice && <p className="identity-note">{notice}</p>}
      {error && <p className="identity-error" role="alert">{error}</p>}
    </div>
  );
}
