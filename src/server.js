import express from 'express';
import busboy from 'busboy';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';
import * as space from './space.js';
import * as trash from './trash.js';
import * as shares from './shares.js';
import * as vfs from './vfs.js';
import { HttpError } from './vfs.js';
import { DRIVER_TYPES } from './drivers/index.js';
import * as media from './media.js';
import * as uploads from './upload.js';

const PORT = Number(process.env.PORT || 8080);
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
app.use(express.static(path.join(ROOT, 'public')));

// 前端第三方库直接从 node_modules 提供，不依赖外部 CDN（内网也能用）
const VENDOR = {
  pdfjs: 'pdfjs-dist/build',
  'pdfjs-web': 'pdfjs-dist/web',
  'pdfjs-cmaps': 'pdfjs-dist/cmaps', // 中日韩字体映射，没有它很多中文 PDF 会乱码
  'pdfjs-fonts': 'pdfjs-dist/standard_fonts',
  hls: 'hls.js/dist',
  viewerjs: 'viewerjs/dist',
};
for (const [prefix, dir] of Object.entries(VENDOR)) {
  app.use(`/vendor/${prefix}`, express.static(path.join(ROOT, 'node_modules', dir), { maxAge: '7d' }));
}

// ---------- 登录 / 注册 ----------
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.get('/api/me', auth.me);
app.get('/api/register', auth.registerInfo);
app.post('/api/register', async (req, res) => {
  const user = auth.register(req, res);
  await space.prepareHome(user);
  res.json({ user: user.username, role: user.role, id: user.id });
});

// ---------- HLS 分片：会话 id 是随机 UUID，本身就是访问凭据，分享页也要用，所以不要求登录 ----------
app.get('/api/hls/:id/index.m3u8', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(media.playlist(media.getSession(req.params.id)));
});
app.get('/api/hls/:id/:n.ts', async (req, res) => {
  await media.segment(media.getSession(req.params.id), Number(req.params.n), res);
});

// ---------- 公开分享 ----------
const pub = express.Router();

pub.get('/share/:id', (req, res) => {
  const e = shares.active(req.params.id, 'share');
  res.json(shares.publicInfo(req, res, e, auth.findUser(e.owner)?.username || '已注销的用户'));
});

pub.post('/share/:id/unlock', (req, res) => {
  shares.unlock(req, res, shares.active(req.params.id, 'share'), req.body?.code);
  res.json({ ok: true });
});

/** 公开分享里的一个路径（先校验有效期和提取码） */
function shareTarget(req, rel) {
  const e = shares.active(req.params.id, 'share');
  shares.requireUnlocked(req, e);
  return { e, ...shares.resolveIn(e, rel) };
}

pub.get('/share/:id/list', async (req, res) => {
  const { e, driver, inner } = shareTarget(req, req.query.path);
  if (!e.isDir) throw new HttpError(400, '这是单个文件的分享');
  const items = vfs.hideReserved(await driver.list(inner));
  items.sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name, 'zh'));
  res.json({ path: vfs.normalize(req.query.path), items });
});

async function shareDownload(req, res, rel) {
  const { e, driver, inner, name } = shareTarget(req, rel);
  const inline = req.query.inline === '1';
  if (!inline) shares.countDownload(req, e);
  await driver.download(inner, req, res, { name, inline, proxy: req.query.proxy === '1' });
}
pub.get('/share/:id/download', (req, res) => shareDownload(req, res, req.query.path));
pub.get('/share/:id/d/*path', (req, res) => shareDownload(req, res, '/' + req.params.path.join('/')));

async function shareMedia(req, rel) {
  const { driver, inner, key } = shareTarget(req, rel);
  if (!driver.source) throw new HttpError(501, '该存储不支持转码');
  return { key, src: await driver.source(inner) };
}
pub.get('/share/:id/probe', async (req, res) => {
  const { key, src } = await shareMedia(req, req.query.path);
  res.json(await media.probe(key, src));
});
pub.get('/share/:id/image', async (req, res) => sendImage(res, (await shareMedia(req, req.query.path)).src));
pub.post('/share/:id/transcode', async (req, res) => {
  const { key, src } = await shareMedia(req, req.body?.path);
  res.json(sessionInfo(await media.createSession(key, src)));
});

app.use('/api/public', pub);
app.get('/s/:id', (req, res) => res.sendFile(path.join(ROOT, 'public', 'share.html')));

// 直链：直接返回文件本身。能内嵌显示的类型（图片、视频、PDF…）按 inline 返回，方便外链引用
app.get('/d/:id{/:name}', async (req, res) => {
  const e = shares.active(req.params.id, 'direct');
  const { driver, inner } = shares.resolveIn(e, '/');
  if (!req.headers.range || /^bytes=0-/.test(req.headers.range)) shares.countView(e);
  shares.countDownload(req, e);
  await driver.download(inner, req, res, { name: e.name, inline: true });
});

