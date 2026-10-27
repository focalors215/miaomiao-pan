// 预览渲染：图片用 viewer.js，PDF 用 pdf.js，m3u8 用 hls.js，其余音视频用浏览器原生播放器
// 第三方库都在第一次用到时才加载，由服务端从 node_modules 提供（/vendor/...）
//
// 每种类型都有降级链，尽量不让用户看到“无法预览”：
//   音视频：ffprobe 识别编码 → 浏览器支持就直接播 → 失败走服务器代理 → 再失败服务器实时转码（HLS H.264/AAC）
//   图片：直接加载 → 服务器代理 → 服务器转成 JPEG（HEIC/TIFF 直接转）
//   PDF：直接加载 → 服务器代理

const loaded = {};
function once(key, fn) {
  return (loaded[key] ??= fn().catch((e) => {
    delete loaded[key];
    throw e;
  }));
}

function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.append(l);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`加载 ${src} 失败`));
    document.head.append(s);
  });
}

const loadViewer = () =>
  once('viewer', async () => {
    loadCss('/vendor/viewerjs/viewer.min.css');
    await loadScript('/vendor/viewerjs/viewer.min.js');
    return window.Viewer;
  });

const loadHls = () =>
  once('hls', async () => {
    await loadScript('/vendor/hls/hls.min.js');
    return window.Hls;
  });

const loadPdf = () =>
  once('pdf', async () => {
    loadCss('/vendor/pdfjs-web/pdf_viewer.css');
    const lib = await import('/vendor/pdfjs/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    globalThis.pdfjsLib = lib; // pdf_viewer.mjs 通过这个全局变量拿到核心库
    const viewer = await import('/vendor/pdfjs-web/pdf_viewer.mjs');
    return { lib, viewer };
  });

/**
 * 在 container 里渲染预览，返回清理函数
 * ctx: { kind, name, path, urls: { inline, raw, proxy, path, probe, image }, onError, onStatus }
 * onStatus(text)：在预览顶部显示一行状态，比如“服务器转码中”
 */
export async function renderPreview(container, ctx) {
  if (ctx.kind === 'image') return renderImage(container, ctx);
  if (ctx.kind === 'pdf') return renderPdf(container, ctx);
  if (ctx.kind === 'video' || ctx.kind === 'audio') return renderMedia(container, ctx);
  throw new Error('不支持的类型');
}

function spinner(container, text = '加载中…') {
  const el = document.createElement('div');
  el.className = 'pv-loading';
  el.innerHTML = `<i></i><span></span>`;
  el.querySelector('span').textContent = text;
  container.append(el);
  return {
    text: (t) => (el.querySelector('span').textContent = t),
    remove: () => el.remove(),
  };
}

// ---------- 图片 ----------

const SERVER_IMAGE = ['heic', 'heif', 'tif', 'tiff'];

function tryImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(src);
    img.onerror = reject;
    img.src = src;
  });
}

async function renderImage(container, { name, urls, onError, onStatus }) {
  const sp = spinner(container);
  const ext = name.split('.').pop().toLowerCase();
  const candidates = SERVER_IMAGE.includes(ext) ? [urls.image] : [urls.inline, urls.proxy, urls.image];
  let src = null;
  for (const c of candidates) {
    try {
      src = await tryImage(c);
      break;
    } catch {}
  }
  sp.remove();
  if (!src) return onError(), () => {};
  if (src === urls.image) onStatus('服务器转换显示');
  const Viewer = await loadViewer();
  const img = document.createElement('img');
  img.alt = name;
  img.src = src;
  img.style.display = 'none';
  container.append(img);
  const viewer = new Viewer(img, {
    inline: true,
    backdrop: false,
    button: false,
    navbar: false,
    title: false,
    transition: false,
    keyboard: false, // 左右键留给外层切换文件
    tooltip: true,
    toolbar: { zoomIn: 1, zoomOut: 1, oneToOne: 1, reset: 1, rotateLeft: 1, rotateRight: 1, flipHorizontal: 1 },
  });
  return () => viewer.destroy();
}

