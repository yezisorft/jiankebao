/**
 * 简课表查看 · Cloudflare Workers + KV 匿名使用人数统计接口
 *
 * 隐私说明：
 * - 不记录 IP、不收集姓名/课表/设备指纹，仅在 KV 中维护一个整数计数器 total_users。
 * - GET  /stats     返回 { ok: true, totalUsers }
 * - POST /stats/hit 将 total_users 计数 +1 并返回 { ok: true, totalUsers }
 */

const COUNTER_KEY = 'total_users';

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

function jsonResponse(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(request)
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (!env.STATS_KV) {
      return jsonResponse(request, { ok: false, error: 'STATS_KV binding is not configured' }, 500);
    }

    try {
      if (request.method === 'GET' && (path === '/' || path === '/stats')) {
        const raw = await env.STATS_KV.get(COUNTER_KEY);
        const totalUsers = Math.max(0, Number.parseInt(raw || '0', 10) || 0);
        return jsonResponse(request, { ok: true, totalUsers });
      }

      if (request.method === 'POST' && path === '/stats/hit') {
        const raw = await env.STATS_KV.get(COUNTER_KEY);
        const current = Math.max(0, Number.parseInt(raw || '0', 10) || 0);
        const next = current + 1;
        await env.STATS_KV.put(COUNTER_KEY, String(next));
        return jsonResponse(request, { ok: true, totalUsers: next });
      }

      return jsonResponse(request, { ok: false, error: 'Not Found' }, 404);
    } catch (err) {
      console.error(JSON.stringify({ event: 'stats_error', message: err?.message || String(err) }));
      return jsonResponse(request, { ok: false, error: 'Internal Server Error' }, 500);
    }
  }
};
