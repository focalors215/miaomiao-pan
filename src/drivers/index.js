// 存储驱动注册表。每个驱动实现：
//   list(dir) -> [{ name, isDir, size, modified }]
//   mkdir(dir, name) / rename(path, newName) / remove(path)
//   upload(dir, name, stream, size, { file? })  —— file：完整文件已在本地时的路径（分块上传），驱动可以直接读它
//   download(path, req, res, { name, inline, proxy })  —— 自行负责响应（转发数据流或 302 跳转）
//       inline：预览（浏览器内显示）；proxy：强制服务器代理（302 目标浏览器访问不到时用）
//   source(path) -> { input, headers? }  —— 给 ffmpeg 读取的地址：本地文件路径或服务器可访问的 URL
import { LocalDriver } from './local.js';
import { S3Driver } from './s3.js';
import { WebDAVDriver } from './webdav.js';
import { Pan123Driver } from './pan123.js';
import { downloadModeField } from './util.js';

export const DRIVER_TYPES = {
  local: {
    label: '本机存储',
    cls: LocalDriver,
    fields: [{ key: 'root', label: '根目录（容器内路径）', required: true, default: '/data/local' }],
  },
  s3: {
    label: 'S3 存储桶',
    cls: S3Driver,
    fields: [
      { key: 'endpoint', label: 'Endpoint（AWS 可留空）', placeholder: 'https://s3.example.com' },
      { key: 'region', label: 'Region', default: 'us-east-1' },
      { key: 'bucket', label: 'Bucket', required: true },
      { key: 'accessKeyId', label: 'Access Key ID', required: true },
      { key: 'secretAccessKey', label: 'Secret Access Key', required: true, secret: true },
      { key: 'prefix', label: '路径前缀（可选）' },
      { key: 'forcePathStyle', label: 'Path-style 访问（MinIO 需开启）', type: 'boolean', default: true },
      { ...downloadModeField, help: 'Endpoint 只有服务器能访问（如内网 MinIO）时请选服务器代理' },
    ],
  },
  webdav: {
    label: 'WebDAV',
    cls: WebDAVDriver,
    fields: [
      { key: 'url', label: '服务地址', required: true, placeholder: 'https://dav.example.com/dav' },
      { key: 'username', label: '用户名' },
      { key: 'password', label: '密码', secret: true },
      { key: 'root', label: '根路径', default: '/' },
    ],
  },
  pan123: {
    label: '123云盘（开放平台）',
    cls: Pan123Driver,
    fields: [
      { key: 'clientId', label: 'client_id', required: true },
      { key: 'clientSecret', label: 'client_secret', required: true, secret: true },
      { key: 'rootFolderId', label: '根目录 ID（0 为网盘根目录）', default: '0' },
      { ...downloadModeField, help: '服务器代理会消耗 123云盘的下载流量和你服务器的带宽' },
    ],
  },
};

export function createDriver(type, options, state) {
  const def = DRIVER_TYPES[type];
  if (!def) throw new Error(`未知存储类型 ${type}`);
  return new def.cls(options, state);
}