// ---------- 音视频 ----------

/** 等媒体元素能播放或出错 */
function waitPlayable(el, timeout = 20000) {
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      el.removeEventListener('loadeddata', onOk);
      el.removeEventListener('error', onErr);
      resolve(ok);
    };
    const onOk = () => done(true);
    const onErr = () => done(false);
    const timer = setTimeout(() => done(el.readyState >= 2), timeout);
    el.addEventListener('loadeddata', onOk);
    el.addEventListener('error', onErr);
  });
}

function stopMedia(el) {
  el.pause();
  el.removeAttribute('src');
  el.load(); // 真正断开连接，停止继续下载
}

async function renderMedia(container, ctx) {
  const { kind, name, urls, onError, onStatus } = ctx;
  const el = document.createElement(kind);
  el.controls = true;
  el.preload = 'auto';
  el.playsInline = true;
  let hls = null;
  let closed = false;
  const cleanup = () => {
    closed = true;
    hls?.destroy();
    stopMedia(el);
  };
  const gone = () => closed || !!ctx.isStale?.(); // 已关闭或已切到别的文件
  const sp = spinner(container);
  // 能播了：仍是当前预览才开始播放，否则立刻清理
  const finish = (status) => {
    sp.remove();
    if (gone()) cleanup();
    else {
      if (status) onStatus(status);
      el.play().catch(() => {});
    }
    return cleanup;
  };

  const play = async (src, useHls) => {
    hls?.destroy();
    hls = null;
    // HLS 优先用 hls.js（基于 MSE，各浏览器行为一致）；只有不支持 MSE 的（iPhone Safari）才用原生播放。
    // 新版 Chrome 的原生 HLS 拖动进度后会卡住，所以不能优先用原生
    const Hls = useHls && (await loadHls().catch(() => null));
    if (useHls && Hls?.isSupported()) {
      const policy = {
        default: {
          maxTimeToFirstByteMs: 90000, // 服务器转码时首个分片可能要等几秒
          maxLoadTimeMs: 180000,
          timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
          errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
        },
      };
      hls = new Hls({ fragLoadPolicy: policy, startPosition: 0 });
      const fatal = new Promise((r) => hls.on(Hls.Events.ERROR, (_, d) => d.fatal && r(false)));
      hls.loadSource(src);
      hls.attachMedia(el);
      return Promise.race([waitPlayable(el, 90000), fatal]);
    }
    if (useHls && !el.canPlayType('application/vnd.apple.mpegurl')) return false;
    el.src = src;
    return waitPlayable(el, useHls ? 90000 : 20000);
  };

  try {
    // m3u8 本身就是 HLS：用路径式地址，播放列表里的相对分片路径才能解析
    if (name.toLowerCase().endsWith('.m3u8')) {
      container.append(el);
      if (await play(urls.path, true)) return finish();
      sp.remove();
      onError();
      return cleanup;
    }

    // 1. 识别编码，判断浏览器能不能原生播放
    const info = await fetch(urls.probe).then((r) => (r.ok ? r.json() : null), () => null);
    if (gone()) return cleanup(), cleanup;
    const native = info ? !!info.mime && el.canPlayType(info.mime) !== '' : true; // 识别失败也先试试直接播
    container.append(el);

    // 2. 直接播放 → 3. 服务器代理（302 目标浏览器访问不到时）
    if (native) {
      for (const src of [urls.inline, urls.proxy]) {
        if (await play(src)) return finish();
        if (gone()) return cleanup(), cleanup;
      }
    }

    // 4. 服务器实时转码
    sp.text('服务器转码中，首次加载需要几秒…');
    const r = await fetch('/api/fs/transcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ctx.path }),
    });
    const t = await r.json().catch(() => ({}));
    if (gone()) return cleanup(), cleanup;
    if (!r.ok) throw new Error(t.error || '转码失败');
    if (await play(t.playlist, true)) {
      return finish(info?.video ? `服务器转码播放（原编码 ${info.video.codec}${info.audio ? ' / ' + info.audio.codec : ''}）` : '服务器转码播放');
    }
    throw new Error('转码播放失败');
  } catch (e) {
    console.error(e);
    sp.remove();
    if (!gone()) onError(e.message);
    return cleanup;
  }
}

