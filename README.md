# 网盘

自托管的网盘网站：把本机目录、S3 存储桶、WebDAV、123云盘挂载到同一个目录树里，在网页上统一浏览、上传、下载、重命名、删除和在线预览。用 Docker 一条命令部署。

## 功能

- **多存储聚合**：每个存储挂载成一个文件夹（比如 `/本地`、`/s3`、`/123`），在网页里随时添加、修改、停用，不用重启。
- **文件管理**：
  - 浏览、新建文件夹、重命名、删除。
  - 拖拽或多选上传，最多同时传 3 个，带进度条。
- **在线预览**：
  - 图片：缩放、旋转。
  - PDF：pdf.js 渲染。
  - 视频、音频：浏览器播不了的编码（HEVC、AC3/DTS、AVI、WMV……）由服务器用 ffmpeg 实时转码，可以拖动进度。
  - HEIC/TIFF 图片：自动转成 JPEG 显示。
- **下载方式可选**：S3 和 123云盘可以选“302 重定向”（浏览器直连存储，不占服务器带宽）或“服务器代理”（不暴露存储地址）。
- **账号**：登录后点右上角的用户名，可以修改用户名和密码。
- **界面**：适配手机，跟随系统的深色模式。

支持的存储：

| 类型 | 说明 |
| --- | --- |
| 本机存储 | 容器内的目录，可以通过 volume 挂载宿主机目录 |
| S3 存储桶 | AWS S3、MinIO、阿里云 OSS、腾讯云 COS、Cloudflare R2 等兼容 S3 的服务 |
| WebDAV | 任意 WebDAV 服务（如 Nextcloud、群晖、坚果云） |
| 123云盘 | 123云盘开放平台，需要开发者权益包的 client_id / client_secret |

## 快速开始

需要 Docker 和 Docker Compose。

```bash
git clone git@github.com:focalors215/-.git pan
cd pan
cp .env.example .env      # 修改 ADMIN_PASSWORD
docker compose up -d --build
```

打开 `http://服务器IP:8080`，用 `.env` 里的账号密码登录，到“存储”页添加挂载即可使用。

### 环境变量

在 `.env` 里设置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_USER` | `admin` | 首次启动时创建的管理员用户名 |
| `ADMIN_PASSWORD` | 无，必填 | 首次启动时创建的管理员密码 |
| `ADMIN_RESET` | `false` | 忘记密码时设为 `true` 并重启，会用上面两项重置账号；重置后改回 `false` |
| `PAN_PORT` | `8080` | 宿主机上对外的端口 |

需要时可以加到 `docker-compose.yml` 的 `environment` 里：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TRUST_PROXY` | `false` | 放在 Nginx/Caddy 等 HTTPS 反向代理后面时设为 `true`，登录 Cookie 会带上 `Secure` |
| `DATA_DIR` | `/data` | 配置文件目录 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | ffmpeg 可执行文件位置（镜像里已经装好） |

### 修改账号密码

- **修改入口：** 登录后点右上角的用户名，输入当前密码即可修改用户名和/或密码。新密码至少 8 位。
- **对已登录设备的影响：** 修改后，其他设备上的登录全部失效，当前设备保持登录。
- **与 `.env` 的关系：** `.env` 里的 `ADMIN_USER`、`ADMIN_PASSWORD` 只在第一次启动时用来创建账号。之后以网页里改过的为准，改 `.env` 不会生效。
- **密码存储：** 密码用 scrypt 加盐哈希保存，配置文件里没有明文。
- **防暴力破解：** 同一 IP 15 分钟内输错 10 次密码，会被锁定 15 分钟。

**忘记密码：** 在 `.env` 里设置新的 `ADMIN_PASSWORD`，再加上 `ADMIN_RESET=true`，然后重启：

```bash
docker compose up -d
```

能登录后，把 `ADMIN_RESET` 改回 `false` 再重启一次，否则以后每次重启都会重置。

### 数据和备份

所有配置保存在 `./data/config.json`，包括各存储的凭据和 123云盘的 access_token。
- **备份：** 备份这个目录就行。
- **权限：** 文件权限是 600，不要提交到版本库，也不要放到网页能访问的位置。

升级时拉取新代码后重新构建：

```bash
git pull
docker compose up -d --build
```

## 添加存储

登录后进入“存储”页点“添加存储”。表单里带 `*` 的是必填项。保存后，密钥类字段在列表里显示为 `******`；编辑时保持 `******` 不改，就沿用原来的值。

