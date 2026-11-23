/**
 * 简课表查看 · 版本化原子缓存与作用域隔离 Service Worker
 *
 * 设计要点：
 * 1. CACHE_VERSION 与 CORE_ASSETS 由 scripts/build-release.mjs 按发布资源内容哈希自动生成，
 *    任意业务文件变更均会产生新的 sw.js 内容，触发已有安装平滑更新。
 * 2. 缓存前缀绑定 self.registration.scope 哈希，避免同源不同子路径部署误删彼此缓存。
 * 3. CORE_ASSETS 全部原子预缓存；已有旧版运行时新版停留在 waiting，待用户确认后切换。
 */

// @build-meta-start
const CACHE_VERSION = 'v1.0.8-live-stats';
const CORE_ASSETS = [
  './',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg',
  './index.html',
  './js/app.js',
  './js/engine.js',
  './js/html-inert-dom.js',
  './js/ics.js',
  './js/importers.js',
  './js/model.js',
  './js/sample-fixture.js',
  './js/storage.js',
  './js/transfer.js',
  './manifest.webmanifest',
  './styles.css'
];
// @build-meta-end

function getScopeInfo() {
  const scope = String(self.registration?.scope || './');
  let hash = 2166136261;
  for (let i = 0; i < scope.length; i += 1) {
    hash ^= scope.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const scopeTag = (hash >>> 0).toString(16).padStart(8, '0');
  let isRootScope = false;
  try {
    isRootScope = new URL(scope).pathname === '/';
  } catch {
    isRootScope = false;
  }
  return {
    prefix: `jkb-shell-${scopeTag}-`,
    cacheName: `jkb-shell-${scopeTag}-${CACHE_VERSION}`,
    isRootScope
  };
}

self.addEventListener('install', (event) => {
  const { cacheName } = getScopeInfo();
  event.waitUntil(
    caches.open(cacheName).then(async (cache) => {
      const requests = CORE_ASSETS.map((url) => new Request(url, { cache: 'reload' }));
      await cache.addAll(requests);
      if (!self.registration.active) {
        await self.skipWaiting();
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  const { prefix, cacheName, isRootScope } = getScopeInfo();
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => {
              if (k === cacheName) return false;
              if (k.startsWith(prefix)) return true;
              // 仅在根路径部署时清理旧版无作用域前缀的 jkb-shell-v* 缓存，绝不影响同源其他子路径
              if (isRootScope && /^jkb-shell-v\d/.test(k)) return true;
              return false;
            })
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'GET_OFFLINE_STATUS' && event.ports && event.ports[0]) {
    const { cacheName } = getScopeInfo();
    event.waitUntil(
      (async () => {
        try {
          const cache = await caches.open(cacheName);
          let cachedCount = 0;
          for (const asset of CORE_ASSETS) {
            const match = await cache.match(asset, { ignoreSearch: true });
            if (match) cachedCount += 1;
          }
          event.ports[0].postMessage({
            ready: cachedCount === CORE_ASSETS.length,
            version: CACHE_VERSION,
            cachedCount,
            totalCount: CORE_ASSETS.length
          });
        } catch {
          event.ports[0].postMessage({
            ready: false,
            version: CACHE_VERSION,
            cachedCount: 0,
            totalCount: CORE_ASSETS.length
          });
        }
      })()
    );
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const reqUrl = new URL(event.request.url);
  if (reqUrl.origin !== self.location.origin) return;

  const { cacheName } = getScopeInfo();

  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.open(cacheName).then(async (cache) => {
        const cachedIndex = await cache.match('./index.html') || await cache.match('./');
        if (cachedIndex) return cachedIndex;
        return fetch(event.request);
      })
    );
    return;
  }

  event.respondWith(
    caches.open(cacheName).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await fetch(event.request);
      } catch {
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })
  );
});
