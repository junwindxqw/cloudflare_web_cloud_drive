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
    renderAuth();
  }
  booted = true;
}

window.addEventListener('jd:unauthorized', () => {
  // 已在认证页（未登录）时不重渲染，避免覆盖用户当前所在的登录/注册/找回视图
  if (document.getElementById('auth-view')) {
    if (booted) toast('登录已过期，请重新登录', 'err');
    return;
  }
  renderAuth('login');
  if (booted) toast('登录已过期，请重新登录', 'err');
});

// ---------------- 认证（登录 / 注册 / 找回密码） ----------------

const AUTH_HASH = { '#/login': 'login', '#/register': 'register', '#/forgot': 'forgot' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function renderAuth(view = AUTH_HASH[location.hash] || 'login') {
  clearInterval(authCountdown.timer);
  history.replaceState(null, '', `#/${view}`);
  document.getElementById('app').innerHTML = `
    <div class="login-wrap">
      <div class="login-card auth-card">
        <div class="login-logo"><svg viewBox="0 0 24 24"><path d="M6 4h5l2 3h5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg></div>
        <h1>JunDrive</h1>
        <div class="muted">基于 Cloudflare 的私有云盘</div>
        <nav class="auth-tabs" id="auth-tabs">
          <button type="button" data-view="login" class="${view === 'login' ? 'active' : ''}">登录</button>
          <button type="button" data-view="register" class="${view === 'register' ? 'active' : ''}">注册</button>
          <button type="button" data-view="forgot" class="${view === 'forgot' ? 'active' : ''}">找回密码</button>
        </nav>
        <div id="auth-view"></div>
      </div>
      <div class="login-foot">Powered by Cloudflare Workers · R2 · D1 · Resend</div>
    </div>`;

  document.getElementById('auth-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn && !btn.classList.contains('active')) renderAuth(btn.dataset.view);
  });
  renderAuthView(view);
}

const PW_EYE = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';

// 通用：带可见性切换的密码输入框
function pwField(id, placeholder, autocomplete = 'new-password') {
  return `
    <div class="pw-input-wrap">
      <input type="password" class="input" id="${id}" placeholder="${placeholder}" autocomplete="${autocomplete}" />
      <button type="button" class="pw-eye" data-eye="${id}" title="显示/隐藏密码">${PW_EYE}</button>
    </div>`;
}

// 通用：邮箱 + 验证码行（含获取按钮倒计时）
function codeField() {
  return `
    <div class="code-row">
      <input type="text" class="input" id="auth-code" placeholder="6 位验证码" inputmode="numeric" maxlength="6" autocomplete="one-time-code" />
      <button type="button" class="btn" id="auth-send">获取验证码</button>
    </div>`;
}

function bindPwEyes(root) {
  root.querySelectorAll('[data-eye]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.eye);
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.classList.toggle('on', input.type === 'text');
    })
  );
}

const authCountdown = { timer: null, left: 0 };
function startCodeCountdown() {
  authCountdown.left = 60;
  paintCountdown();
  clearInterval(authCountdown.timer);
  authCountdown.timer = setInterval(() => {
    authCountdown.left--;
    paintCountdown();
    if (authCountdown.left <= 0) clearInterval(authCountdown.timer);
  }, 1000);
}
function paintCountdown() {
  const btn = document.getElementById('auth-send');
  if (!btn) return;
  if (authCountdown.left > 0) {
    btn.disabled = true;
    btn.textContent = `${authCountdown.left}s 后重发`;
  } else {
    btn.disabled = false;
    btn.textContent = '获取验证码';
  }
}

// 通用：发送验证码（purpose: register / reset / login）
async function sendAuthCode(purpose) {
  const err = document.getElementById('auth-err');
  err.textContent = '';
  const email = document.getElementById('auth-email').value.trim();
  if (!EMAIL_RE.test(email)) {
    err.textContent = '请输入正确的邮箱地址';
    return false;
  }
  const btn = document.getElementById('auth-send');
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    await api('/api/auth/send-code', { method: 'POST', body: { email, purpose } });
    toast(`验证码已发送至 ${email}`, 'ok', 6000);
    startCodeCountdown();
    document.getElementById('auth-code').focus();
    return true;
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false;
    btn.textContent = '获取验证码';
    return false;
  }
}

function authBusy(btn, busy) {
  btn.disabled = busy;
  btn.style.opacity = busy ? '0.6' : '';
}

