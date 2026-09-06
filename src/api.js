// 网盘 API：登录、目录、上传（R2 分片）、下载（Range）、分享

import * as auth from './auth.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, '请求体不是有效的 JSON');
  }
}

// ---------- 名称与目录 ----------

function validateName(name) {
  if (typeof name !== 'string') throw new HttpError(400, '名称不能为空');
  name = name.trim();
  if (!name || name.length > 255) throw new HttpError(400, '名称需为 1-255 个字符');
  if (/[\\/\u0000-\u001f]/.test(name) || name === '.' || name === '..') {
    throw new HttpError(400, '名称不能包含路径分隔符或控制字符');
  }
  return name;
}

async function requireFolder(env, id) {
  if (!id) return null;
  const row = await env.DB.prepare("SELECT id FROM files WHERE id = ? AND type = 'folder'").bind(id).first();
  if (!row) throw new HttpError(404, '目标文件夹不存在');
  return id;
}

async function getItem(env, id) {
  const row = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, '文件或文件夹不存在');
  return row;
}

async function nameExists(env, parentId, name, excludeId) {
  const row = parentId
    ? await env.DB.prepare('SELECT 1 FROM files WHERE parent_id = ? AND name = ? AND id != ? LIMIT 1').bind(parentId, name, excludeId || '')
        .first()
    : await env.DB.prepare('SELECT 1 FROM files WHERE parent_id IS NULL AND name = ? AND id != ? LIMIT 1').bind(name, excludeId || '').first();
  return !!row;
}

// 同名时自动追加 “ (n)” 后缀
async function uniqueName(env, parentId, name, excludeId = null, isFolder = false) {
  if (!(await nameExists(env, parentId, name, excludeId))) return name;
  let base = name;
  let ext = '';
  if (!isFolder) {
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
      base = name.slice(0, dot);
      ext = name.slice(dot);
    }
  }
  for (let i = 1; i <= 200; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await nameExists(env, parentId, candidate, excludeId))) return candidate;
  }
  throw new HttpError(409, '该目录下同名项目过多');
}

async function getFolderPath(env, folderId) {
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE up(id, name, parent_id, depth) AS (
       SELECT id, name, parent_id, 0 FROM files WHERE id = ?
       UNION ALL
       SELECT f.id, f.name, f.parent_id, up.depth + 1 FROM files f JOIN up ON f.parent_id = up.id
     ) SELECT id, name FROM up ORDER BY depth DESC`
  )
    .bind(folderId)
    .all();
  return results.map((r) => ({ id: r.id, name: r.name }));
}

// id 是否位于 root 的子树内
async function inSubtree(env, rootId, id) {
  if (rootId === id) return true;
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM files WHERE id = ?
       UNION ALL
       SELECT f.id FROM files f JOIN sub s ON f.parent_id = s.id
     ) SELECT id FROM sub WHERE id = ?`
  )
    .bind(rootId, id)
    .all();
  return results.length > 0;
}

// ---------- 文件下载 / 预览 ----------

const INLINE_MIME = /^(image\/(?!svg)|video\/|audio\/|application\/pdf|text\/|application\/json)/i;

function canInline(mime, name) {
  mime = mime || '';
  if (/svg/i.test(mime) || /\.svg$/i.test(name) || /\.x?html?$/i.test(name)) return false; // 防 XSS
  return INLINE_MIME.test(mime);
}

