import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { pipeline } from 'node:stream/promises';
import { contentDisposition, mimeOf, safeInlineType } from './util.js';

export class S3Driver {
  constructor(o) {
    this.bucket = o.bucket;
    this.prefix = String(o.prefix || '').replace(/^\/+|\/+$/g, '');
    this.proxy = o.downloadMode === 'proxy';
    this.client = new S3Client({
      region: o.region || 'us-east-1',
      endpoint: o.endpoint || undefined,
      forcePathStyle: !!o.forcePathStyle,
      credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
    });
  }

  /** 内部路径 -> 对象 key（目录以 / 结尾） */
  key(p, dir = false) {
    const k = [this.prefix, p.replace(/^\/+|\/+$/g, '')].filter(Boolean).join('/');
    return dir ? (k ? k + '/' : '') : k;
  }

  async *walk(prefix, delimiter) {
    let token;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, Delimiter: delimiter, ContinuationToken: token }),
      );
      yield r;
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }

  async list(dir) {
    const prefix = this.key(dir, true);
    const out = [];
    for await (const r of this.walk(prefix, '/')) {
      for (const cp of r.CommonPrefixes || []) {
        out.push({ name: cp.Prefix.slice(prefix.length).replace(/\/$/, ''), isDir: true, size: 0, modified: null });
      }
      for (const obj of r.Contents || []) {
        if (obj.Key === prefix) continue; // 目录占位对象
        out.push({ name: obj.Key.slice(prefix.length), isDir: false, size: obj.Size, modified: obj.LastModified?.toISOString() });
      }
    }
    return out;
  }

  async isDir(p) {
    for await (const r of this.walk(this.key(p, true))) return (r.KeyCount || 0) > 0;
    return false;
  }

  async mkdir(dir, name) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(`${dir}/${name}`, true), Body: '' }));
  }

  async keysUnder(p) {
    if (!(await this.isDir(p))) return [this.key(p)];
    const keys = [];
    for await (const r of this.walk(this.key(p, true))) keys.push(...(r.Contents || []).map((o) => o.Key));
    return keys;
  }

  async deleteKeys(keys) {
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }),
      );
    }
  }

  async remove(p) {
    await this.deleteKeys(await this.keysUnder(p));
  }

  // S3 没有重命名，只能复制后删除（目录需逐个对象处理）
  async rename(p, newName) {
    const parent = p.replace(/\/[^/]*$/, '');
    const dir = await this.isDir(p);
    const from = dir ? this.key(p, true) : this.key(p);
    const to = dir ? this.key(`${parent}/${newName}`, true) : this.key(`${parent}/${newName}`);
    const keys = await this.keysUnder(p);
    for (const k of keys) {
      const source = `${this.bucket}/${k}`.split('/').map(encodeURIComponent).join('/');
      await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, CopySource: source, Key: to + k.slice(from.length) }));
    }
    await this.deleteKeys(keys);
  }

  async upload(dir, name, stream) {
    await new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: this.key(`${dir}/${name}`), Body: stream, ContentType: mimeOf(name) || 'application/octet-stream' },
      partSize: 16 * 1024 * 1024,
      queueSize: 4,
    }).done();
  }

  async source(p) {
    // 预签名地址给服务器自己的 ffmpeg 用，Endpoint 只要服务器能访问即可
    return { input: await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: this.key(p) }), { expiresIn: 6 * 3600 }) };
  }

  async download(p, req, res, { name, inline, proxy }) {
    const type = inline && safeInlineType(name);
    const params = { Bucket: this.bucket, Key: this.key(p), ResponseContentDisposition: contentDisposition(name, !!type) };
    if (type) params.ResponseContentType = type;
    if (!this.proxy && !proxy) {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(p) }));
      return res.redirect(302, await getSignedUrl(this.client, new GetObjectCommand(params), { expiresIn: 3600 }));
    }
    const r = await this.client.send(new GetObjectCommand({ ...params, Range: req.headers.range }));
    res.status(r.ContentRange ? 206 : 200);
    res.setHeader('Content-Disposition', contentDisposition(name, !!type));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    if (type || r.ContentType) res.setHeader('Content-Type', type || r.ContentType);
    if (r.ContentLength != null) res.setHeader('Content-Length', r.ContentLength);
    if (r.ContentRange) res.setHeader('Content-Range', r.ContentRange);
    await pipeline(r.Body, res);
  }
}
