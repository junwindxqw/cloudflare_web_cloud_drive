// 网盘主应用
import { api, apiUrl, fmtSize, fmtDate, iconFor, fileKind, escapeHtml, toast, openModal, confirmDialog, promptDialog, debounce, copyText } from './common.js';

const $ = (sel, el = document) => el.querySelector(sel);

const state = {
  folderId: null,
  path: [],
  items: [],
  selection: new Set(),
  searchMode: false,
  view: localStorage.getItem('jd.view') || 'list',
  sortKey: localStorage.getItem('jd.sortKey') || 'name',
  sortDir: Number(localStorage.getItem('jd.sortDir') || 1),
  usage: null,
};

// ---------------- 启动 ----------------

let booted = false;

async function boot() {
  try {
    await refreshMe();
    renderMain();
    const m = location.hash.match(/^#\/folder\/([\w-]+)$/);
    await loadDir(m ? m[1] : null, { push: false });
  } catch {
    renderLogin();
  }
  booted = true;
}

window.addEventListener('jd:unauthorized', () => {
  renderLogin();
  if (booted) toast('登录已过期，请重新登录', 'err');
});

function renderLogin() {
  document.getElementById('app').innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login-form">
        <div class="login-logo"><svg viewBox="0 0 24 24"><path d="M6 4h5l2 3h5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg></div>
        <h1>JunDrive</h1>
        <div class="muted">基于 Cloudflare 的私有云盘</div>
        <input type="password" class="input" id="login-pw" placeholder="请输入访问密码" autocomplete="current-password" />
        <div class="login-err" id="login-err"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center" type="submit">登 录</button>
      </form>
      <div class="login-foot">Powered by Cloudflare Workers · R2 · D1</div>
    </div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#login-pw').value;
    $('#login-err').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: { password: pw } });
      await refreshMe();
      renderMain();
      loadDir(null, { push: false });
    } catch (err) {
      $('#login-err').textContent = err.message;
    }
  });
  $('#login-pw').focus();
}

// ---------------- 主界面骨架 ----------------

function renderMain() {
  document.getElementById('app').innerHTML = `
    <header class="topbar">
      <div class="brand"><svg viewBox="0 0 24 24"><path d="M6 4h5l2 3h5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg><span>JunDrive</span></div>
      <div class="searchbox">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input class="input" id="search-input" type="search" placeholder="搜索文件和文件夹" />
      </div>
      <span class="muted" id="usage-text" style="font-size:12.5px;flex:none"></span>
      <button class="avatar-btn" id="user-btn" title="菜单">J</button>
    </header>

    <div class="subbar">
      <div class="crumbs" id="crumbs"></div>
      <div class="toolbar" id="toolbar">
        <button class="btn" data-cmd="new-folder">📁 新建文件夹</button>
        <button class="btn" data-cmd="upload-file">⬆ 上传文件</button>
        <button class="btn" data-cmd="upload-folder">🗂 上传文件夹</button>
        <span class="spacer"></span>
        <button class="icon-btn" data-cmd="refresh" title="刷新">⟳</button>
        <button class="icon-btn" data-cmd="toggle-view" title="切换视图"></button>
      </div>
      <div id="batch-slot"></div>
    </div>

    <main class="main" id="main">
      <div id="list-container"></div>
    </main>

    <div class="fab-wrap" id="fab-wrap">
      <button class="fab" id="fab" title="操作">+</button>
      <div class="fab-actions" id="fab-actions">
        <button data-cmd="upload-file">⬆ 上传文件</button>
        <button data-cmd="upload-folder">🗂 上传文件夹</button>
        <button data-cmd="new-folder">📁 新建文件夹</button>
      </div>
    </div>

    <div class="upload-panel" id="upload-panel">
      <div class="up-head"><span>上传任务</span><span class="spacer"></span><button class="up-cancel" id="up-clear" title="清除已完成">✕</button></div>
      <div class="up-list" id="up-list"></div>
    </div>

    <input type="file" id="file-input" multiple hidden />
    <input type="file" id="dir-input" webkitdirectory multiple hidden />
  `;

  $('#toolbar [data-cmd="toggle-view"]').innerHTML = state.view === 'list' ? '▦' : '☰';
  $('#user-btn').addEventListener('click', (e) => showUserMenu(e.currentTarget));
  $('#fab').addEventListener('click', () => $('#fab-wrap').classList.toggle('open'));
  $('#file-input').addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';
  });
  $('#dir-input').addEventListener('change', (e) => {
    handleFolderPick(e.target.files);
    e.target.value = '';
  });
  $('#search-input').addEventListener('input', debounce(onSearchInput, 300));
  $('#up-clear').addEventListener('click', clearFinishedUploads);
  $('#main').addEventListener('click', onMainClick);
  $('#main').addEventListener('change', onMainChange);
  document.querySelectorAll('[data-cmd]').forEach((el) => el.addEventListener('click', () => runCmd(el.dataset.cmd)));
  setupDragDrop();

  window.removeEventListener('popstate', onPopState);
  window.addEventListener('popstate', onPopState);
  renderUploadPanel();
  updateUsageText();
}

