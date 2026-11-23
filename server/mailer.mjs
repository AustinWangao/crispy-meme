import nodemailer from 'nodemailer';

export function renderLoginEmail({ loginUrl, expiresAt }) {
  const minutes = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000));
  const text = [
    '有人请求登录复玩 Replay。',
    '',
    `在 ${minutes} 分钟内打开下面的链接完成登录：`,
    loginUrl,
    '',
    '如果不是你本人操作，可以忽略这封邮件。',
  ].join('\n');

  const html = `<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:32px;background:#f6f2e9;font-family:-apple-system,'PingFang SC',sans-serif;color:#1f2421">
  <div style="max-width:520px;margin:0 auto;background:#fffdf7;border:1px solid #e4ddcc;border-radius:14px;padding:28px">
    <p style="margin:0 0 12px;font-size:14px;letter-spacing:.08em;color:#5c6b5f">复玩 REPLAY</p>
    <h1 style="margin:0 0 16px;font-size:20px">登录你的工作台</h1>
    <p style="margin:0 0 20px;line-height:1.6;font-size:14px;color:#3d453f">此链接 ${minutes} 分钟内有效，且只能使用一次。</p>
    <a href="${loginUrl}" style="display:inline-block;padding:10px 18px;background:#2f6b4f;color:#fff;border-radius:999px;text-decoration:none;font-size:14px">打开登录链接</a>
    <p style="margin:20px 0 0;line-height:1.6;font-size:12px;color:#7a847d">如果不是你本人操作，可以忽略这封邮件。<br>${loginUrl}</p>
  </div>
</body></html>`;

  return { text, html };
}

/**
 * 发信通道。生产环境缺少 SMTP_URL 时直接抛错，不允许退回“把令牌返回给浏览器”。
 */
export function createMailer(env = process.env, { transportFactory } = {}) {
  const appOrigin = (env.APP_ORIGIN ?? '').replace(/\/$/, '');
  const smtpUrl = env.SMTP_URL;

  if (!smtpUrl) {
    if (env.NODE_ENV === 'production') {
      throw new Error('SMTP_URL 未配置：生产环境必须接入真实发信，不能使用开发模式');
    }
    return {
      mode: 'dev',
      appOrigin: appOrigin || 'http://localhost:5173',
      async send() {
        return { mode: 'dev' };
      },
    };
  }

  if (!env.MAIL_FROM) throw new Error('SMTP 模式需要 MAIL_FROM');
  if (!appOrigin) throw new Error('SMTP 模式需要 APP_ORIGIN（用于生成登录链接）');

  const transport = (transportFactory ?? nodemailer.createTransport)(smtpUrl);

  return {
    mode: 'smtp',
    appOrigin,
    async send({ to, loginUrl, expiresAt }) {
      const { text, html } = renderLoginEmail({ loginUrl, expiresAt });
      await transport.sendMail({ from: env.MAIL_FROM, to, subject: '登录复玩 Replay', text, html });
    },
  };
}