function renderAuthView(view) {
  const box = document.getElementById('auth-view');
  const foot = (text, target, targetText) =>
    `<div class="auth-foot">${text}<button type="button" class="link-btn" data-goto="${target}">${targetText}</button></div>`;

  if (view === 'login') {
    box.innerHTML = `
      <form id="auth-form" novalidate>
        <input type="email" class="input" id="auth-email" placeholder="邮箱地址" autocomplete="email" />
        <div id="auth-pw-block">
          ${pwField('auth-password', '密码', 'current-password')}
          <div class="auth-row">
            <button type="button" class="link-btn" id="auth-mode-code">使用验证码登录</button>
            <button type="button" class="link-btn" data-goto="forgot">忘记密码？</button>
          </div>
        </div>
        <div id="auth-code-block" style="display:none">
          ${codeField()}
          <div class="auth-row">
            <button type="button" class="link-btn" id="auth-mode-pw">使用密码登录</button>
            <span class="muted" style="font-size:12px">未注册的邮箱将自动创建账号</span>
          </div>
        </div>
        <div class="auth-err" id="auth-err"></div>
        <button class="btn btn-primary auth-submit" type="submit" id="auth-submit">登 录</button>
      </form>
      ${foot('没有账号？', 'register', '立即注册')}`;
    bindPwEyes(box);
    let mode = 'password';
    const switchMode = (m) => {
      mode = m;
      document.getElementById('auth-pw-block').style.display = m === 'password' ? '' : 'none';
      document.getElementById('auth-code-block').style.display = m === 'code' ? '' : 'none';
      document.getElementById('auth-err').textContent = '';
      document.getElementById('auth-submit').textContent = m === 'password' ? '登 录' : '验证码登录';
    };
    document.getElementById('auth-mode-code').addEventListener('click', () => switchMode('code'));
    document.getElementById('auth-mode-pw').addEventListener('click', () => switchMode('password'));
    document.getElementById('auth-send').addEventListener('click', () => sendAuthCode('login'));

    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('auth-err');
      err.textContent = '';
      const email = document.getElementById('auth-email').value.trim();
      if (!EMAIL_RE.test(email)) return (err.textContent = '请输入正确的邮箱地址');
      const submit = document.getElementById('auth-submit');
      authBusy(submit, true);
      try {
        if (mode === 'password') {
          const password = document.getElementById('auth-password').value;
          if (!password) return (err.textContent = '请输入密码'), authBusy(submit, false);
          await api('/api/auth/login', { method: 'POST', body: { email, password } });
        } else {
          const code = document.getElementById('auth-code').value.trim();
          if (!/^\d{6}$/.test(code)) return (err.textContent = '请输入 6 位数字验证码'), authBusy(submit, false);
          await api('/api/auth/verify', { method: 'POST', body: { email, code } });
        }
        await enterApp();
      } catch (e2) {
        err.textContent = e2.message;
      } finally {
        authBusy(submit, false);
      }
    });
  } else if (view === 'register') {
    box.innerHTML = `
      <form id="auth-form" novalidate>
        <input type="email" class="input" id="auth-email" placeholder="邮箱地址" autocomplete="email" />
        ${codeField()}
        ${pwField('auth-password', '设置密码（8 位以上，含字母和数字）')}
        ${pwField('auth-password2', '确认密码')}
        <div class="auth-err" id="auth-err"></div>
        <button class="btn btn-primary auth-submit" type="submit" id="auth-submit">注册并登录</button>
      </form>
      ${foot('已有账号？', 'login', '直接登录')}`;
    bindPwEyes(box);
    document.getElementById('auth-send').addEventListener('click', () => sendAuthCode('register'));
    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('auth-err');
      err.textContent = '';
      const email = document.getElementById('auth-email').value.trim();
      const code = document.getElementById('auth-code').value.trim();
      const password = document.getElementById('auth-password').value;
      const password2 = document.getElementById('auth-password2').value;
      if (!EMAIL_RE.test(email)) return (err.textContent = '请输入正确的邮箱地址');
      if (!/^\d{6}$/.test(code)) return (err.textContent = '请输入 6 位数字验证码');
      if (password.length < 8 || password.length > 128) return (err.textContent = '密码长度需为 8-128 位');
      if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return (err.textContent = '密码需同时包含字母和数字');
      if (password !== password2) return (err.textContent = '两次输入的密码不一致');
      const submit = document.getElementById('auth-submit');
      authBusy(submit, true);
      try {
        await api('/api/auth/register', { method: 'POST', body: { email, code, password } });
        await enterApp();
      } catch (e2) {
        err.textContent = e2.message;
      } finally {
        authBusy(submit, false);
      }
    });
  } else {
    box.innerHTML = `
      <form id="auth-form" novalidate>
        <input type="email" class="input" id="auth-email" placeholder="注册时使用的邮箱" autocomplete="email" />
        ${codeField()}
        ${pwField('auth-password', '新密码（8 位以上，含字母和数字）')}
        ${pwField('auth-password2', '确认新密码')}
        <div class="auth-err" id="auth-err"></div>
        <button class="btn btn-primary auth-submit" type="submit" id="auth-submit">重置密码</button>
      </form>
      ${foot('想起密码了？', 'login', '去登录')}`;
    bindPwEyes(box);
    document.getElementById('auth-send').addEventListener('click', () => sendAuthCode('reset'));
    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('auth-err');
      err.textContent = '';
      const email = document.getElementById('auth-email').value.trim();
      const code = document.getElementById('auth-code').value.trim();
      const password = document.getElementById('auth-password').value;
      const password2 = document.getElementById('auth-password2').value;
      if (!EMAIL_RE.test(email)) return (err.textContent = '请输入正确的邮箱地址');
      if (!/^\d{6}$/.test(code)) return (err.textContent = '请输入 6 位数字验证码');
      if (password.length < 8 || password.length > 128) return (err.textContent = '密码长度需为 8-128 位');
      if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return (err.textContent = '密码需同时包含字母和数字');
      if (password !== password2) return (err.textContent = '两次输入的密码不一致');
      const submit = document.getElementById('auth-submit');
      authBusy(submit, true);
      try {
        await api('/api/auth/reset-password', { method: 'POST', body: { email, code, password } });
        toast('密码已重置，请使用新密码登录', 'ok', 8000);
        renderAuth('login');
        const emailInput = document.getElementById('auth-email');
        if (emailInput) {
          emailInput.value = email;
          document.getElementById('auth-password').focus();
        }
      } catch (e2) {
        err.textContent = e2.message;
      } finally {
        authBusy(submit, false);
      }
    });
  }

  // 视图内跳转
  box.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => renderAuth(b.dataset.goto)));
  const email = box.querySelector('#auth-email');
  if (email) email.focus();
}

