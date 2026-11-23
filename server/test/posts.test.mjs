import test from 'node:test';
import assert from 'node:assert/strict';
import { start, client, registerAuthor, createProjectWithCode, addTester } from './helpers.mjs';

const fullPost = {
  title: '第二关跳跃后卡进墙里',
  category: '功能缺陷',
  severity: 'blocker',
  observation: '角色在第二关边缘起跳后贴住墙体，无法继续移动',
  evidence: '录屏 00:31-00:38',
  interpretation: '疑似碰撞体与落脚点重叠',
};

async function projectWithTester(base) {
  const { author, projectId, code } = await createProjectWithCode(base);
  const { tester, actor } = await addTester(base, code);
  return { author, tester, projectId, testerActor: actor };
}

test('项目成员可以发布证据帖，作者取自会话而不是请求体', async () => {
  const app = await start();
  try {
    const { tester, projectId, testerActor } = await projectWithTester(app.base);
    const response = await tester.post(`/api/projects/${projectId}/posts`, {
      ...fullPost,
      // 前端伪造的作者字段必须被忽略。
      author: { actorId: 'forged-actor', displayName: '伪造作者', role: 'creator' },
      authorActorId: 'forged-actor',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.post.author.actorId, testerActor.actorId);
    assert.equal(response.body.post.author.role, 'tester');
    assert.match(response.body.post.author.displayName, /^试玩者 #\d+$/);
    assert.equal(response.body.post.draft, false);
    assert.deepEqual(response.body.post.disposition, { decision: 'pending', reason: '', nextAction: '' });
  } finally {
    await app.close();
  }
});

test('草稿无需原始证据，发布缺少证据返回 422', async () => {
  const app = await start();
  try {
    const { tester, projectId } = await projectWithTester(app.base);
    const draft = await tester.post(`/api/projects/${projectId}/posts`, {
      title: '转角抓地力偏弱',
      observation: '连续转向时角色有轻微滑移',
      draft: true,
    });
    assert.equal(draft.status, 201);
    assert.equal(draft.body.post.draft, true);
    assert.equal(draft.body.post.evidence, '');

    const publish = await tester.post(`/api/projects/${projectId}/posts`, {
      title: '转角抓地力偏弱',
      observation: '连续转向时角色有轻微滑移',
    });
    assert.equal(publish.status, 422);
    assert.equal(publish.body.error, 'EVIDENCE_REQUIRED');
  } finally {
    await app.close();
  }
});

test('非项目成员不能读取或发布帖子', async () => {
  const app = await start();
  try {
    const { projectId } = await projectWithTester(app.base);
    const outsider = await registerAuthor(app.base, 'outsider@example.com');

    const list = await outsider.c.get(`/api/projects/${projectId}/posts`);
    assert.equal(list.status, 403);
    assert.equal(list.body.error, 'NOT_A_MEMBER');

    const create = await outsider.c.post(`/api/projects/${projectId}/posts`, fullPost);
    assert.equal(create.status, 403);
    assert.equal(create.body.error, 'NOT_A_MEMBER');
  } finally {
    await app.close();
  }
});

test('只有项目作者可以处置，且采纳必须写下一版动作、搁置必须写理由', async () => {
  const app = await start();
  try {
    const { author, tester, projectId } = await projectWithTester(app.base);
    const created = await tester.post(`/api/projects/${projectId}/posts`, fullPost);
    assert.equal(created.status, 201);
    const postId = created.body.post.postId;

    const denied = await tester.patch(`/api/posts/${postId}/disposition`, { decision: 'accepted', nextAction: '修碰撞体' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'NOT_CREATOR');

    const missingAction = await author.patch(`/api/posts/${postId}/disposition`, { decision: 'accepted' });
    assert.equal(missingAction.status, 422);
    assert.equal(missingAction.body.error, 'NEXT_ACTION_REQUIRED');

    const missingReason = await author.patch(`/api/posts/${postId}/disposition`, { decision: 'deferred' });
    assert.equal(missingReason.status, 422);
    assert.equal(missingReason.body.error, 'REASON_REQUIRED');

    const accepted = await author.patch(`/api/posts/${postId}/disposition`, {
      decision: 'accepted',
      nextAction: '收窄墙体碰撞体并在下一版复测第二关边缘起跳',
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.post.disposition.decision, 'accepted');
    assert.match(accepted.body.post.disposition.nextAction, /收窄墙体碰撞体/);
  } finally {
    await app.close();
  }
});

test('草稿不能直接处置', async () => {
  const app = await start();
  try {
    const { author, tester, projectId } = await projectWithTester(app.base);
    const draft = await tester.post(`/api/projects/${projectId}/posts`, {
      title: '待补充证据',
      observation: '暂时只有主观感受',
      draft: true,
    });
    const response = await author.patch(`/api/posts/${draft.body.post.postId}/disposition`, {
      decision: 'rejected',
      reason: '证据不足',
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error, 'POST_IS_DRAFT');
  } finally {
    await app.close();
  }
});

test('回复需要项目成员，作者取自会话', async () => {
  const app = await start();
  try {
    const { tester, projectId, testerActor } = await projectWithTester(app.base);
    const created = await tester.post(`/api/projects/${projectId}/posts`, fullPost);
    const postId = created.body.post.postId;

    const reply = await tester.post(`/api/posts/${postId}/replies`, {
      body: '我这边也在同一位置复现了',
      author: { displayName: '伪造作者', role: 'creator' },
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.reply.author.actorId, testerActor.actorId);
    assert.equal(reply.body.reply.author.role, 'tester');

    const outsider = await registerAuthor(app.base, 'reply-outsider@example.com');
    const denied = await outsider.c.post(`/api/posts/${postId}/replies`, { body: '路过' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'NOT_A_MEMBER');

    const empty = await tester.post(`/api/posts/${postId}/replies`, { body: '   ' });
    assert.equal(empty.status, 422);
    assert.equal(empty.body.error, 'INVALID_REPLY');

    const list = await tester.get(`/api/projects/${projectId}/posts`);
    assert.equal(list.status, 200);
    assert.equal(list.body.posts[0].replies.length, 1);
    assert.equal(list.body.posts[0].replies[0].body, '我这边也在同一位置复现了');
  } finally {
    await app.close();
  }
});

test('未登录不能读写帖子', async () => {
  const app = await start();
  try {
    const { projectId } = await projectWithTester(app.base);
    const anonymous = client(app.base);
    assert.equal((await anonymous.get(`/api/projects/${projectId}/posts`)).status, 401);
    assert.equal((await anonymous.post(`/api/projects/${projectId}/posts`, fullPost)).status, 401);
  } finally {
    await app.close();
  }
});
