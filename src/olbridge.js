// 内置 OpenList 后端：本站用它来创建和管理“更多网盘”（阿里云盘、百度网盘、OneDrive 等 70+ 种）。
// 连接信息来自环境变量（docker-compose 里已配置好），登录 token 持久化在 config.json。
import crypto from 'node:crypto';
import { getConfig, save } from './store.js';
import { OpenListDriver } from './drivers/openlist.js';

export function connection() {
  return {
    url: process.env.OPENLIST_URL || 'http://openlist:5244',
    username: process.env.OPENLIST_USER || 'admin',
    password: process.env.OPENLIST_PASSWORD || process.env.ADMIN_PASSWORD || '',
  };
}

let client = null;
export function backend() {
  if (client) return client;
  const cfg = getConfig();
  cfg.openlistState ??= {};
  client = new OpenListDriver(
    { ...connection(), root: '/' },
    { getState: () => cfg.openlistState, setState: (s) => ((cfg.openlistState = s), save()) },
  );
  return client;
}

/** OpenList 里给托管存储用的挂载路径，用户不可见 */
export const newOlMount = () => '/pan-' + crypto.randomBytes(4).toString('hex');

/** 把表单里的通用项和驱动专属项拼成 OpenList 的创建/更新请求体 */
export function storageBody({ driver, common = {}, addition = {} }, mountPath, id) {
  const { mount_path, id: _i, driver: _d, addition: _a, ...rest } = common;
  return { ...(id ? { id } : {}), ...rest, mount_path: mountPath, driver, addition: JSON.stringify(addition) };
}
