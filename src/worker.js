// Worker 入口：/api/* 由 API 处理，/i/* 为图床公开直链，其余由静态资源（SPA）托管
import { handleApi, handleImagebedRaw, HttpError } from './api.js';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, ctx);
      }
      if (url.pathname.startsWith('/i/')) {
        // id 段只可能是 UUID.扩展名（纯 ASCII），decode 失败一律按“不存在”处理，避免 500
        let idParam = url.pathname.slice(3);
        try {
          idParam = decodeURIComponent(idParam);
        } catch {}
        return await handleImagebedRaw(request, env, idParam);
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof HttpError) {
        return new Response(e.message, { status: e.status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      console.error('Unhandled error:', e && (e.stack || e.message || e));
      return new Response(JSON.stringify({ error: '服务器内部错误' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  },
};
