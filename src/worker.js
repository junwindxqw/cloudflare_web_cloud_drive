// Worker 入口：/api/* 由 API 处理，其余由静态资源（SPA）托管
import { handleApi } from './api.js';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, ctx);
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error('Unhandled error:', e && (e.stack || e.message || e));
      return new Response(JSON.stringify({ error: '服务器内部错误' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  },
};
