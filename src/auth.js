// 单管理员账号 + HMAC 签名的会话 Cookie
import crypto from 'node:crypto';
import { getConfig } from './store.js';

const USER = process.env.ADMIN_USER || 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const COOKIE = 'pan_session';
const MAX_AGE = 7 * 24 * 3600;

if (!PASSWORD) {
  console.warn('[auth] 未设置 ADMIN_PASSWORD，登录将被拒绝');
}

function sign(payload) {
  return crypto.createHmac('sha256', getConfig().secret).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function login(req, res) {
  const { username, password } = req.body || {};
  if (!PASSWORD || !safeEqual(username, USER) || !safeEqual(password, PASSWORD)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const payload = `${USER}|${Math.floor(Date.now() / 1000) + MAX_AGE}`;
  const token = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`);
  res.json({ user: USER });
}

export function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}

export function currentUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  const payload = Buffer.from(b64, 'base64url').toString();
  if (!safeEqual(sign(payload), sig)) return null;
  const [user, exp] = payload.split('|');
  if (Number(exp) < Date.now() / 1000) return null;
  return user;
}

export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  req.user = user;
  next();
}
