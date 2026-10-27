// 单管理员账号 + HMAC 签名的会话 Cookie
// 账号保存在 config.json 的 admin 字段（密码用 scrypt 加盐哈希），可以在网页里修改。
// 环境变量 ADMIN_USER / ADMIN_PASSWORD 只在第一次启动时用来初始化账号；
// 忘记密码时设置 ADMIN_RESET=true 重启，会用环境变量里的账号密码覆盖。
import crypto from 'node:crypto';
import { getConfig, save } from './store.js';

const COOKIE = 'pan_session';
const MAX_AGE = 7 * 24 * 3600;
const USERNAME_RE = /^[^\s|]{1,32}$/; // 会话里用 | 分隔字段，所以用户名不能包含 |
const MIN_PASSWORD = 8;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verifyPassword(password, admin) {
  return safeEqual(hashPassword(password, admin.salt).hash, admin.hash);
}

// ---------- 初始化账号 ----------

(function initAdmin() {
  const cfg = getConfig();
  const reset = process.env.ADMIN_RESET === 'true';
  if (cfg.admin && !reset) return;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || '';
  if (!password) {
    console.warn('[auth] 还没有管理员账号，请设置 ADMIN_PASSWORD 后重启');
    return;
  }
  // version 变化会让所有旧会话失效
  cfg.admin = { username, ...hashPassword(password), version: (cfg.admin?.version || 0) + 1 };
  save();
  console.log(reset ? `[auth] 已按环境变量重置管理员账号：${username}（请去掉 ADMIN_RESET 再重启）` : `[auth] 已创建管理员账号：${username}`);
})();

// ---------- 登录失败限流：同一 IP 15 分钟内连续失败 10 次，锁定 15 分钟 ----------

const failures = new Map(); // ip -> { count, until }
const WINDOW = 15 * 60_000;

function checkThrottle(ip) {
  const f = failures.get(ip);
  if (f && f.until > Date.now() && f.count >= 10) return Math.ceil((f.until - Date.now()) / 60_000);
  return 0;
}

function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + WINDOW });
  else f.count++;
}

// ---------- 会话 ----------

function sign(payload) {
  return crypto.createHmac('sha256', getConfig().secret).update(payload).digest('base64url');
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// remember=false：不设 Max-Age，浏览器关闭后 Cookie 即失效（服务端签名里仍带 7 天上限）
function setSession(req, res, admin, remember = true) {
  const payload = `${admin.username}|${Math.floor(Date.now() / 1000) + MAX_AGE}|${admin.version}`;
  const token = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
  const secure = req.secure ? '; Secure' : '';
  const maxAge = remember ? `; Max-Age=${MAX_AGE}` : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${maxAge}${secure}`);
}

export function currentUser(req) {
  const admin = getConfig().admin;
  const token = readCookie(req, COOKIE);
  if (!admin || !token) return null;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  const payload = Buffer.from(b64, 'base64url').toString();
  if (!safeEqual(sign(payload), sig)) return null;
  const [user, exp, version] = payload.split('|');
  // 改过用户名或密码后 version 会变，旧会话全部失效
  if (Number(exp) < Date.now() / 1000 || user !== admin.username || Number(version) !== admin.version) return null;
  return user;
}

export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  req.user = user;
  next();
}

// ---------- 接口 ----------

export function login(req, res) {
  const ip = req.ip;
  const locked = checkThrottle(ip);
  if (locked) return res.status(429).json({ error: `登录失败次数过多，请 ${locked} 分钟后再试` });
  const { username, password, remember } = req.body || {};
  const admin = getConfig().admin;
  if (!admin || !safeEqual(username, admin.username) || !verifyPassword(password || '', admin)) {
    recordFailure(ip);
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  failures.delete(ip);
  setSession(req, res, admin, remember !== false);
  res.json({ user: admin.username });
}

export function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}

/** 修改用户名和/或密码：需要当前密码；成功后其他设备的登录全部失效，当前设备自动续上新会话 */
export function updateAccount(req, res) {
  const { currentPassword, username, newPassword } = req.body || {};
  const cfg = getConfig();
  const admin = cfg.admin;
  const ip = req.ip;
  const locked = checkThrottle(ip);
  if (locked) return res.status(429).json({ error: `密码错误次数过多，请 ${locked} 分钟后再试` });
  if (!verifyPassword(currentPassword || '', admin)) {
    recordFailure(ip);
    return res.status(403).json({ error: '当前密码错误' });
  }
  const nextName = username === undefined ? admin.username : String(username).trim();
  if (!USERNAME_RE.test(nextName)) return res.status(400).json({ error: '用户名为 1～32 个字符，不能包含空格和 |' });
  if (newPassword !== undefined && newPassword !== '') {
    if (String(newPassword).length < MIN_PASSWORD) return res.status(400).json({ error: `新密码至少 ${MIN_PASSWORD} 位` });
    if (String(newPassword).length > 128) return res.status(400).json({ error: '新密码不能超过 128 位' });
  }
  const changePassword = newPassword !== undefined && newPassword !== '';
  if (nextName === admin.username && !changePassword) return res.status(400).json({ error: '没有需要修改的内容' });

  cfg.admin = {
    username: nextName,
    ...(changePassword ? hashPassword(newPassword) : { salt: admin.salt, hash: admin.hash }),
    version: admin.version + 1,
  };
  save();
  setSession(req, res, cfg.admin);
  res.json({ user: nextName });
}
