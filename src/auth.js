// 认证与签名工具：无状态 HMAC 会话 Cookie、分享口令校验、登录限流

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(data) {
  return crypto.subtle.digest('SHA-256', enc.encode(data));
}

async function sha256Hex(str) {
  return hex(await sha256(str));
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// URL 安全的随机 token（分享链接用）
function randomToken(bytes = 16) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export { sha256Hex, randomToken };

// 会话签名密钥：优先 SESSION_SECRET，回退旧密钥 ADMIN_PASSWORD（保证已登录会话不失效）
async function hmacKey(env) {
  const material = env.SESSION_SECRET || env.ADMIN_PASSWORD || '';
  if (!material) throw new Error('未设置 SESSION_SECRET 密钥');
  const digest = await sha256(material);
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function hmacSign(env, message) {
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return b64urlEncode(sig);
}

export async function hmacVerify(env, message, sigB64) {
  const expected = await hmacSign(env, message);
  return timingSafeEqualStr(sigB64, expected);
}

// 与长度无关的常量时间比较
export function timingSafeEqualStr(a, b) {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

// ---------- 会话 ----------

const SESSION_TTL = 7 * 24 * 3600 * 1000;

// payload 中带 email / epoch；epoch 与 users 表不一致时会话失效（改密即全端下线）
export async function createSessionToken(env, data = {}) {
  const payload = b64urlEncode(enc.encode(JSON.stringify({ exp: Date.now() + SESSION_TTL, ...data })));
  return `${payload}.${await hmacSign(env, payload)}`;
}

export async function verifySession(request, env) {
  const token = parseCookies(request.headers.get('Cookie') || '')['session'];
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!(await hmacVerify(env, payload, token.slice(dot + 1)))) return null;
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (!data.exp || data.exp < Date.now()) return null;
  } catch {
    return null;
  }
  // 带邮箱的会话需与 users 表的当前 epoch 一致（重置/修改密码后旧会话全部作废）
  if (data.email && env.DB) {
    const row = await env.DB.prepare('SELECT session_epoch FROM users WHERE email = ?').bind(data.email).first();
    if (!row || (row.session_epoch || 1) !== (data.epoch || 1)) return null;
  }
  return data;
}

export function sessionCookie(token) {
  return `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`;
}

export function clearSessionCookie() {
  return 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

export function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// ---------- 分享访问凭证（口令保护分享通过后种下的 Cookie） ----------

const SHARE_TTL = 7 * 24 * 3600 * 1000;

export function shareCookieName(token) {
  return `sh_${token}`;
}

export async function createShareAccessToken(env, token, expiresAt) {
  const exp = Math.min(Date.now() + SHARE_TTL, expiresAt || Infinity);
  const payload = b64urlEncode(enc.encode(JSON.stringify({ s: token, exp: exp === Infinity ? 0 : exp })));
  return `${payload}.${await hmacSign(env, payload)}`;
}

export async function verifyShareAccess(request, env, token) {
  const value = parseCookies(request.headers.get('Cookie') || '')[shareCookieName(token)];
  if (!value) return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const payload = value.slice(0, dot);
  if (!(await hmacVerify(env, payload, value.slice(dot + 1)))) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    return data.s === token && (!data.exp || data.exp >= Date.now());
  } catch {
    return false;
  }
}

export function shareCookie(token, value, expiresAt) {
  const maxAge = Math.max(60, Math.min(SHARE_TTL / 1000, expiresAt ? Math.floor((expiresAt - Date.now()) / 1000) : SHARE_TTL / 1000));
  return `${shareCookieName(token)}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// ---------- 分享口令哈希 ----------

export async function hashSharePassword(password) {
  const salt = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  return `${salt}$${hex(await sha256(`${salt}:${password}`))}`;
}

export async function verifySharePassword(stored, password) {
  const i = stored.indexOf('$');
  if (i <= 0) return false;
  const expected = hex(await sha256(`${stored.slice(0, i)}:${password}`));
  return timingSafeEqualStr(expected, stored.slice(i + 1));
}

// ---------- 用户密码哈希（PBKDF2） ----------
// 迭代次数受 Workers 免费版 10ms CPU 限制约束：25k 次 PBKDF2-SHA256 约 3-6ms CPU，
// 叠加登录限流（每邮箱 15 分钟 10 次）足以抵御在线爆破。
const PBKDF2_ITERATIONS = 25000;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64urlEncode(salt)}$${b64urlEncode(new Uint8Array(bits))}`;
}

export async function verifyPassword(stored, password) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000000) return false;
  try {
    const bits = await pbkdf2(password, b64urlDecode(parts[2]), iterations);
    return timingSafeEqualStr(b64urlEncode(new Uint8Array(bits)), parts[3]);
  } catch {
    return false;
  }
}

// ---------- 登录限流（基于 D1，按 IP 计数） ----------

export async function checkRateLimit(env, ip, windowMs = 15 * 60 * 1000, max = 10) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM login_failures WHERE ip = ? AND ts > ?')
    .bind(ip, Date.now() - windowMs)
    .first();
  return (row?.c || 0) < max;
}

export async function recordFailure(env, ip) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO login_failures (ip, ts) VALUES (?, ?)').bind(ip, Date.now()),
    env.DB.prepare('DELETE FROM login_failures WHERE ts < ?').bind(Date.now() - 24 * 3600 * 1000),
  ]);
}

export async function clearFailures(env, ip) {
  await env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip);
}
