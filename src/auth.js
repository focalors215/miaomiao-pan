// 多用户账号 + HMAC 签名的会话 Cookie
// - 账号保存在 config.json 的 users 字段（密码用 scrypt 加盐哈希），角色 admin / user
// - 环境变量 ADMIN_USER / ADMIN_PASSWORD 只在没有任何管理员时用来创建第一个管理员；
//   忘记密码时设置 ADMIN_RESET=true 重启，会用环境变量重置第一个管理员
// - 注册由管理员在“系统设置”里开关，可设邀请码（config.settings.registration）
// - 会话内容是 “用户 id|过期时间|version”，改用户名/密码、停用账号都会让 version 变化，旧会话全部失效
import crypto from 'node:crypto';
import { getConfig, save } from './store.js';
import { HttpError } from './vfs.js';
import { avatarUrl } from './assets.js';

const COOKIE = 'pan_session';
const MAX_AGE = 7 * 24 * 3600;
const USERNAME_RE = /^[^\s|/\\]{1,32}$/; // 会话里用 | 分隔字段；用户名还会用作私人空间的文件夹名
const MIN_PASSWORD = 8;

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verifyPassword(password, user) {
  return safeEqual(hashPassword(password, user.salt).hash, user.hash);
}

export const users = () => getConfig().users;
export const findUser = (id) => users().find((u) => u.id === id);
const findByName = (name) => users().find((u) => u.username.toLowerCase() === String(name).trim().toLowerCase());

export function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt, avatar: avatarUrl(u) };
}

function validateUsername(name, selfId) {
  name = String(name ?? '').trim();
  if (!USERNAME_RE.test(name) || name === '.' || name === '..' || name.startsWith('.')) {
    throw new HttpError(400, '用户名为 1～32 个字符，不能包含空格、| 和斜杠，也不能以 . 开头');
  }
  const other = findByName(name);
  if (other && other.id !== selfId) throw new HttpError(409, '这个用户名已经被使用了');
  return name;
}

function validatePassword(pw) {
  pw = String(pw ?? '');
  if (pw.length < MIN_PASSWORD) throw new HttpError(400, `密码至少 ${MIN_PASSWORD} 位`);
  if (pw.length > 128) throw new HttpError(400, '密码不能超过 128 位');
  return pw;
}

// ---------- 初始化：迁移旧的单管理员配置、创建第一个管理员 ----------

(function init() {
  const cfg = getConfig();
  cfg.users ||= [];
  cfg.settings ||= {};
  cfg.settings.registration ||= { open: false, inviteCode: '' };
  let changed = false;
  if (cfg.admin && !cfg.users.length) {
    // 旧版只有一个 admin 字段：原样迁移（密码、version 不变，已登录的设备仍然有效）
    const { username, salt, hash, version } = cfg.admin;
    cfg.users.push({ id: crypto.randomUUID(), username, role: 'admin', salt, hash, version, createdAt: Date.now() });
    delete cfg.admin;
    changed = true;
    console.log(`[auth] 已把旧的管理员账号 ${username} 迁移到多用户配置`);
  }
  const reset = process.env.ADMIN_RESET === 'true';
  const password = process.env.ADMIN_PASSWORD || '';
  const username = process.env.ADMIN_USER || 'admin';
  const firstAdmin = cfg.users.find((u) => u.role === 'admin');
  if (!firstAdmin) {
    if (password) {
      cfg.users.push({ id: crypto.randomUUID(), username, role: 'admin', ...hashPassword(password), version: 1, createdAt: Date.now() });
      changed = true;
      console.log(`[auth] 已创建管理员账号：${username}`);
    } else console.warn('[auth] 还没有管理员账号，请设置 ADMIN_PASSWORD 后重启');
  } else if (reset && password) {
    const clash = findByName(username);
    if (clash && clash.id !== firstAdmin.id) clash.username += `-${clash.id.slice(0, 4)}`; // 让出用户名
    Object.assign(firstAdmin, { username, ...hashPassword(password), version: firstAdmin.version + 1, disabled: false });
    changed = true;
    console.log(`[auth] 已按环境变量重置管理员账号：${username}（请去掉 ADMIN_RESET 再重启）`);
  }
  if (changed) save();
})();

// ---------- 失败限流：同一 IP 15 分钟内连续失败 10 次，锁定 15 分钟 ----------

const failures = new Map(); // key -> { count, until }
const WINDOW = 15 * 60_000;

/** 先检查是否被锁定（锁定时直接抛 429），返回 fail()/ok() 用来记录结果 */
export function throttle(key) {
  const f = failures.get(key);
  if (f && f.until > Date.now() && f.count >= 10) {
    throw new HttpError(429, `尝试次数过多，请 ${Math.ceil((f.until - Date.now()) / 60_000)} 分钟后再试`);
  }
  return {
    fail() {
      const g = failures.get(key);
      if (!g || g.until < Date.now()) failures.set(key, { count: 1, until: Date.now() + WINDOW });
      else g.count++;
    },
    ok: () => failures.delete(key),
  };
}

// ---------- 会话 ----------

export function sign(payload) {
  return crypto.createHmac('sha256', getConfig().secret).update(payload).digest('base64url');
}

