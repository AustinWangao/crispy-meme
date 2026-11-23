import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from './App';
import { emptyState } from './lib/domain';

const storageKey = 'replay-state-v1';

async function submitForm(buttonName: RegExp) {
  await userEvent.click(screen.getByRole('button', { name: buttonName }));
}

describe('复玩工作台', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(storageKey, JSON.stringify(emptyState));
  });

  it('空工作区提供明确的创建入口', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: '让下一版更好' })).toBeInTheDocument();
    expect(screen.getByText('还没有试玩项目')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
  });

  it('完成项目、试玩、问题处置、下一版和复测闭环并持久化', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);

    await user.click(screen.getByRole('button', { name: '新建项目' }));
    await user.type(screen.getByLabelText('项目名称'), '星轨修理铺');
    await user.type(screen.getByLabelText('类型'), '解谜');
    await user.type(screen.getByLabelText('项目简介'), '修复星轨的短流程解谜原型');
    await user.type(screen.getByLabelText('目标玩家'), '喜欢轻量解谜的新玩家');
    await user.type(screen.getByLabelText('目标体验'), '发现规则后产生掌握感');
    await submitForm(/^创建项目$/);

    expect(screen.getByRole('heading', { name: '星轨修理铺' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '添加首个版本' }));
    await user.type(screen.getByLabelText('版本号'), '0.1.0');
    await user.type(screen.getByLabelText('可玩链接'), 'https://example.com/game-v1');
    await user.type(screen.getByLabelText('本版修改'), '首个可玩版本');
    await submitForm(/^保存版本$/);

    await user.click(screen.getByRole('button', { name: '发起试玩' }));
    await user.type(screen.getByLabelText('试玩标题'), '首次体验测试');
    await user.type(screen.getByLabelText('评测目标'), '验证玩家是否理解核心规则');
    await user.type(screen.getByLabelText('试玩任务'), '独立完成第一关');
    await user.clear(screen.getByLabelText('目标人数'));
    await user.type(screen.getByLabelText('目标人数'), '5');
    await submitForm(/^创建试玩$/);

    expect(screen.getByRole('heading', { name: '首次体验测试' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '记录问题' }));
    await user.type(screen.getByLabelText('问题标题'), '没有发现可交互节点');
    await user.type(screen.getByLabelText('实际观察'), '玩家连续点击背景，没有点击节点');
    await user.type(screen.getByLabelText('原始证据'), '录屏 00:42；玩家说不知道哪里能点');
    await user.type(screen.getByLabelText('解释假设'), '节点与背景层级可能过近');
    await user.type(screen.getByLabelText('修改建议'), '增强节点反馈');
    await user.type(screen.getByLabelText('测试者'), '测试者 A');
    await submitForm(/^保存问题$/);

    expect(screen.getByText('没有发现可交互节点')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '采纳' }));
    await user.type(screen.getByLabelText('下一版动作'), '增强节点 hover 与首次进入反馈');
    await submitForm(/^确认处置$/);

    await user.click(screen.getByRole('button', { name: '创建下一版' }));
    await user.type(screen.getByLabelText('版本号'), '0.2.0');
    await user.type(screen.getByLabelText('可玩链接'), 'https://example.com/game-v2');
    await user.type(screen.getByLabelText('本版修改'), '调整节点反馈');
    await submitForm(/^保存版本$/);

    expect(screen.getByText('1 项待复测')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '复测中心' }));
    await user.selectOptions(screen.getByLabelText('复测结论'), 'not-reproduced');
    await user.type(screen.getByLabelText('复测记录'), '同一任务中已能发现节点');
    await user.click(screen.getByRole('button', { name: '保存复测结果' }));

    await user.click(screen.getByRole('tab', { name: '总览' }));
    const loopMetric = screen.getByText('完整闭环').closest('.metric-card');
    expect(loopMetric).not.toBeNull();
    expect(within(loopMetric as HTMLElement).getByText('1')).toBeInTheDocument();

    await waitFor(() => {
      const saved = window.localStorage.getItem(storageKey);
      expect(saved).not.toBeNull();
      expect(JSON.parse(saved as string).retests[0].outcome).toBe('not-reproduced');
    });

    unmount();
    render(<App />);
    expect(screen.getByRole('heading', { name: '星轨修理铺' })).toBeInTheDocument();
    expect(screen.getByText('本轮未复现')).toBeInTheDocument();
  });

  it('在版本页直接发布证据帖，无证据时先存为草稿', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: '新建项目' }));
    await user.type(screen.getByLabelText('项目名称'), '星轨修理铺');
    await user.type(screen.getByLabelText('类型'), '解谜');
    await user.type(screen.getByLabelText('项目简介'), '修复星轨的短流程解谜原型');
    await user.type(screen.getByLabelText('目标玩家'), '喜欢轻量解谜的新玩家');
    await user.type(screen.getByLabelText('目标体验'), '发现规则后产生掌握感');
    await submitForm(/^创建项目$/);

    await user.click(screen.getByRole('button', { name: '添加首个版本' }));
    await user.type(screen.getByLabelText('版本号'), '0.1.0');
    await user.type(screen.getByLabelText('可玩链接'), 'https://example.com/game-v1');
    await user.type(screen.getByLabelText('本版修改'), '首个可玩版本');
    await submitForm(/^保存版本$/);

    await user.click(screen.getByRole('button', { name: '发一条证据帖' }));
    await user.type(screen.getByLabelText('问题标题'), '第二个场景缺少引导');
    await user.type(screen.getByLabelText('实际观察'), '两名测试者在第二个场景停留超过一分钟');
    await user.click(screen.getByRole('button', { name: '存为草稿' }));

    expect(screen.getByText('草稿', { selector: '.status-chip' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '补充证据并发布' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '补充证据并发布' }));
    expect(screen.getByLabelText('问题标题')).toHaveValue('第二个场景缺少引导');
    await user.type(screen.getByLabelText('原始证据'), '录屏 02:10–03:05；两人均无操作');
    await user.click(screen.getByRole('button', { name: '发布证据帖' }));

    expect(screen.queryByText('草稿', { selector: '.status-chip' })).not.toBeInTheDocument();
    expect(screen.getByText('录屏 02:10–03:05；两人均无操作')).toBeInTheDocument();
  });

  it('证据帖可以处置，并按状态筛选', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: '新建项目' }));
    await user.type(screen.getByLabelText('项目名称'), '星轨修理铺');
    await user.type(screen.getByLabelText('类型'), '解谜');
    await user.type(screen.getByLabelText('项目简介'), '修复星轨的短流程解谜原型');
    await user.type(screen.getByLabelText('目标玩家'), '喜欢轻量解谜的新玩家');
    await user.type(screen.getByLabelText('目标体验'), '发现规则后产生掌握感');
    await submitForm(/^创建项目$/);

    await user.click(screen.getByRole('button', { name: '添加首个版本' }));
    await user.type(screen.getByLabelText('版本号'), '0.1.0');
    await user.type(screen.getByLabelText('可玩链接'), 'https://example.com/game-v1');
    await user.type(screen.getByLabelText('本版修改'), '首个可玩版本');
    await submitForm(/^保存版本$/);

    await user.click(screen.getByRole('button', { name: '发一条证据帖' }));
    await user.type(screen.getByLabelText('问题标题'), '第三关缺少提示');
    await user.type(screen.getByLabelText('实际观察'), '两名玩家在第三关原地打转');
    await user.type(screen.getByLabelText('原始证据'), '录屏 05:00；玩家原话“然后呢”');
    await user.click(screen.getByRole('button', { name: '发布证据帖' }));

    expect(screen.getByText('待处置', { selector: '.status-chip' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '采纳' }));
    await user.type(screen.getByLabelText('下一版动作'), '在第三关加入一次性提示');
    await submitForm(/^确认处置$/);

    expect(screen.getByText('已采纳', { selector: '.status-chip' })).toBeInTheDocument();
    expect(screen.getByText('在第三关加入一次性提示')).toBeInTheDocument();

    const filter = screen.getByLabelText('筛选证据帖');
    await user.selectOptions(filter, 'pending');
    expect(screen.queryByText('第三关缺少提示')).not.toBeInTheDocument();

    await user.selectOptions(filter, 'accepted');
    expect(screen.getByText('第三关缺少提示')).toBeInTheDocument();
  });
});