function contentDisposition(type, name) {
  const fallback = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// 返回 null（无 Range）/ 'invalid'（返回 416）/ {start,end}
function parseRange(header, size) {
  if (!header) return null;
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {
    const suffix = parseInt(m[2], 10);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (size === 0 || start > end || start >= size) return 'invalid';
  return { start, end };
}

async function serveFile(request, env, id, mode) {
  const item = await env.DB.prepare("SELECT name, mime, r2_key FROM files WHERE id = ? AND type = 'file'").bind(id).first();
  if (!item || !item.r2_key) throw new HttpError(404, '文件不存在');

  const rangeHeader = request.headers.get('Range');
  let range = null;
  let size;
  if (rangeHeader) {
    const head = await env.BUCKET.head(item.r2_key);
    if (!head) throw new HttpError(404, '文件内容不存在');
    size = head.size;
    range = parseRange(rangeHeader, size);
    if (range === 'invalid') {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
  }

  const obj = await env.BUCKET.get(item.r2_key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!obj) throw new HttpError(404, '文件内容不存在');
  if (size === undefined) size = obj.size;

  const inline = mode === 'raw' && canInline(item.mime, item.name);
  const length = range ? range.end - range.start + 1 : size;
  const headers = {
    'Content-Type': item.mime || 'application/octet-stream',
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'ETag': obj.httpEtag,
    'Cache-Control': 'private, max-age=0',
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', item.name),
  };
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
  return new Response(obj.body, { status: range ? 206 : 200, headers });
}

// ---------- 上传（R2 分片） ----------

const PART_SIZE = 8 * 1024 * 1024; // 8MiB（R2 分片最小 5MiB）
const MAX_PARTS = 1000;

// 顺带清理 3 天前仍未完成的分片上传，避免残留占用存储
async function cleanupStaleUploads(env) {
  const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
  const { results } = await env.DB.prepare('SELECT upload_id, r2_key, r2_upload_id FROM uploads WHERE created_at < ?').bind(cutoff).all();
  for (const row of results || []) {
    try {
      if (row.r2_upload_id) await env.BUCKET.resumeMultipartUpload(row.r2_key, row.r2_upload_id).abort();
    } catch {}
    await env.DB.prepare('DELETE FROM uploads WHERE upload_id = ?').bind(row.upload_id).run();
  }
}

async function uploadInit(request, env, ctx) {
  const body = await readJson(request);
  const parentId = await requireFolder(env, body.parentId || null);
  const name = await uniqueName(env, parentId, validateName(body.name));
  const size = Number(body.size);
  if (!Number.isInteger(size) || size < 0) throw new HttpError(400, '文件大小无效');
  if (size > MAX_PARTS * PART_SIZE) throw new HttpError(413, '文件过大');
  const mime = typeof body.mime === 'string' && body.mime.length <= 100 ? body.mime : null;

  const id = crypto.randomUUID();
  const r2Key = `files/${id}`;
  let r2UploadId = null;
  if (size > 0) {
    const mp = await env.BUCKET.createMultipartUpload(r2Key, { httpMetadata: { contentType: mime || 'application/octet-stream' } });
    r2UploadId = mp.uploadId;
  }
  const uploadId = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO uploads (upload_id, name, parent_id, size, mime, r2_key, r2_upload_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(uploadId, name, parentId, size, mime, r2Key, r2UploadId, Date.now())
    .run();
  ctx.waitUntil(cleanupStaleUploads(env));
  return json({ uploadId, partSize: PART_SIZE, name });
}

async function uploadPart(request, env, uploadId, nStr) {
  const n = Number(nStr);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) throw new HttpError(400, '分片序号无效');
  const row = await env.DB.prepare('SELECT * FROM uploads WHERE upload_id = ?').bind(uploadId).first();
  if (!row) throw new HttpError(404, '上传任务不存在或已失效');
  if (!row.r2_upload_id) throw new HttpError(400, '该上传无需分片');
  if (!request.body) throw new HttpError(400, '分片内容为空');
  const mp = env.BUCKET.resumeMultipartUpload(row.r2_key, row.r2_upload_id);
  const part = await mp.uploadPart(n, request.body);
  return json({ etag: part.etag });
}

async function uploadComplete(request, env, uploadId) {
  const row = await env.DB.prepare('SELECT * FROM uploads WHERE upload_id = ?').bind(uploadId).first();
  if (!row) throw new HttpError(404, '上传任务不存在或已失效');
  let size = 0;
  if (row.r2_upload_id) {
    const body = await readJson(request);
    const parts = Array.isArray(body.parts) ? body.parts : null;
    if (!parts || parts.length === 0) throw new HttpError(400, '缺少分片信息');
    const seen = new Set();
    const clean = [];
    for (const p of parts) {
      const partNumber = Number(p && p.partNumber);
      const etag = p && typeof p.etag === 'string' ? p.etag : '';
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS || !etag) throw new HttpError(400, '分片信息无效');
      if (seen.has(partNumber)) throw new HttpError(400, '分片序号重复');
      seen.add(partNumber);
      clean.push({ partNumber, etag });
    }
    clean.sort((a, b) => a.partNumber - b.partNumber);
    const mp = env.BUCKET.resumeMultipartUpload(row.r2_key, row.r2_upload_id);
    let obj;
    try {
      obj = await mp.complete(clean);
    } catch {
      throw new HttpError(400, '分片合并失败，请重新上传');
    }
    size = obj.size;
  } else {
    // 0 字节文件：直接 put
    await env.BUCKET.put(row.r2_key, new ArrayBuffer(0), { httpMetadata: { contentType: row.mime || 'application/octet-stream' } });
  }

  const id = row.r2_key.slice('files/'.length);
  const name = await uniqueName(env, row.parent_id, row.name, id);
  await env.DB.prepare('INSERT INTO files (id, type, name, parent_id, size, mime, r2_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, 'file', name, row.parent_id, size, row.mime, row.r2_key, Date.now(), Date.now())
    .run();
  await env.DB.prepare('DELETE FROM uploads WHERE upload_id = ?').bind(uploadId).run();
  const item = await env.DB.prepare('SELECT id, type, name, parent_id, size, mime, created_at, updated_at FROM files WHERE id = ?').bind(id).first();
  return json({ item });
}

async function uploadAbort(env, uploadId) {
  const row = await env.DB.prepare('SELECT * FROM uploads WHERE upload_id = ?').bind(uploadId).first();
  if (row) {
    if (row.r2_upload_id) {
      try {
        await env.BUCKET.resumeMultipartUpload(row.r2_key, row.r2_upload_id).abort();
      } catch {}
    }
    await env.DB.prepare('DELETE FROM uploads WHERE upload_id = ?').bind(uploadId).run();
  }
  return json({ ok: true });
}

// ---------- 删除 ----------

const SUBTREE_CTE = `WITH RECURSIVE sub(id) AS (
  SELECT id FROM files WHERE id = ?
  UNION ALL
  SELECT f.id FROM files f JOIN sub s ON f.parent_id = s.id
)`;

async function deleteItem(env, id) {
  const row = await getItem(env, id);
  if (row.type === 'file') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id),
      env.DB.prepare('DELETE FROM shares WHERE file_id = ?').bind(id),
    ]);
    if (row.r2_key) await env.BUCKET.delete(row.r2_key);
    return json({ ok: true, deleted: 1 });
  }

  const { results } = await env.DB.prepare(
    `WITH RECURSIVE sub(id, r2_key) AS (
       SELECT id, r2_key FROM files WHERE id = ?
       UNION ALL
       SELECT f.id, f.r2_key FROM files f JOIN sub s ON f.parent_id = s.id
     ) SELECT id, r2_key FROM sub`
  )
    .bind(id)
    .all();
  const keys = results.filter((r) => r.r2_key).map((r) => r.r2_key);
  await env.DB.batch([
    env.DB.prepare(`${SUBTREE_CTE} DELETE FROM files WHERE id IN (SELECT id FROM sub)`).bind(id),
    env.DB.prepare(`${SUBTREE_CTE} DELETE FROM shares WHERE file_id IN (SELECT id FROM sub)`).bind(id),
  ]);
  for (let i = 0; i < keys.length; i += 1000) {
    await env.BUCKET.delete(keys.slice(i, i + 1000));
  }
  return json({ ok: true, deleted: results.length });
}