// ---------- 以下都需要登录 ----------
const api = express.Router();
api.use(auth.requireAuth);

// ---------- 账号 ----------
api.put('/account', async (req, res) => {
  const { info, renamed } = auth.updateAccount(req, res);
  if (renamed && req.user.role !== 'admin') await space.renameHome(renamed.from, renamed.to).catch((e) => console.error('[space] 私人空间改名失败', e.message));
  res.json(info);
});

// ---------- 文件操作（按当前用户的视角解析路径） ----------
const scopeOf = (req) => space.scope(req.user);

api.get('/fs/list', async (req, res) => {
  const items = await scopeOf(req).list(req.query.path);
  items.sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name, 'zh'));
  res.json({ path: vfs.normalize(req.query.path), items });
});

api.post('/fs/mkdir', async (req, res) => {
  const { driver, inner } = await scopeOf(req).resolve(req.body.path, { write: true });
  await driver.mkdir(inner, vfs.validName(req.body.name));
  res.json({ ok: true });
});

api.post('/fs/rename', async (req, res) => {
  const { driver, inner } = await scopeOf(req).resolve(req.body.path, { allowRoot: false, write: true });
  await driver.rename(inner, vfs.validName(req.body.name));
  res.json({ ok: true });
});

// 删除 = 移到回收站（30 天内可以还原）
api.post('/fs/delete', async (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  const sc = scopeOf(req);
  for (const p of paths) await trash.moveToTrash(req.user, await sc.resolve(p, { allowRoot: false, write: true }));
  res.json({ ok: true, trashed: paths.length });
});

async function download(req, res, p) {
  const { driver, inner } = await scopeOf(req).resolve(p, { allowRoot: false });
  // inline=1 用于预览：浏览器内直接显示而不是保存
  await driver.download(inner, req, res, {
    name: path.posix.basename(inner),
    inline: req.query.inline === '1',
    proxy: req.query.proxy === '1',
  });
}

api.get('/fs/download', (req, res) => download(req, res, req.query.path));

// 路径式地址 /api/fs/d/目录/文件名：m3u8 里用相对路径引用的 ts 分片能正确解析
api.get('/fs/d/*path', (req, res) => download(req, res, '/' + req.params.path.join('/')));

// ---------- 媒体：识别编码 / 图片转换 / HLS 实时转码 ----------

async function mediaSource(req, p) {
  const { storage, driver, inner } = await scopeOf(req).resolve(p, { allowRoot: false });
  if (!driver.source) throw new HttpError(501, '该存储不支持转码');
  return { key: `${storage.id}:${inner}`, src: await driver.source(inner) };
}

async function sendImage(res, src) {
  const jpg = await media.convertImage(src);
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.end(jpg);
}

const sessionInfo = (s) => ({ id: s.id, duration: s.duration, video: !!s.info.video, playlist: `/api/hls/${s.id}/index.m3u8` });

api.get('/fs/probe', async (req, res) => {
  const { key, src } = await mediaSource(req, req.query.path);
  res.json(await media.probe(key, src));
});
api.get('/fs/image', async (req, res) => sendImage(res, (await mediaSource(req, req.query.path)).src));
api.post('/fs/transcode', async (req, res) => {
  const { key, src } = await mediaSource(req, req.body.path);
  res.json(sessionInfo(await media.createSession(key, src)));
});
api.delete('/hls/:id', (req, res) => {
  media.closeSession(req.params.id);
  res.json({ ok: true });
});

// ---------- 分块上传（网页使用；单块远小于 Cloudflare 免费版 100MB 上限） ----------
// POST /api/uploads {path, name, size, lastModified} -> {id, chunkSize, chunks, received[]}
// PUT  /api/uploads/:id/:index  请求体为该块的原始二进制
// POST /api/uploads/:id/complete  后台写入存储，立即返回；GET /api/uploads/:id 查询状态
api.post('/uploads', async (req, res) => res.json(await uploads.init(req.user, scopeOf(req), req.body || {})));
api.put('/uploads/:id/:index', async (req, res) => res.json(await uploads.putChunk(req.user, req.params.id, req.params.index, req)));
api.post('/uploads/:id/complete', (req, res) => res.json(uploads.complete(req.user, req.params.id)));
api.get('/uploads/:id', (req, res) => res.json(uploads.status(req.user, req.params.id)));
api.delete('/uploads/:id', async (req, res) => {
  await uploads.cancel(req.user, req.params.id);
  res.json({ ok: true });
});