// ---------- PDF ----------

async function renderPdf(container, { urls, onError }) {
  const { lib, viewer: V } = await loadPdf();
  container.innerHTML = `
    <div class="pdf-toolbar">
      <button data-z="-1" title="缩小">－</button>
      <span class="pdf-scale">100%</span>
      <button data-z="1" title="放大">＋</button>
      <button data-fit title="适合宽度">适合宽度</button>
      <span class="pdf-page"></span>
    </div>
    <div class="pdf-scroll"><div class="pdfViewer"></div></div>`;
  const scroll = container.querySelector('.pdf-scroll');
  const sp = spinner(scroll);
  const eventBus = new V.EventBus();
  const linkService = new V.PDFLinkService({ eventBus });
  const pdfViewer = new V.PDFViewer({ container: scroll, eventBus, linkService, removePageBorders: false });
  linkService.setViewer(pdfViewer);

  let task = null;
  let closed = false;
  const open = (url) => {
    task = lib.getDocument({
      url,
      cMapUrl: '/vendor/pdfjs-cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs-fonts/',
    });
    // 加密 PDF：弹窗要密码
    task.onPassword = (update, reason) => {
      const pw = prompt(reason === lib.PasswordResponses.INCORRECT_PASSWORD ? '密码错误，请重新输入' : '这个 PDF 有密码，请输入');
      if (pw === null) task.destroy();
      else update(pw);
    };
    return task.promise;
  };
  (async () => {
    // 先直接从存储加载（302 模式不经过服务器），网络类错误再改走服务器代理
    for (const url of [urls.raw, urls.proxy]) {
      try {
        const doc = await open(url);
        if (closed) return;
        sp.remove();
        pdfViewer.setDocument(doc);
        linkService.setDocument(doc);
        return;
      } catch (e) {
        if (closed || e.name === 'PasswordException' || e.name === 'InvalidPDFException') break;
        console.warn('PDF 加载失败，尝试下一种方式', e);
      }
    }
    sp.remove();
    if (!closed) onError('PDF 文件已损坏或无法读取');
  })();

  const pageEl = container.querySelector('.pdf-page');
  const scaleEl = container.querySelector('.pdf-scale');
  eventBus.on('pagesinit', () => (pdfViewer.currentScaleValue = 'page-width'));
  eventBus.on('pagechanging', (e) => (pageEl.textContent = `${e.pageNumber} / ${pdfViewer.pagesCount}`));
  eventBus.on('pagesloaded', (e) => (pageEl.textContent = `1 / ${e.pagesCount}`));
  eventBus.on('scalechanging', (e) => (scaleEl.textContent = `${Math.round(e.scale * 100)}%`));
  container.querySelector('.pdf-toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.fit !== undefined) pdfViewer.currentScaleValue = 'page-width';
    else pdfViewer.currentScale = Math.min(5, Math.max(0.25, pdfViewer.currentScale * (b.dataset.z > 0 ? 1.2 : 1 / 1.2)));
  });
  const onResize = () => {
    if (pdfViewer.currentScaleValue === 'page-width') pdfViewer.currentScaleValue = 'page-width';
  };
  window.addEventListener('resize', onResize);
  return () => {
    closed = true;
    window.removeEventListener('resize', onResize);
    task?.destroy();
    pdfViewer.cleanup?.();
  };
}