// ---------- 分享 ----------

async function createShare(request, env) {
  const body = await readJson(request);
  const item = await getItem(env, body.fileId);
  let passwordHash = null;
  if (body.password !== undefined && body.password !== null && String(body.password) !== '') {
    const pw = String(body.password);
    if (pw.length > 128) throw new HttpError(400, '分享密码过长');
    passwordHash = await auth.hashSharePassword(pw);
  }
  let expiresAt = null;
  if (body.expireDays !== undefined && body.expireDays !== null) {
    const d = Number(body.expireDays);
    if (!Number.isFinite(d) || d < 0 || d > 3650) throw new HttpError(400, '有效期无效');
    if (d > 0) expiresAt = Date.now() + d * 86400000;
  }
  const id = crypto.randomUUID();
  const token = auth.randomToken();
  await env.DB.prepare('INSERT INTO shares (id, token, file_id, password_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)')
    .bind(id, token, item.id, passwordHash, expiresAt, Date.now())
    .run();
  return json({ id, token, url: `${new URL(request.url).origin}/s/${token}`, expiresAt });
}

async function listShares(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.token, s.file_id AS fileId, s.password_hash IS NOT NULL AS hasPassword,
            s.expires_at AS expiresAt, s.created_at AS createdAt, s.downloads,
            f.name AS fileName, f.size AS fileSize, f.type AS fileType
     FROM shares s LEFT JOIN files f ON f.id = s.file_id
     ORDER BY s.created_at DESC LIMIT 500`
  ).all();
  return json({ shares: results });
}

// ---------- 会话接口 ----------

async function login(request, env, ctx) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(500, '服务端未设置 ADMIN_PASSWORD 密钥');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await auth.checkRateLimit(env, ip))) throw new HttpError(429, '尝试次数过多，请 15 分钟后再试');
  const body = await readJson(request);
  const password = typeof body.password === 'string' ? body.password : '';
  const ok = auth.timingSafeEqualStr(await auth.sha256Hex(password), await auth.sha256Hex(env.ADMIN_PASSWORD));
  if (!ok) {
    ctx.waitUntil(auth.recordFailure(env, ip));
    throw new HttpError(401, '密码错误');
  }
  ctx.waitUntil(auth.clearFailures(env, ip));
  return json({ ok: true }, 200, { 'Set-Cookie': auth.sessionCookie(await auth.createSessionToken(env)) });
}

async function me(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS s FROM files WHERE type = 'file'").first();
  return json({ user: 'admin', fileCount: row?.c || 0, usage: row?.s || 0 });
}

async function listDir(request, env, url) {
  const folderId = url.searchParams.get('folderId') || null;
  if (folderId) {
    const f = await env.DB.prepare("SELECT id FROM files WHERE id = ? AND type = 'folder'").bind(folderId).first();
    if (!f) throw new HttpError(404, '文件夹不存在');
  }
  const sql = `SELECT id, type, name, size, mime, created_at, updated_at FROM files
     WHERE parent_id ${folderId ? '= ?' : 'IS NULL'}
     ORDER BY CASE type WHEN 'folder' THEN 0 ELSE 1 END, name COLLATE NOCASE
     LIMIT 2000`;
  const { results } = await env.DB.prepare(sql).bind(...(folderId ? [folderId] : [])).all();
  const path = folderId ? await getFolderPath(env, folderId) : [];
  return json({ items: results, path });
}

async function searchFiles(env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ items: [] });
  const esc = q.replace(/[\\%_]/g, (c) => '\\' + c);
  const { results } = await env.DB.prepare(
    `SELECT id, type, name, parent_id AS parentId, size, mime, updated_at FROM files
     WHERE name LIKE '%' || ? || '%' ESCAPE '\\'
     ORDER BY updated_at DESC LIMIT 100`
  )
    .bind(esc)
    .all();
  return json({ items: results });
}

// ---------- 公开分享接口（无需登录） ----------

async function handlePub(request, env, ctx, url, seg, method) {
  const token = seg[2];
  const share = await env.DB.prepare('SELECT * FROM shares WHERE token = ?').bind(token).first();
  if (!share) throw new HttpError(404, '分享不存在或已被取消');
  if (share.expires_at && share.expires_at < Date.now()) throw new HttpError(410, '分享已过期');
  const item = await env.DB.prepare('SELECT id, type, name, size, mime FROM files WHERE id = ?').bind(share.file_id).first();
  if (!item) throw new HttpError(404, '分享内容不存在');

  const unlocked = !share.password_hash || (await auth.verifyShareAccess(request, env, token));
  const sub = seg[3];

  if (sub === undefined) {
    if (method !== 'GET') throw new HttpError(405, '方法不允许');
    if (!unlocked) return json({ needsPassword: true });
    return json({ needsPassword: false, id: item.id, name: item.name, type: item.type, size: item.size, mime: item.mime });
  }

  if (sub === 'verify' && method === 'POST') {
    const body = await readJson(request);
    const key = `${request.headers.get('CF-Connecting-IP') || 'unknown'}@${token}`;
    if (!(await auth.checkRateLimit(env, key))) throw new HttpError(429, '尝试次数过多，请稍后再试');
    const ok = await auth.verifySharePassword(share.password_hash, String(body.password || ''));
    if (!ok) {
      ctx.waitUntil(auth.recordFailure(env, key));
      throw new HttpError(401, '密码错误');
    }
    const value = await auth.createShareAccessToken(env, token, share.expires_at);
    return json({ ok: true }, 200, { 'Set-Cookie': auth.shareCookie(token, value, share.expires_at) });
  }

  if (!unlocked) return json({ error: '需要访问密码' }, 401);

  if (sub === 'list' && method === 'GET') {
    if (item.type !== 'folder') throw new HttpError(400, '该分享不是文件夹');
    const folderId = url.searchParams.get('folderId') || item.id;
    if (!(await inSubtree(env, item.id, folderId))) throw new HttpError(403, '无权访问该目录');
    const { results: items } = await env.DB.prepare(
      `SELECT id, type, name, size, mime, updated_at FROM files
       WHERE parent_id = ? ORDER BY CASE type WHEN 'folder' THEN 0 ELSE 1 END, name COLLATE NOCASE LIMIT 2000`
    )
      .bind(folderId)
      .all();
    const full = await getFolderPath(env, folderId);
    const idx = full.findIndex((p) => p.id === item.id);
    const path = idx >= 0 ? full.slice(idx) : [{ id: item.id, name: item.name }];
    return json({ items, path, root: { id: item.id, name: item.name } });
  }

  if (sub === 'file' && method === 'GET' && (seg[5] === 'raw' || seg[5] === 'download')) {
    const fileId = seg[4];
    if (!(await inSubtree(env, item.id, fileId))) throw new HttpError(403, '无权访问该文件');
    if (seg[5] === 'download' && !request.headers.get('Range')) {
      ctx.waitUntil(env.DB.prepare('UPDATE shares SET downloads = downloads + 1 WHERE id = ?').bind(share.id).run());
    }
    return serveFile(request, env, fileId, seg[5]);
  }

  throw new HttpError(404, '接口不存在');
}

// ---------- 路由入口 ----------

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = request.method;
  try {
    if (seg[1] === 'pub') return await handlePub(request, env, ctx, url, seg, method);

    if (seg[1] === 'login' && method === 'POST' && seg.length === 2) return await login(request, env, ctx);

    const session = await auth.verifySession(request, env);
    if (!session) return json({ error: '未登录或会话已过期' }, 401);

    if (seg[1] === 'logout' && method === 'POST' && seg.length === 2) {
      return json({ ok: true }, 200, { 'Set-Cookie': auth.clearSessionCookie() });
    }
    if (seg[1] === 'me' && method === 'GET' && seg.length === 2) return await me(env);

    if (seg[1] === 'list' && method === 'GET' && seg.length === 2) return await listDir(request, env, url);
    if (seg[1] === 'search' && method === 'GET' && seg.length === 2) return await searchFiles(env, url);
    if (seg[1] === 'path' && method === 'GET' && seg.length === 2) {
      const folderId = url.searchParams.get('folderId');
      return json({ path: folderId ? await getFolderPath(env, folderId) : [] });
    }

    if (seg[1] === 'folder' && method === 'POST' && seg.length === 2) {
      const body = await readJson(request);
      const parentId = await requireFolder(env, body.parentId || null);
      const name = await uniqueName(env, parentId, validateName(body.name), null, true);
      const id = crypto.randomUUID();
      const now = Date.now();
      await env.DB.prepare("INSERT INTO files (id, type, name, parent_id, size, mime, r2_key, created_at, updated_at) VALUES (?, 'folder', ?, ?, 0, NULL, NULL, ?, ?)")
        .bind(id, name, parentId, now, now)
        .run();
      return json({ item: { id, type: 'folder', name, parent_id: parentId, size: 0, mime: null, created_at: now, updated_at: now } });
    }

    if (seg[1] === 'item' && seg.length === 3) {
      if (method === 'PATCH') {
        const row = await getItem(env, seg[2]);
        const body = await readJson(request);
        let name = row.name;
        let parentId = row.parent_id;
        if (body.name !== undefined) name = validateName(body.name);
        if (body.parentId !== undefined) parentId = body.parentId ? await requireFolder(env, body.parentId) : null;
        if (body.name === undefined && body.parentId === undefined) throw new HttpError(400, '没有需要修改的内容');

        if (body.parentId !== undefined) {
          if (parentId === seg[2]) throw new HttpError(400, '不能移动到自身');
          if (row.type === 'folder' && parentId && (await inSubtree(env, seg[2], parentId))) {
            throw new HttpError(400, '不能移动到自身子目录中');
          }
        }
        if ((body.parentId !== undefined && (row.parent_id || null) !== (parentId || null)) || name !== row.name) {
          if (await nameExists(env, parentId, name, seg[2])) throw new HttpError(409, '目标位置已存在同名项目');
        }
        await env.DB.prepare('UPDATE files SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?')
          .bind(name, parentId, Date.now(), seg[2])
          .run();
        return json({ ok: true });
      }
      if (method === 'DELETE') return await deleteItem(env, seg[2]);
    }

    if (seg[1] === 'upload') {
      if (seg[2] === 'init' && method === 'POST' && seg.length === 3) return await uploadInit(request, env, ctx);
      if (method === 'PUT' && seg.length === 5 && seg[3] === 'part') return await uploadPart(request, env, seg[2], seg[4]);
      if (seg[3] === 'complete' && method === 'POST' && seg.length === 4) return await uploadComplete(request, env, seg[2]);
      if (seg[3] === 'abort' && method === 'POST' && seg.length === 4) return await uploadAbort(env, seg[2]);
    }

    if (seg[1] === 'file' && method === 'GET' && seg.length === 4) {
      if (seg[3] === 'raw' || seg[3] === 'download') return await serveFile(request, env, seg[2], seg[3]);
    }

    if (seg[1] === 'share' && method === 'POST' && seg.length === 2) return await createShare(request, env);
    if (seg[1] === 'share' && method === 'DELETE' && seg.length === 3) {
      const r = await env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(seg[2]).run();
      if (!r.meta.changes) throw new HttpError(404, '分享不存在');
      return json({ ok: true });
    }
    if (seg[1] === 'shares' && method === 'GET' && seg.length === 2) return await listShares(env);

    throw new HttpError(404, '接口不存在');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error('API error:', e && (e.stack || e.message || e));
    return json({ error: '服务器内部错误' }, 500);
  }
}