// 登录/注册成功后进入主界面；未设密码的账号温和提示补设
async function enterApp() {
  await refreshMe();
  renderMain();
  const m = location.hash.match(/^#\/folder\/([\w-]+)$/);
  loadDir(m ? m[1] : null, { push: false });
  history.replaceState(null, '', location.pathname);
  if (state.usage && state.usage.hasPassword === false) {
    setTimeout(() => openChangePasswordDialog({ firstTime: true }), 600);
  }
}

// 设置 / 修改密码弹窗（firstTime = 首次设置，无需旧密码）
function openChangePasswordDialog({ firstTime = false } = {}) {
  const m = openModal(`
    <div class="modal-body">
      <h3>${firstTime ? '设置密码' : '修改密码'}</h3>
      <p class="muted" style="font-size:13px">${firstTime ? '当前账号尚未设置密码，设置后可用邮箱 + 密码登录。' : `账号：${escapeHtml(state.usage?.email || '')}`}</p>
      ${firstTime ? '' : `<div class="field"><label>当前密码</label>${pwField('cp-old', '当前密码', 'current-password')}</div>`}
      <div class="field"><label>新密码</label>${pwField('cp-new', '新密码（8 位以上，含字母和数字）')}</div>
      <div class="field"><label>确认新密码</label>${pwField('cp-new2', '再次输入新密码')}</div>
      <div class="auth-err" id="cp-err"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>${firstTime ? '稍后再说' : '取消'}</button>
      <button class="btn btn-primary" id="cp-ok">保存</button>
    </div>`);
  bindPwEyes(m);
  m.querySelector('#cp-old')?.focus();
  m.querySelector('#cp-ok').addEventListener('click', async () => {
    const err = m.querySelector('#cp-err');
    err.textContent = '';
    const oldPassword = m.querySelector('#cp-old')?.value || undefined;
    const newPassword = m.querySelector('#cp-new').value;
    const confirm = m.querySelector('#cp-new2').value;
    if (newPassword.length < 8 || newPassword.length > 128) return (err.textContent = '密码长度需为 8-128 位');
    if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) return (err.textContent = '密码需同时包含字母和数字');
    if (newPassword !== confirm) return (err.textContent = '两次输入的密码不一致');
    const btn = m.querySelector('#cp-ok');
    authBusy(btn, true);
    try {
      await api('/api/auth/change-password', { method: 'POST', body: { oldPassword, newPassword } });
      m.close();
      toast(firstTime ? '密码已设置，下次可用邮箱 + 密码登录' : '密码已修改，其他设备需重新登录', 'ok', 8000);
      refreshMe().catch(() => {});
    } catch (e) {
      err.textContent = e.message;
      authBusy(btn, false);
    }
  });
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
    `<div class="menu-head">${escapeHtml(state.usage?.email || 'admin')}<br><span class="muted" style="font-size:12px">已用 ${fmtSize(state.usage?.usage || 0)} · ${state.usage?.fileCount || 0} 个文件</span></div>
     <button data-act="password">🔑 ${state.usage?.hasPassword ? '修改密码' : '设置密码'}</button>
     <button data-act="shares">🔗 我的分享</button>
     <button data-act="logout" class="danger">🚪 退出登录</button>`,
    anchor
  );
  menu.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closeMenu();
    if (act === 'password') openChangePasswordDialog({ firstTime: !state.usage?.hasPassword });
    if (act === 'shares') openSharesDialog();
    if (act === 'logout') {
      try {
        await api('/api/logout', { method: 'POST' });
      } catch {}
      renderAuth('login');
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

// 提取码字符集：去掉 0/o/1/l 等易混淆字符
const PWD_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function genSharePwd(len = 4) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => PWD_CHARS[b % PWD_CHARS.length]).join('');
}