function runCmd(cmd) {
  $('#fab-wrap')?.classList.remove('open');
  switch (cmd) {
    case 'new-folder':
      return createFolder();
    case 'upload-file':
      return $('#file-input').click();
    case 'upload-folder':
      return $('#dir-input').click();
    case 'refresh':
      return loadDir(state.folderId, { silent: true });
    case 'toggle-view': {
      state.view = state.view === 'list' ? 'grid' : 'list';
      localStorage.setItem('jd.view', state.view);
      $('#toolbar [data-cmd="toggle-view"]').innerHTML = state.view === 'list' ? '▦' : '☰';
      return renderList();
    }
  }
}

function onPopState() {
  const m = location.hash.match(/^#\/folder\/([\w-]+)$/);
  const target = m ? m[1] : null;
  if (target !== state.folderId) loadDir(target, { push: false });
}

// ---------------- 目录 ----------------

async function refreshMe() {
  const me = await api('/api/me');
  state.usage = me;
}

function updateUsageText() {
  const el = $('#usage-text');
  if (el && state.usage) el.textContent = `已用 ${fmtSize(state.usage.usage)}`;
}

async function loadDir(folderId, { push = true, silent = false } = {}) {
  try {
    if (!silent) $('#list-container').innerHTML = '<div class="boot-loading">加载中…</div>';
    const data = await api(`/api/list${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''}`);
    state.folderId = folderId;
    state.path = data.path;
    state.items = data.items;
    state.selection.clear();
    state.searchMode = false;
    if (push) history.pushState(null, '', folderId ? `#/folder/${folderId}` : '#/');
    renderCrumbs();
    renderList();
    renderBatchbar();
    refreshMe().then(updateUsageText).catch(() => {});
  } catch (e) {
    if (e.status === 404 && folderId) {
      toast('文件夹不存在，已返回根目录', 'err');
      return loadDir(null, { push: true });
    }
    toast(e.message, 'err');
  }
}

function renderCrumbs() {
  const el = $('#crumbs');
  if (!el) return;
  const parts = [`<button data-fid="" class="${state.folderId ? '' : 'current'}">全部文件</button>`];
  state.path.forEach((p, i) => {
    const isLast = i === state.path.length - 1;
    parts.push(`<span class="sep">/</span><button data-fid="${p.id}" class="${isLast ? 'current' : ''}">${escapeHtml(p.name)}</button>`);
  });
  el.innerHTML = parts.join('');
  el.querySelectorAll('[data-fid]').forEach((b) =>
    b.addEventListener('click', () => {
      clearSearch();
      loadDir(b.dataset.fid || null);
    })
  );
  const cur = el.querySelector('.current');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'end' });
}

function sortedItems() {
  const dir = state.sortDir;
  const key = state.sortKey;
  const arr = [...state.items];
  arr.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    let r = 0;
    if (key === 'name') r = a.name.localeCompare(b.name, 'zh-Hans-CN');
    else if (key === 'size') r = a.size - b.size;
    else r = a.updated_at - b.updated_at;
    return r * dir;
  });
  return arr;
}

