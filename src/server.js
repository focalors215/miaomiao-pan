import express from 'express';
import busboy from 'busboy';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, logout, currentUser, requireAuth, updateAccount } from './auth.js';
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

// ---------- 登录 ----------
app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', (req, res) => res.json({ user: currentUser(req) }));

const api = express.Router();
api.use(requireAuth);

// ---------- 账号 ----------
api.put('/account', updateAccount);

// ---------- 文件操作 ----------
api.get('/fs/list', async (req, res) => {
  const items = await vfs.list(req.query.path);
  items.sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name, 'zh'));
  res.json({ path: vfs.normalize(req.query.path), items });
});

api.post('/fs/mkdir', async (req, res) => {
  const { driver, inner } = vfs.mustResolve(req.body.path);
  await driver.mkdir(inner, vfs.validName(req.body.name));
  res.json({ ok: true });
});

api.post('/fs/rename', async (req, res) => {
  const { driver, inner } = vfs.mustResolve(req.body.path, { allowRoot: false });
  await driver.rename(inner, vfs.validName(req.body.name));
  res.json({ ok: true });
});

api.post('/fs/delete', async (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  for (const p of paths) {
    const { driver, inner } = vfs.mustResolve(p, { allowRoot: false });
    await driver.remove(inner);
  }
  res.json({ ok: true });
});

async function download(p, req, res) {
  const { driver, inner } = vfs.mustResolve(p, { allowRoot: false });
  // inline=1 用于预览：浏览器内直接显示而不是保存
  await driver.download(inner, req, res, {
    name: path.posix.basename(inner),
    inline: req.query.inline === '1',
    proxy: req.query.proxy === '1',
  });
}

api.get('/fs/download', (req, res) => download(req.query.path, req, res));

// 路径式地址 /api/fs/d/目录/文件名：m3u8 里用相对路径引用的 ts 分片能正确解析
api.get('/fs/d/*path', (req, res) => download('/' + req.params.path.join('/'), req, res));

// ---------- 媒体：识别编码 / 图片转换 / HLS 实时转码 ----------

async function mediaSource(p) {
  const { storage, driver, inner } = vfs.mustResolve(p, { allowRoot: false });
  if (!driver.source) throw new HttpError(501, '该存储不支持转码');
  return { key: `${storage.id}:${inner}`, src: await driver.source(inner) };
}

api.get('/fs/probe', async (req, res) => {
  const { key, src } = await mediaSource(req.query.path);
  res.json(await media.probe(key, src));
});

api.get('/fs/image', async (req, res) => {
  const { src } = await mediaSource(req.query.path);
  const jpg = await media.convertImage(src);
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.end(jpg);
});

api.post('/fs/transcode', async (req, res) => {
  const { key, src } = await mediaSource(req.body.path);
  const s = await media.createSession(key, src);
  res.json({ id: s.id, duration: s.duration, video: !!s.info.video, playlist: `/api/hls/${s.id}/index.m3u8` });
});

api.get('/hls/:id/index.m3u8', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(media.playlist(media.getSession(req.params.id)));
});

api.get('/hls/:id/:n.ts', async (req, res) => {
  await media.segment(media.getSession(req.params.id), Number(req.params.n), res);
});

api.delete('/hls/:id', (req, res) => {
  media.closeSession(req.params.id);
  res.json({ ok: true });
});

// ---------- 分块上传（网页使用；单块远小于 Cloudflare 免费版 100MB 上限） ----------
// POST /api/uploads {path, name, size, lastModified} -> {id, chunkSize, chunks, received[]}
// PUT  /api/uploads/:id/:index  请求体为该块的原始二进制
// POST /api/uploads/:id/complete  后台写入存储，立即返回；GET /api/uploads/:id 查询状态
api.post('/uploads', async (req, res) => res.json(await uploads.init(req.body || {})));
api.put('/uploads/:id/:index', async (req, res) => res.json(await uploads.putChunk(req.params.id, req.params.index, req)));
api.post('/uploads/:id/complete', (req, res) => res.json(uploads.complete(req.params.id)));
api.get('/uploads/:id', (req, res) => res.json(uploads.status(req.params.id)));
api.delete('/uploads/:id', async (req, res) => {
  await uploads.cancel(req.params.id);
  res.json({ ok: true });
});

// 旧接口：整个文件一个请求（文件超过 100MB 时过不了 Cloudflare 免费版，网页已改用分块上传）
// 每个请求上传一个文件：POST /api/fs/upload?path=<目录>&size=<字节数>，multipart 字段名 file
api.post('/fs/upload', (req, res, next) => {
  const { driver, inner } = vfs.mustResolve(req.query.path);
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

// ---------- 存储管理 ----------
api.get('/storages/types', (req, res) => {
  res.json(Object.fromEntries(Object.entries(DRIVER_TYPES).map(([k, v]) => [k, { label: v.label, fields: v.fields }])));
});
api.get('/storages', (req, res) => res.json(vfs.listStorages()));
api.post('/storages', (req, res) => res.json(vfs.addStorage(req.body)));
api.put('/storages/:id', (req, res) => res.json(vfs.updateStorage(req.params.id, req.body)));
api.delete('/storages/:id', (req, res) => {
  vfs.removeStorage(req.params.id);
  res.json({ ok: true });
});

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
