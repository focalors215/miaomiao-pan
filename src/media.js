// 媒体处理：用 ffprobe 识别编码、ffmpeg 把浏览器不支持的音视频实时转成 HLS（H.264/AAC），
// 把 HEIC/TIFF 等图片转成 JPEG。思路参考 Jellyfin：固定 6 秒分片、按需转码、拖动进度时从目标位置重启 ffmpeg。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './vfs.js';

const SEG = 6; // 分片秒数
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const WORK = path.join(os.tmpdir(), 'pan-transcode');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

/** ffmpeg 的输入参数：远程地址带上鉴权头和断线重连 */
function inputArgs(src) {
  const args = [];
  if (/^https?:/.test(src.input)) {
    const headers = Object.entries(src.headers || {})
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    if (headers) args.push('-headers', headers);
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  return [...args, '-i', src.input];
}

function run(cmd, args, { timeout = 60_000, maxBytes = 64 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (b) => {
      size += b.length;
      if (size > maxBytes) p.kill('SIGKILL');
      else out.push(b);
    });
    p.stderr.on('data', (b) => (err = (err + b).slice(-2000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new HttpError(501, `服务器没有安装 ${cmd}`) : e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} 失败: ${err.trim().split('\n').pop() || code}`));
    });
  });
}

// ---------- 识别编码 ----------

const probeCache = new Map(); // key -> { at, info }

function hex2(n) {
  return Math.max(0, Number(n) || 0).toString(16).padStart(2, '0');
}

/** 把 ffprobe 的流信息换算成浏览器 canPlayType 能识别的 codecs 字符串，换算不了返回 null */
function codecString(s) {
  const tenBit = /10|12/.test(s.pix_fmt || '');
  switch (s.codec_name) {
    case 'h264': {
      const prof = { Baseline: 0x42, 'Constrained Baseline': 0x42, Main: 0x4d, High: 0x64 }[s.profile];
      return prof ? `avc1.${hex2(prof)}00${hex2(s.level)}` : null; // High 10 / 4:2:2 等浏览器基本不支持
    }
    case 'hevc':
      return tenBit ? `hvc1.2.4.L${s.level || 120}.B0` : `hvc1.1.6.L${s.level || 120}.B0`;
    case 'vp8':
      return 'vp8';
    case 'vp9':
      return tenBit ? 'vp09.02.10.10' : 'vp09.00.10.08';
    case 'av1':
      return `av01.0.08M.${tenBit ? 10 : '08'}`;
    case 'aac':
      return 'mp4a.40.2';
    case 'mp3':
      return 'mp4a.6B';
    case 'opus':
      return 'opus';
    case 'vorbis':
      return 'vorbis';
    case 'flac':
      return 'flac';
    case 'alac':
      return 'alac';
    case 'ac3':
      return 'ac-3';
    case 'eac3':
      return 'ec-3';
    default:
      return null;
  }
}

/**
 * 根据容器和编码给出浏览器原生播放用的 MIME，比如 video/mp4; codecs="avc1.640028,mp4a.40.2"。
 * 返回 null 表示浏览器一般放不了，直接转码。
 */
function nativeMime(format, video, audio) {
  const f = format.format_name || '';
  if (!video) {
    if (!audio) return null;
    if (f === 'mp3') return 'audio/mpeg';
    if (f === 'flac') return 'audio/flac';
    if (f === 'wav' && /^pcm_(s16le|s24le|f32le|u8)$/.test(audio.codec_name)) return 'audio/wav';
    if (f === 'ogg' && ['opus', 'vorbis', 'flac'].includes(audio.codec_name)) return `audio/ogg; codecs="${audio.codec_name}"`;
    if (f.startsWith('mov,mp4')) return codecString(audio) && `audio/mp4; codecs="${codecString(audio)}"`;
    if (f === 'matroska,webm' && ['opus', 'vorbis'].includes(audio.codec_name)) return `audio/webm; codecs="${audio.codec_name}"`;
    return null;
  }
  const codecs = [video, audio].filter(Boolean).map(codecString);
  if (codecs.includes(null)) return null;
  if (f.startsWith('mov,mp4')) return `video/mp4; codecs="${codecs.join(',')}"`;
  const webmOk = ['vp8', 'vp9', 'av1'].includes(video.codec_name) && (!audio || ['opus', 'vorbis'].includes(audio.codec_name));
  if (f === 'matroska,webm' && webmOk) return `video/webm; codecs="${codecs.join(',')}"`;
  return null; // mkv(H.264/HEVC)、avi、flv、ts、wmv、rmvb……一律转码，避免各浏览器表现不一
}

export async function probe(key, src) {
  const c = probeCache.get(key);
  if (c && Date.now() - c.at < 10 * 60_000) return c.info;
  const out = await run(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', ...inputArgs(src)], {
    timeout: 30_000,
  });
  const j = JSON.parse(out.toString());
  const streams = j.streams || [];
  // 封面图（attached_pic）不算视频流，比如带封面的 mp3
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const info = {
    duration: Number(j.format?.duration) || 0,
    format: j.format?.format_name,
    video: video && { codec: video.codec_name, profile: video.profile, width: video.width, height: video.height, pixFmt: video.pix_fmt },
    audio: audio && { codec: audio.codec_name, channels: audio.channels },
    mime: nativeMime(j.format || {}, video, audio),
  };
  probeCache.set(key, { at: Date.now(), info });
  return info;
}

// ---------- 图片转换 ----------

/** HEIC/TIFF/浏览器解不了的图片 -> JPEG（长边最大 4096） */
export async function convertImage(src) {
  const scale = "scale='if(gt(iw,ih),min(4096,iw),-2)':'if(gt(iw,ih),-2,min(4096,ih))',format=yuvj420p";
  const out = ['-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', 'pipe:1'];
  try {
    return await run(FFMPEG, ['-v', 'error', ...inputArgs(src), '-vf', scale, ...out], { timeout: 60_000 });
  } catch (e) {
    // iPhone 的 HEIC 是多块小图拼成的（ffmpeg 里叫 tile grid 流组），-vf 用不了，要对流组 0 做滤镜
    return run(FFMPEG, ['-v', 'error', ...inputArgs(src), '-filter_complex', `[0:g:0]${scale}[o]`, '-map', '[o]', ...out], {
      timeout: 60_000,
    }).catch(() => {
      throw e;
    });
  }
}

// ---------- HLS 实时转码 ----------

const sessions = new Map(); // id -> session

function segCount(s) {
  return Math.max(1, Math.ceil(s.duration / SEG));
}

export async function createSession(key, src) {
  const info = await probe(key, src);
  if (!info.video && !info.audio) throw new HttpError(415, '文件里没有可播放的音视频流');
  if (!info.duration) throw new HttpError(415, '无法识别时长，不能转码');
  for (const s of sessions.values()) if (s.key === key) return s; // 同一文件复用
  const id = crypto.randomUUID();
  const s = { id, key, src, info, duration: info.duration, dir: path.join(WORK, id), proc: null, start: 0, wanted: 0, lastAccess: Date.now() };
  await fsp.mkdir(s.dir, { recursive: true });
  sessions.set(id, s);
  return s;
}

export function getSession(id) {
  const s = sessions.get(id);
  if (!s) throw new HttpError(404, '转码会话已过期，请重新打开预览');
  s.lastAccess = Date.now();
  return s;
}

export function playlist(s) {
  const n = segCount(s);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let i = 0; i < n; i++) {
    const d = i === n - 1 ? s.duration - SEG * (n - 1) : SEG;
    lines.push(`#EXTINF:${d.toFixed(3)},`, `${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

function stop(s) {
  if (s.proc) {
    s.proc.kill('SIGKILL');
    s.proc = null;
  }
}

/** 从第 k 个分片开始启动 ffmpeg（拖动进度到还没转好的位置时重启） */
function startAt(s, k) {
  stop(s);
  s.start = k;
  s.error = null;
  s.done = false;
  const v = s.info.video;
  const args = ['-hide_banner', '-v', 'error', '-ss', String(k * SEG), ...inputArgs(s.src)];
  if (v) {
    args.push(
      '-map', '0:v:0', '-map', '0:a:0?',
      // 限制到 1080p，转成浏览器都支持的 8bit H.264；按 6 秒强制关键帧，保证分片边界和播放列表完全对齐
      '-vf', "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1080,ih))',format=yuv420p",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-level', '4.1',
      '-force_key_frames', `expr:gte(t,n_forced*${SEG})`, '-sc_threshold', '0',
    );
  } else {
    args.push('-map', '0:a:0', '-vn');
  }
  args.push(
    '-c:a', 'aac', '-ac', '2', '-b:a', '160k',
    '-sn', '-dn', '-max_muxing_queue_size', '4096',
    '-output_ts_offset', String(k * SEG),
    '-f', 'hls', '-hls_time', String(SEG), '-hls_list_size', '0', '-hls_segment_type', 'mpegts',
    '-start_number', String(k), '-hls_flags', 'temp_file+independent_segments',
    '-hls_segment_filename', path.join(s.dir, '%d.ts'),
    path.join(s.dir, 'ffmpeg.m3u8'),
  );
  const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (b) => (err = (err + b).slice(-2000)));
  p.on('error', (e) => (s.error = e.code === 'ENOENT' ? '服务器没有安装 ffmpeg' : e.message));
  p.on('close', (code, signal) => {
    if (s.proc !== p) return; // 已经被新的进程替换
    s.proc = null;
    if (code === 0) s.done = true;
    else if (signal !== 'SIGKILL') s.error = `转码失败: ${err.trim().split('\n').pop() || code}`;
  });
  s.proc = p;
  s.paused = false;
}

const exists = (f) => fsp.access(f).then(() => true, () => false);

/** 当前 ffmpeg 已经连续转好的最后一个分片号（从本次启动位置数起；一个都没转好时返回 start - 1） */
async function produced(s, from = s.start) {
  let i = from - 1;
  while (await exists(path.join(s.dir, `${i + 1}.ts`))) i++;
  return i;
}

export async function segment(s, i, res) {
  if (!Number.isInteger(i) || i < 0 || i >= segCount(s)) throw new HttpError(404, '分片不存在');
  const file = path.join(s.dir, `${i}.ts`);
  if (!(await exists(file))) {
    // 目标就在当前转码进度后面一两个分片就等它；否则（拖动进度跳远了）立刻从目标位置重启 ffmpeg，
    // 按约 4 倍速转码算，重启只需 2 秒左右，比等它顺序转过去快
    const near = s.proc && i >= s.start && i <= (await produced(s)) + 2;
    if (!near) startAt(s, i);
    resume(s);
    const deadline = Date.now() + 90_000;
    while (!(await exists(file))) {
      if (s.error) throw new HttpError(500, s.error);
      if (!s.proc && !s.done) startAt(s, i);
      if (s.done && !(await exists(file))) startAt(s, i);
      if (Date.now() > deadline) throw new HttpError(504, '转码超时');
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  s.wanted = i;
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  await new Promise((resolve, reject) => res.sendFile(file, (e) => (e && !res.headersSent ? reject(e) : resolve())));
}

// 转得太靠前就暂停 ffmpeg，省 CPU；播放追上来再继续
function pause(s) {
  if (s.proc && !s.paused) {
    s.proc.kill('SIGSTOP');
    s.paused = true;
  }
}
function resume(s) {
  if (s.proc && s.paused) {
    s.proc.kill('SIGCONT');
    s.paused = false;
  }
}

setInterval(async () => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.lastAccess > 10 * 60_000) {
      // 10 分钟没人看：删除会话和临时文件
      stop(s);
      sessions.delete(s.id);
      fsp.rm(s.dir, { recursive: true, force: true });
    } else if (now - s.lastAccess > 60_000) {
      stop(s); // 1 分钟没请求（暂停或关掉了）：停掉进程，分片保留
    } else if (s.proc) {
      if ((await produced(s, s.wanted + 1)) - s.wanted > 10) pause(s); // 已经领先播放位置 10 个分片（1 分钟）
      else resume(s);
    }
  }
}, 2000).unref();

export function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  stop(s);
  sessions.delete(id);
  fsp.rm(s.dir, { recursive: true, force: true });
}
