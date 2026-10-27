import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function contentDisposition(name, inline = false) {
  return `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// 预览需要正确的 Content-Type，很多存储上传时没记录类型，这里按扩展名补
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  ogv: 'video/ogg', m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus',
  txt: 'text/plain; charset=utf-8', json: 'application/json',
};

export function mimeOf(name) {
  return MIME[String(name).split('.').pop().toLowerCase()];
}

/** inline 预览时，svg 之类可执行脚本的类型改成纯下载，防止 XSS */
export function safeInlineType(name) {
  const t = mimeOf(name);
  return t && t !== 'image/svg+xml' ? t : null;
}

/** 下载方式字段，S3 / 123云盘 共用 */
export const downloadModeField = {
  key: 'downloadMode',
  label: '下载方式',
  type: 'select',
  default: 'redirect',
  options: [
    { value: 'redirect', label: '302 重定向（浏览器直连存储，不占服务器带宽）' },
    { value: 'proxy', label: '服务器代理（流量经服务器中转，存储地址不对外暴露）' },
  ],
};

/** 服务器代理：请求上游地址，把状态码、关键响应头和数据流原样转给浏览器，支持 Range */
export async function proxyFetch(url, req, res, name, inline = false, headers = {}) {
  const h = { 'Accept-Encoding': 'identity', ...headers };
  if (req.headers.range) h.Range = req.headers.range;
  const ac = new AbortController();
  res.on('close', () => ac.abort()); // 浏览器中途取消时停止拉取上游
  const r = await fetch(url, { headers: h, signal: ac.signal });
  if (!r.ok) {
    throw Object.assign(new Error(`上游下载失败: ${r.status} ${r.statusText}`), { status: r.status === 404 ? 404 : 502 });
  }
  res.status(r.status);
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = r.headers.get(k);
    if (v) res.setHeader(k, v);
  }
  const type = inline && safeInlineType(name);
  if (type) res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', contentDisposition(name, !!type));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!r.body) return res.end();
  await pipeline(Readable.fromWeb(r.body), res).catch((e) => {
    if (e.name !== 'AbortError' && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw e;
  });
}
