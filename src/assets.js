// 用户头像和网盘壁纸：不限制大小。请求体直接流式写到磁盘（不读进内存），服务器只按文件头校验格式，存到 DATA_DIR/assets/
// （放在 Cloudflare 免费版后面时，单个请求仍受它 100MB 的限制）
// - 头像：assets/avatar-<用户 id>，用户记录里的 avatar 是版本号（上传时间），地址带上版本号以便浏览器长期缓存
// - 壁纸：assets/wallpaper，设置在 config.settings.wallpaper = { version, dim, login }
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, getConfig, save } from './store.js';
import { HttpError } from './vfs.js';

const DIR = path.join(DATA_DIR, 'assets');
fs.mkdirSync(DIR, { recursive: true });

/** 按文件头判断图片格式（不看扩展名和 Content-Type）：JPEG / PNG / WebP / GIF / AVIF，都是浏览器能直接显示的 */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]$/.test(buf.toString('latin1', 8, 12))) return 'image/avif';
  return null;
}

/** 把请求体流式写到 assets/<name>：先写临时文件，按开头的字节判断格式，合法才替换旧图 */
async function write(req, name, what) {
  const file = path.join(DIR, name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let head = Buffer.alloc(0);
  let size = 0;
  try {
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    for await (const chunk of req) {
      if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
      size += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (!size) throw new HttpError(400, `没有收到${what}图片`);
    const type = sniff(head);
    if (!type) throw new HttpError(415, `${what}只支持 JPEG、PNG、WebP、GIF、AVIF 格式的图片`);
    await fsp.rename(tmp, file);
    await fsp.writeFile(file + '.type', type);
    return { type, size };
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

function send(res, name) {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) throw new HttpError(404, '图片不存在');
  const type = fs.existsSync(file + '.type') ? fs.readFileSync(file + '.type', 'utf8') : 'image/jpeg';
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', fs.statSync(file).size);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 地址里带版本号，图片换了地址就变，所以可以放心长期缓存
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  fs.createReadStream(file).pipe(res);
}

const avatarName = (id) => `avatar-${String(id).replace(/[^a-zA-Z0-9-]/g, '')}`;

// ---------- 头像 ----------

export const avatarUrl = (u) => (u?.avatar ? `/api/avatar/${u.id}?v=${u.avatar}` : null);

export async function saveAvatar(user, req) {
  await write(req, avatarName(user.id), '头像');
  user.avatar = Date.now();
  save();
  return avatarUrl(user);
}

export async function removeAvatar(user) {
  await fsp.rm(path.join(DIR, avatarName(user.id)), { force: true });
  await fsp.rm(path.join(DIR, avatarName(user.id) + '.type'), { force: true });
  delete user.avatar;
  save();
}

export function sendAvatar(res, user) {
  if (!user?.avatar) throw new HttpError(404, '这个用户没有设置头像');
  send(res, avatarName(user.id));
}

// ---------- 壁纸 ----------

function wp() {
  const s = getConfig().settings;
  s.wallpaper ||= { version: 0, dim: 0.35, login: true };
  return s.wallpaper;
}

/** 给所有页面用的外观信息（登录页、分享页也要用，所以不需要登录） */
export function site() {
  const w = wp();
  return { wallpaper: w.version ? { url: `/api/wallpaper?v=${w.version}`, dim: w.dim, login: w.login } : null, dim: w.dim, login: w.login };
}

export async function saveWallpaper(req) {
  await write(req, 'wallpaper', '壁纸');
  wp().version = Date.now();
  save();
  return site();
}

export async function removeWallpaper() {
  await fsp.rm(path.join(DIR, 'wallpaper'), { force: true });
  wp().version = 0;
  save();
  return site();
}

export function updateWallpaper({ dim, login } = {}) {
  const w = wp();
  if (dim !== undefined) {
    dim = Number(dim);
    if (!(dim >= 0 && dim <= 0.9)) throw new HttpError(400, '遮罩强度只能在 0～90% 之间');
    w.dim = Math.round(dim * 100) / 100;
  }
  if (login !== undefined) w.login = !!login;
  save();
  return site();
}

export function sendWallpaper(res) {
  if (!wp().version) throw new HttpError(404, '还没有设置壁纸');
  send(res, 'wallpaper');
}

/** 删除用户时一并删掉他的头像 */
export async function removeOwner(id) {
  await fsp.rm(path.join(DIR, avatarName(id)), { force: true });
  await fsp.rm(path.join(DIR, avatarName(id) + '.type'), { force: true });
}