function renderList() {
  const box = $('#list-container');
  if (!box) return;
  const items = sortedItems();
  if (!items.length) {
    box.innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 24 24"><path d="M6 4h5l2 3h5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>
        <p><b>${state.searchMode ? '没有匹配的结果' : '这里还是空的'}</b></p>
        <p>${state.searchMode ? '换个关键词试试' : '点击右上角或 + 按钮上传文件'}</p>
      </div>`;
    return;
  }
  if (state.view === 'grid') {
    box.innerHTML = `<div class="grid-wrap">${items.map(gridCardHtml).join('')}</div>`;
    box.querySelectorAll('.thumb img').forEach((img) =>
      img.addEventListener('error', () => img.remove(), { once: true })
    );
  } else {
    const arrow = (k) => (state.sortKey === k ? `<span class="arrow">${state.sortDir === 1 ? '▲' : '▼'}</span>` : '');
    box.innerHTML = `
      <div class="list-head">
        <input type="checkbox" class="row-check" id="check-all" ${state.selection.size && state.selection.size === items.length ? 'checked' : ''} title="全选" />
        <span class="sortable" data-sort="name">名称 ${arrow('name')}</span>
        <span class="cell-size sortable" data-sort="size">大小 ${arrow('size')}</span>
        <span class="cell-date sortable" data-sort="time">修改时间 ${arrow('time')}</span>
        <span></span>
      </div>
      ${items.map(rowHtml).join('')}`;
    box.querySelectorAll('[data-sort]').forEach((el) =>
      el.addEventListener('click', () => {
        const k = el.dataset.sort === 'time' ? 'time' : el.dataset.sort;
        if (state.sortKey === k) state.sortDir = -state.sortDir;
        else {
          state.sortKey = k;
          state.sortDir = 1;
        }
        localStorage.setItem('jd.sortKey', state.sortKey);
        localStorage.setItem('jd.sortDir', state.sortDir);
        renderList();
      })
    );
  }
}

function rowHtml(it) {
  const selected = state.selection.has(it.id);
  return `
    <div class="list-row ${selected ? 'selected' : ''}" data-id="${it.id}" data-type="${it.type}">
      <input type="checkbox" class="row-check" data-check="${it.id}" ${selected ? 'checked' : ''} />
      <div class="row-name">
        <div class="top">${iconFor(it)}<span class="name">${escapeHtml(it.name)}</span></div>
        <div class="row-sub">${it.type === 'folder' ? '文件夹' : fmtSize(it.size)} · ${fmtDate(it.updated_at)}</div>
      </div>
      <span class="cell-size">${it.type === 'folder' ? '—' : fmtSize(it.size)}</span>
      <span class="cell-date">${fmtDate(it.updated_at)}</span>
      <button class="icon-btn more-btn" data-more="${it.id}" title="更多">⋮</button>
    </div>`;
}

function gridCardHtml(it) {
  const selected = state.selection.has(it.id);
  const kind = fileKind(it);
  // 图片缩略图加载失败时自动移除 <img> 露出底层的类型图标
  const thumb =
    kind === 'image'
      ? `${iconFor(it, 44)}<img class="big" loading="lazy" src="/api/file/${it.id}/raw" alt="" />`
      : iconFor(it, 44);
  return `
    <div class="grid-card ${selected ? 'selected' : ''}" data-id="${it.id}" data-type="${it.type}">
      <input type="checkbox" class="row-check" data-check="${it.id}" ${selected ? 'checked' : ''} />
      <div class="thumb">${thumb}</div>
      <div class="g-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>
      <div class="g-meta"><span>${it.type === 'folder' ? '文件夹' : fmtSize(it.size)}</span></div>
      <button class="icon-btn more-btn" data-more="${it.id}" title="更多">⋮</button>
    </div>`;
}

// ---------------- 列表交互 ----------------

function getItem(id) {
  return state.items.find((i) => i.id === id);
}

function onMainClick(e) {
  const moreBtn = e.target.closest('[data-more]');
  if (moreBtn) {
    e.stopPropagation();
    const it = getItem(moreBtn.dataset.more);
    if (it) showItemMenu(it, moreBtn);
    return;
  }
  if (e.target.closest('[data-check]')) return; // 复选框由 change 事件处理
  const row = e.target.closest('[data-id]');
  if (row) {
    const it = getItem(row.dataset.id);
    if (!it) return;
    if (it.type === 'folder') loadDir(it.id);
    else openPreview(it);
  }
}

function onMainChange(e) {
  const check = e.target.closest('[data-check]');
  if (!check) return;
  const id = check.dataset.check;
  if (check.id === 'check-all') {
    if (check.checked) state.items.forEach((i) => state.selection.add(i.id));
    else state.selection.clear();
  } else if (check.checked) state.selection.add(id);
  else state.selection.delete(id);
  renderList();
  renderBatchbar();
}

function renderBatchbar() {
  const slot = $('#batch-slot');
  if (!slot) return;
  if (!state.selection.size) {
    slot.innerHTML = '';
    return;
  }
  const n = state.selection.size;
  const hasFile = state.items.some((i) => state.selection.has(i.id) && i.type === 'file');
  slot.innerHTML = `
    <div class="batchbar">
      <span class="count">已选 ${n} 项</span>
      ${hasFile ? '<button class="btn" data-batch="download">下载</button>' : ''}
      <button class="btn" data-batch="move">移动</button>
      <button class="btn btn-danger-weak" data-batch="delete">删除</button>
      <button class="btn" data-batch="all">全选</button>
      <button class="btn" data-batch="none">取消</button>
    </div>`;
  slot.querySelectorAll('[data-batch]').forEach((b) => b.addEventListener('click', () => runBatch(b.dataset.batch)));
}

async function runBatch(action) {
  const items = state.items.filter((i) => state.selection.has(i.id));
  if (action === 'all') {
    state.items.forEach((i) => state.selection.add(i.id));
    return renderList(), renderBatchbar();
  }
  if (action === 'none') {
    state.selection.clear();
    return renderList(), renderBatchbar();
  }
  if (action === 'download') {
    for (const it of items.filter((i) => i.type === 'file')) {
      const a = document.createElement('a');
      a.href = `/api/file/${it.id}/download`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 350));
    }
    return;
  }
  if (action === 'move') return openMoveDialog(items);
  if (action === 'delete') {
    const ok = await confirmDialog('删除确认', `确定删除选中的 ${items.length} 项吗？文件夹将被整体删除，此操作不可恢复。`);
    if (!ok) return;
    let fail = 0;
    for (const it of items) {
      try {
        await api(`/api/item/${it.id}`, { method: 'DELETE' });
      } catch {
        fail++;
      }
    }
    state.selection.clear();
    toast(fail ? `有 ${fail} 项删除失败` : '删除完成', fail ? 'err' : 'info');
    await loadDir(state.folderId, { push: false, silent: true });
  }
}

// ---------------- 操作菜单 ----------------

let activeMenu = null;
function closeMenu() {
  activeMenu?.remove();
  activeMenu = null;
  document.removeEventListener('click', onMenuDocClick, true);
}
function onMenuDocClick(e) {
  if (activeMenu && !activeMenu.contains(e.target)) closeMenu();
}
function showMenu(html, anchor) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu open';
  menu.innerHTML = html;
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x = Math.min(rect.left, window.innerWidth - mw - 10);
  let y = rect.bottom + 6;
  if (y + mh > window.innerHeight - 10) y = Math.max(10, rect.top - mh - 6);
  menu.style.left = `${Math.max(10, x)}px`;
  menu.style.top = `${y}px`;
  activeMenu = menu;
  setTimeout(() => document.addEventListener('click', onMenuDocClick, true), 0);
  return menu;
}

function showItemMenu(it, anchor) {
  const menu = showMenu(
    `<div class="menu-head">${escapeHtml(it.name)}</div>
     ${it.type === 'file' ? '<button data-act="preview">👁 预览</button>' : ''}
     ${it.type === 'file' ? '<button data-act="download">⬇ 下载</button>' : ''}
     <button data-act="share">🔗 分享</button>
     <button data-act="rename">✏️ 重命名</button>
     <button data-act="move">📂 移动</button>
     <button data-act="multi">☑ 加入多选</button>
     <button data-act="delete" class="danger">🗑 删除</button>`,
    anchor
  );
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closeMenu();
    if (act === 'preview') openPreview(it);
    if (act === 'download') {
      const a = document.createElement('a');
      a.href = `/api/file/${it.id}/download`;
      a.download = '';
      a.click();
    }
    if (act === 'share') openShareDialog(it);
    if (act === 'rename') renameItem(it);
    if (act === 'move') openMoveDialog([it]);
    if (act === 'multi') {
      state.selection.add(it.id);
      renderList();
      renderBatchbar();
    }
    if (act === 'delete') deleteItem(it);
  });
}

function showUserMenu(anchor) {
  const menu = showMenu(
    `<div class="menu-head">已用空间：${fmtSize(state.usage?.usage || 0)} · ${state.usage?.fileCount || 0} 个文件</div>
     <button data-act="shares">🔗 我的分享</button>
     <button data-act="logout" class="danger">🚪 退出登录</button>`,
    anchor
  );
  menu.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closeMenu();
    if (act === 'shares') openSharesDialog();
    if (act === 'logout') {
      try {
        await api('/api/logout', { method: 'POST' });
      } catch {}
      renderLogin();
    }
  });
}

async function createFolder() {
  const name = await promptDialog('新建文件夹', { placeholder: '文件夹名称', okText: '创建' });
  if (!name) return;
  try {
    await api('/api/folder', { method: 'POST', body: { name, parentId: state.folderId } });
    toast('文件夹已创建');
    await loadDir(state.folderId, { push: false, silent: true });
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function renameItem(it) {
  const name = await promptDialog('重命名', { value: it.name, okText: '保存' });
  if (!name || name === it.name) return;
  try {
    await api(`/api/item/${it.id}`, { method: 'PATCH', body: { name } });
    toast('已重命名');
    await loadDir(state.folderId, { push: false, silent: true });
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function deleteItem(it) {
  const ok = await confirmDialog('删除确认', it.type === 'folder' ? `确定删除文件夹「${it.name}」吗？其中所有内容将被删除，此操作不可恢复。` : `确定删除文件「${it.name}」吗？此操作不可恢复。`);
  if (!ok) return;
  try {
    await api(`/api/item/${it.id}`, { method: 'DELETE' });
    toast('已删除');
    await loadDir(state.folderId, { push: false, silent: true });
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------------- 分享 ----------------

function openShareDialog(it) {
  const m = openModal(`
    <div class="modal-body">
      <h3>分享「${escapeHtml(it.name)}」</h3>
      <div class="field">
        <label>访问密码（可选）</label>
        <input class="input" id="share-pw" type="text" placeholder="留空则无需密码" maxlength="128" />
      </div>
      <div class="field">
        <label>有效期</label>
        <select class="input" id="share-exp">
          <option value="0">永久有效</option>
          <option value="1">1 天</option>
          <option value="7" selected>7 天</option>
          <option value="30">30 天</option>
        </select>
      </div>
      <div id="share-result"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>关闭</button>
      <button class="btn btn-primary" id="share-create">创建链接</button>
    </div>`);
  m.querySelector('#share-create').addEventListener('click', async () => {
    const btn = m.querySelector('#share-create');
    btn.disabled = true;
    try {
      const res = await api('/api/share', {
        method: 'POST',
        body: { fileId: it.id, password: m.querySelector('#share-pw').value || null, expireDays: Number(m.querySelector('#share-exp').value) },
      });
      m.querySelector('#share-result').innerHTML = `
        <div class="share-result">
          <div class="muted" style="margin-bottom:8px;font-size:13px">分享链接已创建：</div>
          <div class="link-row">
            <span class="link">${escapeHtml(res.url)}</span>
            <button class="btn" id="share-copy">复制</button>
          </div>
        </div>`;
      m.querySelector('#share-copy').addEventListener('click', async () => {
        try {
          await copyText(res.url);
          toast('链接已复制');
        } catch {
          toast('复制失败，请手动复制', 'err');
        }
      });
      toast('分享链接已创建');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

function openSharesDialog() {
  const m = openModal(`
    <div class="modal-body">
      <h3>我的分享</h3>
      <div id="shares-list"><div class="boot-loading">加载中…</div></div>
    </div>
    <div class="modal-foot"><button class="btn" data-close>关闭</button></div>`);
  const load = async () => {
    try {
      const { shares } = await api('/api/shares');
      const box = m.querySelector('#shares-list');
      if (!shares.length) {
        box.innerHTML = '<p class="muted" style="text-align:center;padding:20px 0">还没有创建过分享</p>';
        return;
      }
      box.innerHTML = shares
        .map(
          (s) => `
        <div class="share-item">
          <div class="si-top">
            ${s.fileType ? iconFor({ type: s.fileType, name: s.fileName || '', mime: '' }, 18) : ''}
            <span class="si-name">${escapeHtml(s.fileName || '（原文件已删除）')}</span>
          </div>
          <div class="si-meta">
            <span>${s.hasPassword ? '🔒 需密码' : '🔓 无密码'}</span>
            <span>有效期至：${s.expiresAt ? fmtDate(s.expiresAt) : '永久'}</span>
            <span>下载 ${s.downloads} 次</span>
          </div>
          <div class="si-actions">
            <button class="btn" data-copy="${s.token}" ${s.fileName ? '' : 'disabled'}>复制链接</button>
            <a class="btn" href="/s/${s.token}" target="_blank" rel="noopener" ${s.fileName ? '' : 'hidden'}>打开</a>
            <button class="btn btn-danger-weak" data-del="${s.id}">取消分享</button>
          </div>
        </div>`
        )
        .join('');
      box.querySelectorAll('[data-copy]').forEach((b) =>
        b.addEventListener('click', async () => {
          try {
            await copyText(`${location.origin}/s/${b.dataset.copy}`);
            toast('链接已复制');
          } catch {
            toast('复制失败', 'err');
          }
        })
      );
      box.querySelectorAll('[data-del]').forEach((b) =>
        b.addEventListener('click', async () => {
          const ok = await confirmDialog('取消分享', '取消后链接立即失效，确定吗？', { okText: '取消分享' });
          if (!ok) return;
          try {
            await api(`/api/share/${b.dataset.del}`, { method: 'DELETE' });
            toast('已取消分享');
            load();
          } catch (e) {
            toast(e.message, 'err');
          }
        })
      );
    } catch (e) {
      m.querySelector('#shares-list').innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
    }
  };
  load();
}

// ---------------- 移动 ----------------

function openMoveDialog(items) {
  const m = openModal(`
    <div class="modal-body">
      <h3>移动 ${items.length} 项到…</h3>
      <div class="move-path" id="move-path"></div>
      <div class="move-list" id="move-list"><div class="boot-loading">加载中…</div></div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>取消</button>
      <button class="btn btn-primary" id="move-ok">移动到此处</button>
    </div>`);
  const exclude = new Set(items.map((i) => i.id));
  let current = { id: null, name: '全部文件' };
  const trail = [{ id: null, name: '全部文件' }];

  const renderPath = () => {
    const el = m.querySelector('#move-path');
    el.innerHTML = trail
      .map((p, i) => `<button data-i="${i}" class="${i === trail.length - 1 ? 'current' : ''}" style="border:none;background:none;cursor:pointer;padding:4px 6px;border-radius:6px;${i === trail.length - 1 ? 'font-weight:600;' : 'color:var(--muted);'}">${escapeHtml(p.name)}</button>`)
      .join('<span class="sep" style="color:var(--muted)">/</span>');
    el.querySelectorAll('[data-i]').forEach((b) =>
      b.addEventListener('click', () => {
        trail.length = Number(b.dataset.i) + 1;
        current = trail[trail.length - 1];
        loadFolders();
      })
    );
  };

  const loadFolders = async () => {
    renderPath();
    const list = m.querySelector('#move-list');
    list.innerHTML = '<div class="boot-loading">加载中…</div>';
    try {
      const data = await api(`/api/list${current.id ? `?folderId=${current.id}` : ''}`);
      const folders = data.items.filter((i) => i.type === 'folder' && !exclude.has(i.id));
      const upBtn = current.id ? `<button class="move-item" data-up>↩️ <span class="name">返回上一级</span></button>` : '';
      list.innerHTML =
        upBtn +
        (folders.length
          ? folders.map((f) => `<button class="move-item" data-fid="${f.id}">${iconFor(f, 20)}<span class="name">${escapeHtml(f.name)}</span><span class="muted">›</span></button>`).join('')
          : upBtn
            ? ''
            : '<div class="move-empty">此文件夹下没有子文件夹</div>');
      list.querySelector('[data-up]')?.addEventListener('click', () => {
        trail.pop();
        current = trail[trail.length - 1];
        loadFolders();
      });
      list.querySelectorAll('[data-fid]').forEach((b) =>
        b.addEventListener('click', () => {
          const f = folders.find((x) => x.id === b.dataset.fid);
          trail.push({ id: f.id, name: f.name });
          current = trail[trail.length - 1];
          loadFolders();
        })
      );
    } catch (e) {
      list.innerHTML = `<div class="move-empty">${escapeHtml(e.message)}</div>`;
    }
  };
  loadFolders();

  m.querySelector('#move-ok').addEventListener('click', async () => {
    const btn = m.querySelector('#move-ok');
    btn.disabled = true;
    let fail = 0;
    for (const it of items) {
      try {
        await api(`/api/item/${it.id}`, { method: 'PATCH', body: { parentId: current.id } });
      } catch {
        fail++;
      }
    }
    m.close();
    toast(fail ? `${fail} 项移动失败` : `已移动 ${items.length - fail} 项`, fail ? 'err' : 'info');
    state.selection.clear();
    await loadDir(state.folderId, { push: false, silent: true });
  });
}

// ---------------- 搜索 ----------------

function onSearchInput(e) {
  const q = e.target.value.trim();
  if (!q) return clearSearch(true);
  doSearch(q);
}

function clearSearch(reload = false) {
  const input = $('#search-input');
  if (input && input.value) input.value = '';
  if (state.searchMode || reload) loadDir(state.folderId, { push: false, silent: !state.searchMode && reload });
}

async function doSearch(q) {
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    state.searchMode = true;
    state.items = data.items;
    state.selection.clear();
    const el = $('#crumbs');
    if (el) {
      el.innerHTML = `<button class="current">搜索：${escapeHtml(q)}（${data.items.length} 条结果）</button>`;
    }
    renderList();
    renderBatchbar();
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------------- 预览 ----------------

const TEXT_EXTS = ['txt', 'md', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'ini', 'conf', 'toml', 'js', 'ts', 'jsx', 'tsx', 'html', 'htm', 'css', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'sh', 'sql', 'php', 'rb', 'swift', 'kt'];

function openPreview(it) {
  const kind = fileKind(it);
  const raw = `/api/file/${it.id}/raw`;
  let bodyHtml;
  if (kind === 'image') bodyHtml = `<img src="${raw}" alt="${escapeHtml(it.name)}" />`;
  else if (kind === 'video') bodyHtml = `<video src="${raw}" controls autoplay playsinline></video>`;
  else if (kind === 'audio') bodyHtml = `<div style="text-align:center;width:100%"><p style="color:#cbd5e1">${escapeHtml(it.name)}</p><audio src="${raw}" controls autoplay></audio></div>`;
  else if (kind === 'pdf') bodyHtml = `<iframe src="${raw}" title="${escapeHtml(it.name)}"></iframe>`;
  else if (kind === 'text' || kind === 'code' || (TEXT_EXTS.includes(it.name.split('.').pop().toLowerCase()) && it.size < 2 * 1024 * 1024)) {
    if (it.size >= 2 * 1024 * 1024) bodyHtml = fallbackHtml('文本文件过大，请下载后查看');
    else {
      bodyHtml = `<pre id="pv-text">加载中…</pre>`;
      fetch(apiUrl(raw))
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error('加载失败'))))
        .then((t) => {
          const pre = document.getElementById('pv-text');
          if (pre) pre.textContent = t;
        })
        .catch(() => {
          const pre = document.getElementById('pv-text');
          if (pre) pre.textContent = '加载失败';
        });
    }
  } else bodyHtml = fallbackHtml('该类型暂不支持在线预览');

  function fallbackHtml(msg) {
    return `<div class="preview-fallback">${iconFor(it, 64)}<p>${msg}</p><button class="btn btn-primary" data-dl>下载文件</button></div>`;
  }

  const bd = document.createElement('div');
  bd.className = 'preview-backdrop';
  bd.innerHTML = `
    <div class="preview-head">
      ${iconFor(it, 20)}
      <span class="pv-name">${escapeHtml(it.name)}</span>
      <button data-dl>下载</button>
      <button data-close>关闭</button>
    </div>
    <div class="preview-body">${bodyHtml}</div>`;
  bd.querySelector('[data-close]').addEventListener('click', () => {
    bd.remove();
    document.removeEventListener('keydown', onKey);
  });
  bd.querySelector('[data-dl]').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = `/api/file/${it.id}/download`;
    a.download = '';
    a.click();
  });
  const onKey = (e) => {
    if (e.key === 'Escape') {
      bd.remove();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bd);
}

// ---------------- 上传 ----------------

const uploadTasks = [];
let activeUploads = 0;
const MAX_CONCURRENT = 2;
let uploadSeq = 0;

function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (!files.every((f) => f.size < 8 * 1024 * 1024 * 1000)) toast('单个文件最大 8GB', 'err');
  for (const f of files) queueUpload(f, state.folderId);
}

async function handleFolderPick(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  // 依据 webkitRelativePath 重建目录结构
  const dirMap = new Map(); // 'a/b' -> folderId
  dirMap.set('', state.folderId);
  const ensureDir = async (dirPath) => {
    if (dirMap.has(dirPath)) return dirMap.get(dirPath);
    const idx = dirPath.lastIndexOf('/');
    const parentPath = idx < 0 ? '' : dirPath.slice(0, idx);
    const name = idx < 0 ? dirPath : dirPath.slice(idx + 1);
    const parentId = await ensureDir(parentPath);
    const res = await api('/api/folder', { method: 'POST', body: { name, parentId } });
    dirMap.set(dirPath, res.item.id);
    return res.item.id;
  };
  toast(`开始上传 ${files.length} 个文件`);
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name;
    const idx = rel.lastIndexOf('/');
    const dirPath = idx < 0 ? '' : rel.slice(0, idx);
    try {
      const parentId = dirPath ? await ensureDir(dirPath) : state.folderId;
      queueUpload(f, parentId);
    } catch (e) {
      toast(`创建文件夹失败：${e.message}`, 'err');
    }
  }
}

function queueUpload(file, parentId) {
  const task = {
    seq: ++uploadSeq,
    file,
    parentId,
    uploadId: null,
    sent: 0,
    total: file.size,
    status: '等待中',
    err: null,
    aborted: false,
  };
  uploadTasks.push(task);
  renderUploadPanel();
  pump();
}

function pump() {
  while (activeUploads < MAX_CONCURRENT) {
    const task = uploadTasks.find((t) => t.status === '等待中');
    if (!task) return;
    task.status = '上传中';
    activeUploads++;
    runUpload(task).finally(() => {
      activeUploads--;
      pump();
    });
  }
}

async function runUpload(task) {
  try {
    const init = await api('/api/upload/init', {
      method: 'POST',
      body: { name: task.file.name, size: task.file.size, mime: task.file.type || null, parentId: task.parentId },
    });
    task.uploadId = init.uploadId;
    if (task.aborted) throw Object.assign(new Error('已取消'), { aborted: true });
    const partSize = init.partSize;
    const total = Math.ceil(task.file.size / partSize);
    const parts = [];
    for (let n = 1; n <= total; n++) {
      if (task.aborted) throw Object.assign(new Error('已取消'), { aborted: true });
      const start = (n - 1) * partSize;
      const chunk = task.file.slice(start, Math.min(start + partSize, task.file.size));
      let etag = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await fetch(apiUrl(`/api/upload/${init.uploadId}/part/${n}`), { method: 'PUT', body: chunk });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `分片上传失败 (${res.status})`);
          }
          etag = (await res.json()).etag;
          break;
        } catch (e) {
          if (attempt === 2) throw e;
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
      parts.push({ partNumber: n, etag });
      task.sent = Math.min(start + partSize, task.file.size);
      renderUploadPanel();
    }
    task.status = '合并中';
    renderUploadPanel();
    await api(`/api/upload/${init.uploadId}/complete`, { method: 'POST', body: { parts } });
    task.status = '完成';
    task.sent = task.total;
    refreshMe().then(updateUsageText).catch(() => {});
    if (!state.searchMode) loadDir(state.folderId, { push: false, silent: true });
  } catch (e) {
    if (task.aborted) {
      task.status = '已取消';
      if (task.uploadId) api(`/api/upload/${task.uploadId}/abort`, { method: 'POST' }).catch(() => {});
    } else {
      task.status = '失败';
      task.err = e.message;
      if (task.uploadId) api(`/api/upload/${task.uploadId}/abort`, { method: 'POST' }).catch(() => {});
    }
  }
  renderUploadPanel();
}

function renderUploadPanel() {
  const panel = $('#upload-panel');
  if (!panel) return;
  const active = uploadTasks.filter((t) => ['等待中', '上传中', '合并中'].includes(t.status));
  panel.classList.toggle('open', uploadTasks.length > 0);
  const list = $('#up-list');
  list.innerHTML = [...uploadTasks]
    .reverse()
    .slice(0, 30)
    .map((t) => {
      const pct = t.total ? Math.min(100, Math.round((t.sent / t.total) * 100)) : 100;
      const statusCls = t.status === '失败' ? 'err' : t.status === '完成' ? 'ok' : '';
      const statusText =
        t.status === '上传中'
          ? `${pct}% · ${fmtSize(t.sent)}/${fmtSize(t.total)}`
          : t.status === '失败'
            ? `失败：${t.err || ''}`
            : t.status === '完成'
              ? '完成 ✓'
              : t.status;
      return `
      <div class="up-item">
        <div class="up-top">
          <span class="up-name" title="${escapeHtml(t.file.name)}">${escapeHtml(t.file.name)}</span>
          ${t.status === '完成' ? '' : `<button class="up-cancel" data-cancel="${t.seq}" title="取消">✕</button>`}
          <span class="up-status ${statusCls}">${statusText}</span>
        </div>
        <div class="progress"><div style="width:${t.status === '完成' ? 100 : pct}%"></div></div>
      </div>`;
    })
    .join('');
  list.querySelectorAll('[data-cancel]').forEach((b) =>
    b.addEventListener('click', () => {
      const task = uploadTasks.find((t) => t.seq === Number(b.dataset.cancel));
      if (task) {
        task.aborted = true;
        if (task.status === '等待中') {
          task.status = '已取消';
          renderUploadPanel();
        }
      }
    })
  );
}

function clearFinishedUploads() {
  for (let i = uploadTasks.length - 1; i >= 0; i--) {
    if (['完成', '失败', '已取消'].includes(uploadTasks[i].status)) uploadTasks.splice(i, 1);
  }
  if (!uploadTasks.length) $('#upload-panel').classList.remove('open');
  renderUploadPanel();
}

// ---------------- 拖拽上传（PC） ----------------

function setupDragDrop() {
  const main = $('#main');
  let dragDepth = 0;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:150;display:none;align-items:center;justify-content:center;background:rgba(37,99,235,.15);backdrop-filter:blur(2px);pointer-events:none;';
  overlay.innerHTML = '<div style="background:var(--card);border:2px dashed var(--primary);border-radius:16px;padding:30px 50px;font-size:17px;font-weight:600">松开鼠标上传到当前目录</div>';
  document.body.appendChild(overlay);
  window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
      dragDepth++;
      overlay.style.display = 'flex';
    }
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      overlay.style.display = 'none';
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.style.display = 'none';
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });
}

boot();
