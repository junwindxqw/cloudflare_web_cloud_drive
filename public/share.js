// 公开分享页 /s/<token>
import { api, fmtSize, fmtDate, iconFor, fileKind, escapeHtml, toast, openModal, copyText } from './common.js';

const token = location.pathname.split('/')[2] || '';
const app = document.getElementById('app');

const LOGO = `<svg viewBox="0 0 24 24"><path d="M6 4h5l2 3h5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>`;

function shell(inner) {
  app.innerHTML = `
    <div class="share-page">
      <div class="share-top">${LOGO}<span>JunDrive 分享</span></div>
      <div class="share-main">${inner}</div>
    </div>`;
}

function stateCard(icon, title, desc) {
  return `
    <div class="share-card">
      <div class="state-card">
        <svg viewBox="0 0 24 24"><path d="M6 4h5l2 3h5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>
        <p><b style="color:var(--fg)">${escapeHtml(title)}</b></p>
        ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
      </div>
    </div>`;
}

function errCard(e) {
  if (e.status === 404) return stateCard('gone', '分享不存在', '链接可能已被取消，或输入有误');
  if (e.status === 410) return stateCard('expired', '分享已过期', '该分享链接已超过有效期');
  return stateCard('error', '无法打开分享', e.message);
}

// 从链接中提取附带提取码：支持 ?pwd=xxx 与 #pwd=xxx（百度网盘式自动注入）
function getUrlPwd() {
  const q = new URLSearchParams(location.search).get('pwd');
  if (q) return q.trim();
  const m = location.hash.match(/^#pwd=([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

async function boot() {
  if (!token) return shell(stateCard('gone', '分享不存在', '链接不完整'));
  try {
    const meta = await api(`/api/pub/${encodeURIComponent(token)}`);
    if (meta.needsPassword) {
      const linkPwd = getUrlPwd();
      if (linkPwd) {
        // 自动注入：静默尝试链接中携带的提取码，失败则回退手动输入
        try {
          await api(`/api/pub/${encodeURIComponent(token)}/verify`, { method: 'POST', body: { password: linkPwd } });
          history.replaceState(null, '', location.pathname); // 通过后从地址栏移除提取码
          return renderContent(await api(`/api/pub/${encodeURIComponent(token)}`));
        } catch {}
      }
      return renderPassword(linkPwd);
    }
    renderContent(meta);
  } catch (e) {
    shell(errCard(e));
  }
}

function renderPassword(prefill = '') {
  shell(`
    <div class="share-card">
      <div class="sc-title">${iconFor({ type: 'file', name: 'lock' }, 26)}<div class="name">此分享已加密</div></div>
      <p class="sc-meta" style="padding-left:0">请输入访问密码查看内容</p>
      <form class="pw-form" id="pw-form">
        <input class="input" id="pw-input" type="text" placeholder="访问密码" autocomplete="off" value="${escapeHtml(prefill)}" />
        <button class="btn btn-primary" type="submit">查看</button>
      </form>
      <p class="muted" id="pw-err" style="color:var(--danger);min-height:18px;margin:10px 0 0">${prefill ? '链接中的提取码无效，请手动输入' : ''}</p>
    </div>`);
  $('#pw-input').focus();
  $('#pw-input').select();
  document.getElementById('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await api(`/api/pub/${encodeURIComponent(token)}/verify`, { method: 'POST', body: { password: document.getElementById('pw-input').value } });
      const meta = await api(`/api/pub/${encodeURIComponent(token)}`);
      renderContent(meta);
    } catch (err) {
      document.getElementById('pw-err').textContent = err.message;
      btn.disabled = false;
    }
  });
}

function renderContent(meta) {
  if (meta.type === 'folder') {
    renderFolder(meta);
  } else {
    renderFile(meta);
  }
}

function renderFile(meta) {
  const kind = fileKind({ type: 'file', name: meta.name, mime: meta.mime });
  shell(`
    <div class="share-card">
      <div class="sc-title">${iconFor({ type: 'file', name: meta.name, mime: meta.mime }, 26)}<div class="name">${escapeHtml(meta.name)}</div></div>
      <div class="sc-meta">${fmtSize(meta.size)}</div>
      <div class="sc-actions">
        <a class="btn btn-primary" id="dl-btn" href="/api/pub/${encodeURIComponent(token)}/file/${meta.id}/download">⬇ 下载文件</a>
      </div>
      ${kind === 'image' ? `<div class="share-img-preview"><img src="/api/pub/${encodeURIComponent(token)}/file/${meta.id}/raw" alt="${escapeHtml(meta.name)}" /></div>` : ''}
    </div>`);
  document.getElementById('dl-btn').addEventListener('click', () => toast('开始下载…'));
}

function renderFolder(rootMeta) {
  let currentFolderId = rootMeta.id;
  shell(`
    <div class="share-card">
      <div class="sc-title">${iconFor({ type: 'folder' }, 26)}<div class="name">${escapeHtml(rootMeta.name)}</div></div>
      <div class="sc-meta">文件夹分享</div>
      <div class="share-sub">
        <div class="sub-head">
          <div class="crumbs" id="share-crumbs" style="padding:0"></div>
        </div>
        <div class="share-list" id="share-list"><div class="boot-loading">加载中…</div></div>
      </div>
    </div>`);

  const loadFolder = async (folderId) => {
    const list = document.getElementById('share-list');
    list.innerHTML = '<div class="boot-loading">加载中…</div>';
    try {
      const data = await api(`/api/pub/${encodeURIComponent(token)}/list${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''}`);
      currentFolderId = data.path.length ? data.path[data.path.length - 1].id : rootMeta.id;
      // 面包屑
      const crumbs = document.getElementById('share-crumbs');
      crumbs.innerHTML = data.path
        .map((p, i) => `<button data-fid="${p.id}" class="${i === data.path.length - 1 ? 'current' : ''}">${escapeHtml(p.name)}</button>${i < data.path.length - 1 ? '<span class="sep">/</span>' : ''}`)
        .join('');
      crumbs.querySelectorAll('[data-fid]').forEach((b) => b.addEventListener('click', () => loadFolder(b.dataset.fid)));
      // 列表
      if (!data.items.length) {
        list.innerHTML = '<div class="move-empty">空文件夹</div>';
        return;
      }
      list.innerHTML = data.items
        .map(
          (it) => `
        <div class="list-row" style="grid-template-columns:minmax(0,1fr) auto" data-id="${it.id}" data-type="${it.type}">
          <div class="row-name">
            <div class="top">${iconFor(it)}<span class="name">${escapeHtml(it.name)}</span></div>
            <div class="row-sub">${it.type === 'folder' ? '文件夹' : fmtSize(it.size)} · ${fmtDate(it.updated_at)}</div>
          </div>
          ${it.type === 'file' ? `<a class="btn" style="flex:none" href="/api/pub/${encodeURIComponent(token)}/file/${it.id}/download">下载</a>` : '<span class="muted" style="flex:none;padding-right:8px">›</span>'}
        </div>`
        )
        .join('');
      list.querySelectorAll('.list-row').forEach((row) =>
        row.addEventListener('click', (e) => {
          if (e.target.closest('a')) return; // 下载链接直接走默认行为
          const it = data.items.find((x) => x.id === row.dataset.id);
          if (it && it.type === 'folder') loadFolder(it.id);
        })
      );
    } catch (e) {
      list.innerHTML = `<div class="move-empty">${escapeHtml(e.message)}</div>`;
    }
  };
  loadFolder(rootMeta.id);
}

const $ = (sel) => document.querySelector(sel);
boot();