// 旧接口：整个文件一个请求（文件超过 100MB 时过不了 Cloudflare 免费版，网页已改用分块上传）
// 每个请求上传一个文件：POST /api/fs/upload?path=<目录>&size=<字节数>，multipart 字段名 file
api.post('/fs/upload', async (req, res, next) => {
  const { driver, inner } = await scopeOf(req).resolve(req.query.path, { write: true });
  const size = Number(req.query.size) || 0;
  let task = null;
  const bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1 } });
  bb.on('file', (field, stream, info) => {
    // task 的结果是 null（成功）或错误对象，避免出现未处理的 Promise 拒绝
    task = (async () => vfs.validName(path.posix.basename(info.filename || '')))()
      .then((name) => driver.upload(inner, name, stream, size))
      .then(
        () => null,
        (e) => {
          stream.resume(); // 丢弃剩余数据，让 busboy 能走到 close
          return e;
        },
      );
  });
  bb.on('close', async () => {
    const err = task ? await task : new HttpError(400, '没有收到文件');
    if (err) return next(err);
    res.json({ ok: true });
  });
  bb.on('error', next);
  req.pipe(bb);
});

// ---------- 回收站 ----------
api.get('/trash', (req, res) => res.json(trash.list(req.user)));
api.post('/trash/:id/restore', async (req, res) => res.json(await trash.restore(req.user, req.params.id)));
api.delete('/trash/:id', async (req, res) => res.json({ ok: true, ...(await trash.purge(req.user, req.params.id)) }));
api.delete('/trash', async (req, res) => res.json({ ok: true, ...(await trash.empty(req.user)) }));

// ---------- 分享和直链 ----------
api.get('/shares', (req, res) => res.json(shares.list(req.user)));
api.post('/shares', async (req, res) => {
  const { path: p, type, code, days } = req.body || {};
  res.json(await shares.create(req.user, await scopeOf(req).resolve(p, { allowRoot: false }), { type, code, days }));
});
api.delete('/shares/:id', (req, res) => {
  shares.remove(req.user, req.params.id);
  res.json({ ok: true });
});

// ---------- 以下只有管理员能用：存储管理、系统设置、用户管理 ----------
const admin = express.Router();
admin.use(auth.requireAdmin);

admin.get('/storages/types', (req, res) => {
  res.json(Object.fromEntries(Object.entries(DRIVER_TYPES).map(([k, v]) => [k, { label: v.label, fields: v.fields }])));
});
admin.get('/storages', (req, res) => res.json(vfs.listStorages()));
admin.post('/storages', (req, res) => res.json(vfs.addStorage(req.body)));
admin.put('/storages/:id', (req, res) => res.json(vfs.updateStorage(req.params.id, req.body)));
admin.delete('/storages/:id', (req, res) => {
  vfs.removeStorage(req.params.id);
  res.json({ ok: true });
});

admin.get('/settings', (req, res) => res.json(space.getSpaceSettings()));
admin.put('/settings', (req, res) => res.json(space.updateSettings(req.body || {})));

admin.get('/users', (req, res) => res.json(auth.listUsers()));
admin.put('/users/:id', (req, res) => res.json(auth.adminUpdateUser(req.user, req.params.id, req.body || {})));
admin.delete('/users/:id', async (req, res) => {
  const u = auth.adminDeleteUser(req.user, req.params.id);
  shares.removeOwner(u.id); // 他的分享链接全部失效
  await trash.purgeOwner(u.id); // 他回收站里的文件彻底删除；私人空间里的文件保留，管理员可以在存储里看到
  res.json({ ok: true });
});

api.use(admin);
app.use('/api', api);

// 文件系统错误换成可读的中文提示；原始错误里带有服务器上的绝对路径，不能返回给浏览器
const FS_ERRORS = {
  EEXIST: [409, '已经有同名的文件或文件夹'],
  ENOENT: [404, '文件或文件夹不存在'],
  ENOTDIR: [400, '目标不是文件夹'],
  EISDIR: [400, '这是一个文件夹'],
  ENOTEMPTY: [409, '文件夹不是空的'],
  EACCES: [403, '服务器没有权限访问这个位置'],
  EPERM: [403, '服务器没有权限执行这个操作'],
  ENOSPC: [507, '服务器磁盘空间不足'],
  EROFS: [403, '这个存储是只读的'],
  ENAMETOOLONG: [400, '文件名太长'],
};

app.use((err, req, res, next) => {
  const fsErr = typeof err.code === 'string' && FS_ERRORS[err.code];
  const status = fsErr ? fsErr[0] : err.status || err.$metadata?.httpStatusCode || 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.destroy();
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: fsErr ? fsErr[1] : err.message || '服务器错误' });
});

vfs.initDrivers();
app.listen(PORT, () => console.log(`pan 已启动: http://0.0.0.0:${PORT}`));