function openShareDialog(it) {
  const m = openModal(`
    <div class="modal-body">
      <h3>分享「${escapeHtml(it.name)}」</h3>
      <div class="field">
        <label class="pw-label">
          <span class="pw-title"><input type="checkbox" id="share-usepw" checked /> 提取码</span>
          <button type="button" class="link-btn" id="share-regen">🎲 重新生成</button>
        </label>
        <input class="input share-pw" id="share-pw" type="text" value="${genSharePwd()}" maxlength="8" />
        <div class="muted" style="font-size:12px;margin-top:4px">提取码会自动附加在链接末尾，访客打开链接即可免输入（同百度网盘）</div>
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

  const pwInput = m.querySelector('#share-pw');
  const usePw = m.querySelector('#share-usepw');
  const syncPwState = () => {
    pwInput.disabled = !usePw.checked;
    if (usePw.checked && !pwInput.value.trim()) pwInput.value = genSharePwd();
  };
  usePw.addEventListener('change', syncPwState);
  m.querySelector('#share-regen').addEventListener('click', () => {
    usePw.checked = true;
    syncPwState();
    pwInput.value = genSharePwd();
  });

  m.querySelector('#share-create').addEventListener('click', async () => {
    const btn = m.querySelector('#share-create');
    btn.disabled = true;
    const password = usePw.checked ? (pwInput.value.trim() || genSharePwd()) : null;
    try {
      const res = await api('/api/share', {
        method: 'POST',
        body: { fileId: it.id, password, expireDays: Number(m.querySelector('#share-exp').value) },
      });
      const urlWithPwd = password ? `${res.url}?pwd=${encodeURIComponent(password)}` : res.url;
      m.querySelector('#share-result').innerHTML = `
        <div class="share-result">
          <div class="muted" style="margin-bottom:8px;font-size:13px">分享链接已创建：</div>
          <div class="link-row">
            <span class="link">${escapeHtml(urlWithPwd)}</span>
            <button class="btn" id="share-copy">复制链接</button>
          </div>
          ${
            password
              ? `<div class="share-pwd-row">提取码：<b class="pwd-code">${escapeHtml(password)}</b><button class="btn" id="share-copy-all">复制链接+提取码</button></div>`
              : ''
          }
        </div>`;
      const copy = async (text, okMsg) => {
        try {
          await copyText(text);
          toast(okMsg);
        } catch {
          toast('复制失败，请手动复制', 'err');
        }
      };
      m.querySelector('#share-copy').addEventListener('click', () => copy(urlWithPwd, '链接已复制（含提取码）'));
      m.querySelector('#share-copy-all')?.addEventListener('click', () =>
        copy(`链接：${urlWithPwd} 提取码：${password}`, '链接和提取码已复制')
      );
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

const MAX_FILE_SIZE = 8 * 1024 * 1024 * 1024; // 与服务端一致：1000 个 8MiB 分片

function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  let queued = 0;
  for (const f of files) {
    if (f.size > MAX_FILE_SIZE) {
      toast(`「${f.name}」超过单文件 8GB 上限，已跳过`, 'err', 10000);
      continue;
    }
    queueUpload(f, state.folderId);
    queued++;
  }
  if (queued) toast(`开始上传 ${queued} 个文件`);
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

// 单分片上传：XMLHttpRequest 提供逐字节进度；停滞超时自动中止（由外层重试）
const PART_STALL_TIMEOUT = 90 * 1000;

function uploadPartOnce(url, blob, { onProgress, shouldAbort }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.responseType = 'json';
    let stallTimer = null;
    const settle = (fn, arg) => {
      clearTimeout(stallTimer);
      clearInterval(poll);
      fn(arg);
    };
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => xhr.abort(), PART_STALL_TIMEOUT);
    };
    // 轮询取消标记，保证用户点取消时能立刻中断
    const poll = setInterval(() => {
      if (shouldAbort()) xhr.abort();
    }, 300);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded);
      armStall();
    };
    xhr.onload = () =>
      settle(() => {
        const data = xhr.response;
        if (xhr.status >= 200 && xhr.status < 300 && data && data.etag) resolve(data);
        else reject(new Error((data && data.error) || `分片上传失败 (${xhr.status})`));
      });
    xhr.onerror = () => settle(() => reject(new Error('网络错误，分片上传中断')));
    xhr.onabort = () => settle(() => reject(Object.assign(new Error('已取消'), { aborted: true })));
    xhr.send(blob);
    armStall();
  });
}

let lastProgressRender = 0;
function renderProgressThrottled() {
  const now = Date.now();
  if (now - lastProgressRender > 200) {
    lastProgressRender = now;
    renderUploadPanel();
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
      const partBase = start;
      const chunk = task.file.slice(start, Math.min(start + partSize, task.file.size));
      let etag = null;
      // 停滞自动中止后最多重试 3 次
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const data = await uploadPartOnce(apiUrl(`/api/upload/${init.uploadId}/part/${n}`), chunk, {
            onProgress: (loaded) => {
              task.sent = Math.min(partBase + loaded, task.file.size);
              renderProgressThrottled();
            },
            shouldAbort: () => task.aborted,
          });
          etag = data.etag;
          break;
        } catch (e) {
          if (e.aborted && task.aborted) throw e;
          if (attempt === 3) throw e;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
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
    task.doneAt = Date.now();
    toast(`「${task.file.name}」上传完成`, 'ok', 10000);
    scheduleFinishedCleanup();
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

// 完成的任务 10 秒后自动从面板消失；全部结束且无失败时收起面板
const FINISHED_TTL = 10 * 1000;
let finishedCleanupTimer = null;

function scheduleFinishedCleanup() {
  clearTimeout(finishedCleanupTimer);
  finishedCleanupTimer = setTimeout(() => {
    const now = Date.now();
    for (let i = uploadTasks.length - 1; i >= 0; i--) {
      const t = uploadTasks[i];
      if (t.status === '完成' && t.doneAt && now - t.doneAt >= FINISHED_TTL) uploadTasks.splice(i, 1);
    }
    const stillBusy = uploadTasks.some((t) => ['等待中', '上传中', '合并中'].includes(t.status));
    const hasFailed = uploadTasks.some((t) => t.status === '失败');
    if (!stillBusy && !hasFailed) {
      uploadTasks.length = 0;
      document.getElementById('upload-panel')?.classList.remove('open');
    }
    renderUploadPanel();
  }, FINISHED_TTL + 200);
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

// ---------------- 粘贴上传（Ctrl+V / 截图粘贴） ----------------

function setupPasteUpload() {
  window.addEventListener('paste', (e) => {
    // 仅在主界面（已登录）生效；分享页无 file-input
    if (!document.getElementById('file-input')) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...dt.files];
    // 部分浏览器（如截图场景）需要从 items 中逐个提取
    if (!files.length && dt.items && dt.items.length) {
      for (const item of dt.items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
    }
    if (!files.length) return;
    e.preventDefault();
    if (state.searchMode) toast('粘贴上传会放入当前浏览的目录，请先退出搜索', 'err');
    else handleFiles(files);
  });
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

setupPasteUpload();
// 未登录时直接访问 #/login、#/register、#/forgot 也能切换到对应视图
window.addEventListener('hashchange', () => {
  if (AUTH_HASH[location.hash] && !document.querySelector('.topbar')) renderAuth(AUTH_HASH[location.hash]);
});
boot();