export function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// remember=false：不设 Max-Age，浏览器关闭后 Cookie 即失效（签名里仍带 7 天上限）
function setSession(req, res, user, remember = true) {
  const payload = `${user.id}|${Math.floor(Date.now() / 1000) + MAX_AGE}|${user.version}`;
  const token = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
  const secure = req.secure ? '; Secure' : '';
  const maxAge = remember ? `; Max-Age=${MAX_AGE}` : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${maxAge}${secure}`);
}

/** 当前登录的用户对象（未登录、会话失效或账号停用返回 null） */
export function currentUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  const payload = Buffer.from(b64, 'base64url').toString();
  if (!safeEqual(sign(payload), sig)) return null;
  const [id, exp, version] = payload.split('|');
  const user = findUser(id);
  if (!user || user.disabled || Number(exp) < Date.now() / 1000 || Number(version) !== user.version) return null;
  return user;
}

export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '只有管理员可以进行这个操作' });
  next();
}

export const sessionInfo = (u) => ({ user: u.username, role: u.role, id: u.id, avatar: avatarUrl(u) });

// ---------- 接口 ----------

export function me(req, res) {
  const u = currentUser(req);
  res.json(u ? sessionInfo(u) : { user: null, role: null, id: null, avatar: null });
}

export function login(req, res) {
  const t = throttle(`login:${req.ip}`);
  const { username, password, remember } = req.body || {};
  const user = findByName(username || '');
  if (!user || !verifyPassword(password || '', user)) {
    t.fail();
    throw new HttpError(401, '用户名或密码错误');
  }
  if (user.disabled) throw new HttpError(403, '这个账号已被管理员停用');
  t.ok();
  setSession(req, res, user, remember !== false);
  res.json(sessionInfo(user));
}

export function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}

/** 登录页用：注册是否开放、是否需要邀请码 */
export function registerInfo(req, res) {
  const r = getConfig().settings.registration;
  res.json({ open: !!r.open, needInvite: !!r.inviteCode });
}

/** 注册：管理员开放注册后才能用；设置了邀请码时必须填对。返回新用户，由调用方创建私人空间 */
export function register(req, res) {
  const r = getConfig().settings.registration;
  if (!r.open) throw new HttpError(403, '管理员暂未开放注册');
  const t = throttle(`register:${req.ip}`);
  const { username, password, inviteCode, remember } = req.body || {};
  if (r.inviteCode && !safeEqual(String(inviteCode || '').trim(), r.inviteCode)) {
    t.fail();
    throw new HttpError(403, '邀请码不正确');
  }
  const name = validateUsername(username);
  const pw = validatePassword(password);
  const user = { id: crypto.randomUUID(), username: name, role: 'user', ...hashPassword(pw), version: 1, createdAt: Date.now() };
  users().push(user);
  save();
  t.ok();
  setSession(req, res, user, remember !== false);
  return user;
}

/**
 * 修改自己的用户名和/或密码：需要当前密码；成功后其他设备的登录全部失效，当前设备自动续上新会话。
 * 返回 { info, renamed }，renamed 为 { from, to } 时调用方要把私人空间文件夹跟着改名。
 */
export function updateAccount(req, res) {
  const { currentPassword, username, newPassword } = req.body || {};
  const user = req.user;
  const t = throttle(`account:${req.ip}`);
  if (!verifyPassword(currentPassword || '', user)) {
    t.fail();
    throw new HttpError(403, '当前密码错误');
  }
  const nextName = username === undefined ? user.username : validateUsername(username, user.id);
  const changePassword = newPassword !== undefined && newPassword !== '';
  if (changePassword) validatePassword(newPassword);
  if (nextName === user.username && !changePassword) throw new HttpError(400, '没有需要修改的内容');
  const renamed = nextName !== user.username ? { from: user.username, to: nextName } : null;
  Object.assign(user, { username: nextName, ...(changePassword ? hashPassword(newPassword) : {}), version: user.version + 1 });
  save();
  setSession(req, res, user);
  return { info: sessionInfo(user), renamed };
}

// ---------- 管理员：用户管理 ----------

export function listUsers() {
  return users().map(publicUser);
}

export function adminUpdateUser(actor, id, { disabled, role, password }) {
  const u = findUser(id);
  if (!u) throw new HttpError(404, '用户不存在');
  if (u.id === actor.id && (disabled === true || role === 'user')) throw new HttpError(400, '不能停用自己或取消自己的管理员身份');
  const activeAdmins = users().filter((x) => x.role === 'admin' && !x.disabled);
  const losingAdmin = (role === 'user' || disabled === true) && u.role === 'admin' && !u.disabled;
  if (losingAdmin && activeAdmins.length <= 1) throw new HttpError(400, '至少要保留一个可用的管理员');
  if (role !== undefined) {
    if (!['admin', 'user'].includes(role)) throw new HttpError(400, '角色不正确');
    u.role = role;
  }
  if (disabled !== undefined) u.disabled = !!disabled;
  if (password !== undefined && password !== '') Object.assign(u, hashPassword(validatePassword(password)));
  u.version++; // 让这个用户已登录的设备全部失效
  save();
  return publicUser(u);
}

export function adminDeleteUser(actor, id) {
  const u = findUser(id);
  if (!u) throw new HttpError(404, '用户不存在');
  if (u.id === actor.id) throw new HttpError(400, '不能删除自己');
  if (u.role === 'admin' && users().filter((x) => x.role === 'admin').length <= 1) throw new HttpError(400, '至少要保留一个管理员');
  getConfig().users = users().filter((x) => x.id !== id);
  save();
  return u;
}