### 本机存储

根目录填容器内的路径，默认是 `/data/local`（对应宿主机的 `./data/local`）。

要使用宿主机上已有的目录，在 `docker-compose.yml` 的 `volumes` 里加一行，然后在网页里把根目录填成 `/mnt/disk`：

```yaml
    volumes:
      - ./data:/data
      - /srv/files:/mnt/disk
```

### S3 存储桶

- **基本参数：** 填 Endpoint、Region、Bucket、Access Key。AWS S3 的 Endpoint 可以留空；MinIO 需要开启“Path-style 访问”。
- **下载方式：**
  - **302 重定向**（默认）：返回预签名地址，浏览器直接从存储下载。要求浏览器能访问到 Endpoint。
  - **服务器代理**：Endpoint 只有服务器能访问（比如内网 MinIO）时选这个。
- **重命名的限制：** S3 没有原生的重命名操作，重命名文件夹会逐个复制对象再删除，对象多时比较慢。

### WebDAV

填服务地址、用户名、密码，可以指定根路径。下载经服务器中转，不会把 WebDAV 账号暴露给浏览器。

### 123云盘

1. 在 123云盘开通[开发者权益包](https://www.123pan.com/member?productKey=vip&source_page=vip_button&tabKey=1)，`client_id` 和 `client_secret` 会以站内信发送。
2. 添加存储时填入这两个值。根目录 ID 填 `0` 表示整个网盘，也可以填某个文件夹的 ID。

说明：
- **登录凭证：** 每个 client_id 最多同时有 3 个有效的 access_token，网盘会把 token 保存下来反复使用。
- **上传：**
  - 先在服务器上算出文件 MD5，网盘里已有相同文件就秒传；否则分片上传。
  - 同名文件会被覆盖。
- **下载：**
  - 302 模式直接跳到 123 的 CDN 直链，不经过你的服务器。
  - 服务器代理和转码会消耗 123 的下载流量，非会员每天 1GB。
- **删除：** 删除的文件进 123 的回收站。
- **列表延迟：** 目录列表缓存 60 秒，在 123 官网或 App 里做的改动最多延迟 1 分钟显示。

接口说明见 [docs/123云盘开放平台](docs/123云盘开放平台)。

## 在线预览

点击文件即可预览，← → 键切换同一文件夹里的其他可预览文件。

| 类型 | 格式 | 实现 |
| --- | --- | --- |
| 图片 | jpg png gif webp bmp avif svg heic heif tif tiff | [viewer.js](https://github.com/fengyuanchen/viewerjs)：缩放、1:1、旋转、翻转，手机上可以双指缩放 |
| PDF | pdf | [pdf.js](https://github.com/mozilla/pdf.js)：所有浏览器显示一致，支持中文 CMap 和带密码的 PDF |
| 视频 | mp4 webm mov mkv m4v avi wmv flv rmvb m2ts mpg vob 3gp 等 | 浏览器能放就原生播放，放不了由服务器实时转码，用 [hls.js](https://github.com/video-dev/hls.js) 播放 |
| 音频 | mp3 m4a aac flac wav ogg opus ape wma ac3 dts 等 | 同上 |
| HLS | m3u8 | hls.js；不支持 MSE 的浏览器（iPhone Safari）用原生播放 |

### 降级策略

每种类型都有多级降级，只有全部失败（比如文件损坏）才会提示无法预览：

- **音视频**：
  1. 先用 ffprobe 识别编码，再问浏览器能不能播（`canPlayType`）。
  2. 能播就直接播，失败再走服务器代理。
  3. 还不行，或者一开始就判断浏览器放不了（HEVC、10bit、AC3/DTS 音轨、mkv/avi/wmv/flv 等），由服务器实时转成 H.264/AAC 的 HLS 播放。
- **图片**：直接加载 → 服务器代理 → 服务器转成 JPEG。HEIC/TIFF 直接转换。
- **PDF**：先从存储直接加载（302 模式不经过服务器），失败再走服务器代理。

### 实时转码

做法参考 Jellyfin：

- **拖动进度：**
  - 视频按 6 秒切片，播放列表预先算好，可以任意拖动进度。
  - 拖到还没转好的位置时，ffmpeg 从那里重新开始转，大约 2 秒恢复播放。
- **输出格式：** 最高 1080p 的 H.264 8bit + 双声道 AAC，所有浏览器都能播。
- **资源占用：**
  - 转得超前播放位置 1 分钟就暂停 ffmpeg，节省 CPU。
  - 1 分钟没有请求就停掉进程，10 分钟没人看就删除临时分片（容器内 `/tmp/pan-transcode`）。
- **性能：**
  - 在 2 核 ARM 服务器上，1080p HEVC → H.264 大约是 4 倍实时速度，同时转码 1～2 路没问题。
  - 4K 或多人同时转码需要更强的 CPU。
- **云存储上的文件：** S3、WebDAV、123云盘上的文件由服务器读取远端数据转码，会消耗服务器带宽。

前端用到的 viewer.js、pdf.js、hls.js 通过 npm 安装，由服务器从 `node_modules` 提供（`/vendor/...`），不依赖外部 CDN，内网也能用。

## 本地开发

需要 Node.js 20 以上。要用视频转码和 HEIC/TIFF 转换，还需要安装 ffmpeg。

```bash
npm install
ADMIN_PASSWORD=dev DATA_DIR=./data PORT=8080 npm start
```

项目没有构建步骤：后端是 Node.js（ESM）；前端是原生 HTML/CSS/JS，放在 `public/` 下直接由后端提供。

### 端到端测试

测试用的 compose 配置会在内网额外启动 MinIO（模拟 S3）和 WebDAV：

```bash
docker compose -f docker-compose.yml -f test/docker-compose.test.yml up -d --build
docker compose exec pan node test/create-bucket.js        # 在 MinIO 里建 pan-test 桶
bash test/e2e.sh http://127.0.0.1:8080 管理员密码          # 测试本机存储、S3、WebDAV
bash test/e2e.sh http://127.0.0.1:8080 管理员密码 /123     # 额外测试已经在网页里添加好的挂载
```

测试脚本覆盖了这些内容：
- **登录和账号：** 鉴权、修改用户名和密码（测完会改回原来的）。
- **文件操作：** 上传 20MB 文件并校验 MD5、Range 下载、重命名、删除。
- **安全：** 路径穿越防护。
- **下载方式：** 302 和代理之间的切换。

脚本只会增删它自己的 `/本地`、`/s3`、`/dav` 三个挂载，不会动其他挂载。

## 目录结构

```
├── src/
│   ├── server.js        # HTTP 接口
│   ├── vfs.js           # 虚拟文件系统：挂载点解析、存储管理
│   ├── media.js         # ffprobe 识别编码、图片转换、HLS 实时转码
│   ├── auth.js          # 管理员登录
│   ├── store.js         # 配置读写（data/config.json）
│   └── drivers/         # 存储驱动：local、s3、webdav、pan123
├── public/              # 前端页面
├── test/                # 端到端测试和测试用 compose 配置
├── docs/                # 123云盘开放平台接口文档
├── Dockerfile
└── docker-compose.yml
```

新增一种存储，只需要在 `src/drivers/` 里实现驱动类，并在 `drivers/index.js` 的 `DRIVER_TYPES` 里登记表单字段。网页上的“添加存储”表单会按字段定义自动生成。

## 接口

所有接口都需要登录 Cookie，其中 `path` 是虚拟路径，比如 `/s3/photos/a.jpg`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | `{username, password}` |
| POST | `/api/logout` | 退出登录 |
| PUT | `/api/account` | `{currentPassword, username?, newPassword?}`，修改用户名和/或密码 |
| GET | `/api/fs/list?path=` | 列目录 |
| GET | `/api/fs/download?path=[&inline=1][&proxy=1]` | 下载；`inline=1` 用于预览，`proxy=1` 强制经服务器中转 |
| GET | `/api/fs/d/<路径>` | 路径式下载地址（HLS 播放用） |
| GET | `/api/fs/probe?path=` | 识别音视频编码，返回浏览器原生播放用的 MIME（`null` 表示需要转码） |
| GET | `/api/fs/image?path=` | 图片转 JPEG |
| POST | `/api/fs/transcode` | `{path}`，创建转码会话，返回 HLS 播放列表地址 |
| POST | `/api/fs/upload?path=&size=` | multipart 上传，字段名 `file`，每次一个文件 |
| POST | `/api/fs/mkdir` | `{path, name}` |
| POST | `/api/fs/rename` | `{path, name}` |
| POST | `/api/fs/delete` | `{paths: []}` |
| GET/POST/PUT/DELETE | `/api/storages[/:id]` | 存储管理 |
