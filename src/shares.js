// 分享链接和直链，记录放在 data/shares.json
// - 分享链接 /s/<id>：打开是分享页，可分享文件或文件夹，可设提取码，分享页能在线预览
// - 直链 /d/<id>/<文件名>：直接返回文件本身（可用于下载器、<img>/<video> 外链），只能用于单个文件，不支持提取码
// - 两种都可设有效期（1/7/30 天或永久），统计访问和下载次数
// 记录里存的是“存储 id + 存储内部路径”，和分享者看到的虚拟路径无关
import path from 'node:path';
import crypto from 'node:crypto';
import * as vfs from './vfs.js';
import { HttpError } from './vfs.js';
import { collection } from './db.js';
import { sign, safeEqual, readCookie, throttle } from './auth.js';

const db = collection('shares');
const DAYS = [0, 1, 7, 30]; // 0 = 永久
const ALPHA = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789'; // 提取码去掉容易看错的 0/o、1/l/i

function randomId(len, alpha = ALPHA) {
  const bytes = crypto.randomBytes(len);
  return [...bytes].map((b) => alpha[b % alpha.length]).join('');
}

const expired = (e) => e.expiresAt && e.expiresAt < Date.now();

export function urlOf(e) {
  return e.type === 'direct' ? `/d/${e.id}/${encodeURIComponent(e.name)}` : `/s/${e.id}`;
}

function view(e) {
  return {
    id: e.id,
    type: e.type,
    name: e.name,
    isDir: e.isDir,
    size: e.size,
    code: e.code || '',
    expiresAt: e.expiresAt,
    createdAt: e.createdAt,
    views: e.views,
    downloads: e.downloads,
    expired: !!expired(e),
    url: urlOf(e),
    from: e.fromVirtual,
  };
}

/** 创建分享。r 是 scope.resolve() 的结果 */
export async function create(user, r, { type = 'share', code = '', days = 7 } = {}) {
  if (!['share', 'direct'].includes(type)) throw new HttpError(400, '分享类型不正确');
  days = Number(days);
  if (!DAYS.includes(days)) throw new HttpError(400, '有效期只能是 1、7、30 天或永久');
  const name = path.posix.basename(r.inner);
  const item = (await r.driver.list(path.posix.dirname(r.inner))).find((i) => i.name === name);
  if (!item) throw new HttpError(404, '文件或文件夹不存在');
  if (type === 'direct' && item.isDir) throw new HttpError(400, '直链只能用于单个文件，文件夹请用分享链接');
  code = type === 'direct' ? '' : String(code ?? '').trim();
  if (code === 'auto') code = randomId(4, CODE_ALPHA);
  if (code && !/^[A-Za-z0-9]{4,8}$/.test(code)) throw new HttpError(400, '提取码为 4～8 位字母或数字');
  let id;
  do id = randomId(type === 'direct' ? 16 : 8);
  while (db.get(id));
  const e = db.add({
    id,
    type,
    owner: user.id,
    storageId: r.storage.id,
    inner: r.inner,
    name,
    isDir: item.isDir,
    size: item.size || 0,
    fromVirtual: r.virtual,
    code,
    expiresAt: days ? Date.now() + days * 86400_000 : null,
    createdAt: Date.now(),
    views: 0,
    downloads: 0,
  });
  return view(e);
}

export function list(user) {
  return db
    .filter((e) => e.owner === user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(view);
}

export function remove(user, id) {
  const e = db.get(id);
  if (!e || (e.owner !== user.id && user.role !== 'admin')) throw new HttpError(404, '分享不存在');
  db.remove(id);
}

export function removeOwner(userId) {
  for (const e of db.filter((x) => x.owner === userId)) db.remove(e.id);
}

// ---------- 公开访问 ----------

/** 取有效的分享；不存在、已过期、类型不对都报错 */
export function active(id, type) {
  const e = db.get(String(id));
  if (!e || (type && e.type !== type)) throw new HttpError(404, '分享不存在或已被取消');
  if (expired(e)) throw new HttpError(410, '这个分享已经过期了');
  return e;
}

const unlockCookie = (e) => `pan_s_${e.id}`;
const unlockToken = (e) => sign(`share|${e.id}|${e.code}`);

export function unlocked(req, e) {
  if (!e.code) return true;
  const v = readCookie(req, unlockCookie(e));
  return !!v && safeEqual(v, unlockToken(e));
}

export function requireUnlocked(req, e) {
  if (!unlocked(req, e)) throw new HttpError(401, '请输入提取码');
}

/** 校验提取码，正确时下发 Cookie（同一 IP 对同一分享输错 10 次锁 15 分钟） */
export function unlock(req, res, e, code) {
  const t = throttle(`share:${req.ip}:${e.id}`);
  if (!e.code || !safeEqual(String(code || '').trim().toLowerCase(), e.code.toLowerCase())) {
    t.fail();
    throw new HttpError(403, '提取码不正确');
  }
  t.ok();
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${unlockCookie(e)}=${unlockToken(e)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}${secure}`);
}

/** 分享内的相对路径 -> 驱动和存储内部路径（文件分享只能访问 /） */
export function resolveIn(e, rel = '/') {
  const p = vfs.normalize(rel);
  if (!e.isDir && p !== '/') throw new HttpError(404, '文件不存在');
  const driver = vfs.getDriver(e.storageId);
  const inner = e.isDir ? path.posix.join(e.inner, p) : e.inner;
  return { driver, inner, name: p === '/' ? e.name : path.posix.basename(p), key: `${e.storageId}:${inner}` };
}

/** 分享页打开时：给页面用的公开信息；同一浏览器一天内只算一次访问 */
export function publicInfo(req, res, e, ownerName) {
  const seen = `pan_sv_${e.id}`;
  if (!readCookie(req, seen)) {
    db.update(e.id, { views: e.views + 1 });
    res.append('Set-Cookie', `${seen}=1; Path=/; Max-Age=86400; SameSite=Lax`);
  }
  return {
    id: e.id,
    name: e.name,
    isDir: e.isDir,
    size: e.size,
    owner: ownerName,
    expiresAt: e.expiresAt,
    createdAt: e.createdAt,
    needCode: !!e.code,
    unlocked: unlocked(req, e),
  };
}

export function countView(e) {
  db.update(e.id, { views: e.views + 1 });
}

/** 计一次下载：断点续传/拖动进度产生的后续 Range 请求不重复计数 */
export function countDownload(req, e) {
  const range = req.headers.range;
  if (!range || /^bytes=0-/.test(range)) db.update(e.id, { downloads: e.downloads + 1 });
}
