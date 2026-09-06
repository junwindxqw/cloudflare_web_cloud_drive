// 邮件发送：通过 Resend HTTP API 发送登录验证码
// 服务端发起的出站请求仅允许 http/https，且 host 不得为 localhost / 环回 / 私有 / 保留地址

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DEFAULT_FROM = 'JunDrive <noreply@junwind.site>';

// 校验目标 URL：协议限定 http/https，host 拒绝本机、私有与保留网段（含点分 IPv4 字面量）
function assertSafeHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('出站 URL 非法');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('出站请求仅允许 http/https');

  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) throw new Error('不允许 IPv6 字面量地址'); // 本项目仅访问固定域名，无需 IPv6
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('禁止请求本机地址');
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const octets = host.split('.').map(Number);
    if (octets.some((n) => n > 255)) throw new Error('非法 IP 地址');
    const [a, b] = octets;
    const blocked =
      a === 0 || a === 10 || a === 127 || // 环回 / 私有
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // 链路本地
      (a === 172 && b >= 16 && b <= 31) || // 私有
      (a === 192 && b === 168) || // 私有
      (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) || // 192.0.0.0/24、TEST-NET-1
      (a === 198 && (b === 18 || b === 19)) || // 基准测试网段
      (a === 198 && b === 51 && octets[2] === 100) || // TEST-NET-2
      (a === 203 && b === 0 && octets[2] === 113) || // TEST-NET-3
      a >= 224; // 组播 / 保留
    if (blocked) throw new Error('禁止请求私有或保留地址');
  }
  return url;
}

const PURPOSE_LABELS = {
  login: '登录',
  register: '注册账号',
  reset: '重置密码',
};

export async function sendCodeMail(env, email, code, purpose = 'login') {
  const label = PURPOSE_LABELS[purpose] || '验证';
  // 本地开发：设置 DEV_MAIL_LOG 后不真正发信，验证码直接随响应返回（仅限开发环境配置）
  if (env.DEV_MAIL_LOG) {
    console.log(`[DEV_MAIL_LOG] ${label}验证码 ${email}: ${code}`);
    return { devCode: code };
  }
  if (!env.RESEND_API_KEY) throw new HttpError(500, '服务端未配置 RESEND_API_KEY 密钥，无法发送验证码邮件');

  const from = env.MAIL_FROM || DEFAULT_FROM;
  const body = {
    from,
    to: [email],
    subject: `JunDrive ${label}验证码 ${code}`,
    text: `你正在进行「${label}」操作，验证码是 ${code}，10 分钟内有效。若非本人操作，请忽略本邮件。`,
    html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:'Segoe UI',Arial,'PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:460px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.08);">
    <div style="font-size:20px;font-weight:700;color:#2563eb;margin-bottom:16px;">JunDrive 云盘</div>
    <p style="margin:0 0 8px;color:#0f172a;font-size:15px;">你好，</p>
    <p style="margin:0 0 20px;color:#475569;font-size:14px;">你正在进行<b>「${label}」</b>操作，验证码如下，<b>10 分钟内有效</b>。请勿泄露给他人：</p>
    <div style="text-align:center;background:#eff6ff;border:1px dashed #93c5fd;border-radius:10px;padding:16px;margin-bottom:20px;">
      <span style="font-size:32px;font-weight:700;letter-spacing:10px;color:#1d4ed8;font-family:Consolas,monospace;">${code}</span>
    </div>
    <p style="margin:0;color:#94a3b8;font-size:12px;">若非本人操作，请忽略此邮件，你的账号不会受影响。</p>
  </div>
</body></html>`,
  };

  const res = await fetch(assertSafeHttpUrl('https://api.resend.com/emails'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`Resend 发送失败 (${res.status}): ${detail.slice(0, 500)}`);
    throw new HttpError(502, '验证码邮件发送失败，请稍后再试');
  }
  return {};
}
