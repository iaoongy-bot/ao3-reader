/* ================================================================
   AO3 读后感 - 数据层 & 全局状态
   ================================================================ */

const STORAGE_KEY = 'ao3_reading_notes';
const PENDING_SYNC_KEY = 'ao3_pending_sync_operations';
const DRAFT_KEY = 'ao3_note_draft';
let notes = [];
let currentView = 'bookshelf';
let editingId = null;
let currentDetailId = null;
let ocrWorker = null;
let activeFandom = '';
let activeCp = 'all';
let cloud = null;
let currentUser = null;
let syncInProgress = false;

// ========== Supabase 云端同步 ==========

function getPendingOperations() {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_SYNC_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function setPendingOperations(operations) {
  localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(operations));
}

function queueSyncOperation(operation) {
  const pending = getPendingOperations().filter(item => item.id !== operation.id);
  pending.push(operation);
  setPendingOperations(pending);
  updateSyncStatus(navigator.onLine ? '等待同步' : '离线保存');
}

function initCloudClient() {
  const config = window.AO3_CLOUD_CONFIG || {};
  if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase) return false;
  cloud = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return true;
}

async function flushPendingOperations() {
  if (!cloud || !currentUser || !navigator.onLine) return false;
  const pending = getPendingOperations();
  if (pending.length === 0) return true;

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const { data: existing, error: readError } = await cloud
      .from('ao3_notes')
      .select('updated_at')
      .eq('id', item.id)
      .maybeSingle();
    if (readError) throw readError;
    if (existing && new Date(existing.updated_at).getTime() > new Date(item.updatedAt).getTime()) {
      setPendingOperations(pending.slice(i + 1));
      continue;
    }
    const row = item.type === 'delete'
      ? { user_id: currentUser.id, id: item.id, data: {}, updated_at: item.updatedAt, deleted_at: item.updatedAt }
      : { user_id: currentUser.id, id: item.id, data: item.note, updated_at: item.updatedAt, deleted_at: null };
    const { error } = await cloud.from('ao3_notes').upsert(row, { onConflict: 'user_id,id' });
    if (error) throw error;
    setPendingOperations(pending.slice(i + 1));
  }
  return true;
}

// ========== 数据读写 ==========

function loadNotes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    notes = raw ? JSON.parse(raw) : [];
  } catch (e) {
    notes = [];
  }
}

async function syncWithCloud() {
  if (!cloud || !currentUser || syncInProgress) return;
  syncInProgress = true;
  updateSyncStatus('同步中…');
  try {
    await flushPendingOperations();
    const { data: rows, error } = await cloud
      .from('ao3_notes')
      .select('id,data,updated_at,deleted_at');
    if (error) throw error;

    const localMap = new Map(notes.map(note => [note.id, note]));
    const remoteIds = new Set();
    for (const row of rows || []) {
      remoteIds.add(row.id);
      const local = localMap.get(row.id);
      const localTime = new Date(local?.updatedAt || 0).getTime();
      const remoteTime = new Date(row.updated_at || 0).getTime();
      if (row.deleted_at && remoteTime >= localTime) {
        localMap.delete(row.id);
      } else if (!row.deleted_at && (!local || remoteTime >= localTime)) {
        localMap.set(row.id, { ...row.data, id: row.id, updatedAt: row.updated_at });
      } else if (local && localTime > remoteTime) {
        queueSyncOperation({ type: 'upsert', id: local.id, note: local, updatedAt: local.updatedAt });
      }
    }

    for (const local of localMap.values()) {
      if (!remoteIds.has(local.id)) {
        queueSyncOperation({ type: 'upsert', id: local.id, note: local, updatedAt: local.updatedAt || new Date().toISOString() });
      }
    }

    notes = Array.from(localMap.values());
    saveNotes();
    await flushPendingOperations();
    renderBookshelf();
    updateSyncStatus('已同步');
  } catch (error) {
    console.warn('Cloud sync failed:', error);
    updateSyncStatus(navigator.onLine ? '同步失败' : '离线保存', true);
  } finally {
    syncInProgress = false;
  }
}

function saveNotes() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

// 保存并同步到后端
function saveAndSync(note) {
  saveNotes();
  queueSyncOperation({ type: 'upsert', id: note.id, note, updatedAt: note.updatedAt });
  syncWithCloud();
}

// 删除并同步到后端
function deleteAndSync(id) {
  notes = notes.filter(n => n.id !== id);
  saveNotes();
  const updatedAt = new Date().toISOString();
  queueSyncOperation({ type: 'delete', id, updatedAt });
  syncWithCloud();
}

function generateId() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function findNoteById(id) {
  return notes.find(n => n.id === id);
}

function findNoteIndex(id) {
  return notes.findIndex(n => n.id === id);
}

// ========== 预置标签 ==========

const PRESET_TAGS = ['甜文', '虐心', 'HE', 'BE', '长草', '慢热', '神作', '文笔好', '设定绝', '待追更'];

// ========== 视图切换 ==========

const $bookshelfView = document.getElementById('bookshelf-view');
const $formView = document.getElementById('form-view');
const $detailView = document.getElementById('detail-view');
const $loginView = document.getElementById('login-view');
const $headerTitle = document.getElementById('header-title');
const $headerSubtitle = document.getElementById('header-subtitle');
const $btnBack = document.getElementById('btn-back');
const $headerActions = document.getElementById('header-actions');

function showView(view) {
  currentView = view;
  $loginView.style.display = view === 'login' ? 'flex' : 'none';
  $bookshelfView.style.display = view === 'bookshelf' ? '' : 'none';
  $formView.style.display = view === 'form' ? '' : 'none';
  $detailView.style.display = view === 'detail' ? '' : 'none';

  if (view === 'login') {
    $headerTitle.textContent = '📖 AO3 读后感';
    $headerSubtitle.style.display = 'none';
    $btnBack.style.display = 'none';
    $headerActions.innerHTML = '';
    $btnAdd.style.display = 'none';
  } else if (view === 'bookshelf') {
    $headerTitle.textContent = '我的阅读手账';
    $headerSubtitle.style.display = '';
    $btnBack.style.display = 'none';
    renderHeaderActions();
    $btnAdd.style.display = '';
  } else if (view === 'form') {
    $headerTitle.textContent = editingId ? '编辑记录' : '添加记录';
    $headerSubtitle.style.display = 'none';
    $btnBack.style.display = '';
    renderHeaderActions();
    $btnAdd.style.display = 'none';
  } else if (view === 'detail') {
    $headerTitle.textContent = '文章详情';
    $headerSubtitle.style.display = 'none';
    $btnBack.style.display = '';
    renderHeaderActions();
    $btnAdd.style.display = 'none';
  }
}

function renderHeaderActions() {
  $headerActions.innerHTML = '<button id="sync-status" class="sync-status" type="button" title="点击立即同步" aria-live="polite">云端</button>';
  document.getElementById('sync-status').addEventListener('click', syncWithCloud);
}

function updateSyncStatus(text, isError = false) {
  const status = document.getElementById('sync-status');
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('error', isError);
}

$btnBack.addEventListener('click', () => {
  if (currentView === 'form') {
    if (!confirmLeaveForm()) return;
    showView('bookshelf');
    renderBookshelf();
  } else if (currentView === 'detail') {
    showView('bookshelf');
    renderBookshelf();
  }
});

// ========== 书架页 ==========

let viewMode = 'card';
let activeTagFilter = null;
let searchQuery = '';

const $booksContainer = document.getElementById('books-container');
const EMPTY_STATE_HTML = `<div class="empty-state">
  <div class="empty-icon">📚</div>
  <p>还没有记录</p>
  <p class="empty-hint">点击下方 + 按钮添加第一条读后感吧</p>
</div>`;
const $searchInput = document.getElementById('search-input');
const $btnSearchClear = document.getElementById('btn-search-clear');
const $fandomTabs = document.getElementById('fandom-tabs');
const $cpTabs = document.getElementById('cp-tabs');
const $filterRating = document.getElementById('filter-rating');
const $filterBar = document.getElementById('filter-bar');
const $btnFilterToggle = document.getElementById('btn-filter-toggle');
const $filterStatus = document.getElementById('filter-status');
const $sortBy = document.getElementById('sort-by');
const $resultCount = document.getElementById('result-count');
const $btnViewCard = document.getElementById('btn-view-card');
const $btnViewList = document.getElementById('btn-view-list');
const $activeTagFilters = document.getElementById('active-tag-filters');
const $activeFilterTags = document.getElementById('active-filter-tags');
const $btnClearTagFilter = document.getElementById('btn-clear-tag-filter');
const $btnExport = document.getElementById('btn-export');
const $btnImport = document.getElementById('btn-import');
const $inputImportFile = document.getElementById('input-import-file');
const $btnAdd = document.getElementById('btn-add');

function getFilteredNotes() {
  let result = [...notes];

  // Fandom 筛选
  if (activeFandom) {
    result = result.filter(n => n.fandom === activeFandom);
  }

  // CP 筛选
  if (activeCp !== 'all') {
    result = result.filter(n => getCps(n.cp).includes(activeCp));
  }

  // 搜索
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    result = result.filter(n => [
      n.title, n.author, n.fandom, n.cp, n.summary, n.notes, n.workId,
      ...(Array.isArray(n.ao3Tags) ? n.ao3Tags : []),
      ...(Array.isArray(n.privateTags) ? n.privateTags : []),
    ].some(value => String(value || '').toLowerCase().includes(q)));
  }

  // 喜欢程度筛选
  const ratingFilter = $filterRating.value;
  if (ratingFilter !== 'all') {
    const r = parseInt(ratingFilter);
    result = result.filter(n => n.rating === r);
  }

  // 状态筛选
  const statusFilter = $filterStatus.value;
  if (statusFilter !== 'all') {
    result = result.filter(n => n.completionStatus === statusFilter);
  }

  // 标签筛选
  if (activeTagFilter) {
    result = result.filter(n =>
      (Array.isArray(n.ao3Tags) && n.ao3Tags.includes(activeTagFilter)) ||
      (Array.isArray(n.privateTags) && n.privateTags.includes(activeTagFilter))
    );
  }

  // 排序
  const sortVal = $sortBy.value;
  switch (sortVal) {
    case 'date-desc':
      result.sort((a, b) => String(b.readingDate || '').localeCompare(String(a.readingDate || '')));
      break;
    case 'date-asc':
      result.sort((a, b) => String(a.readingDate || '').localeCompare(String(b.readingDate || '')));
      break;
    case 'rating-desc':
      result.sort((a, b) => b.rating - a.rating);
      break;
    case 'rating-asc':
      result.sort((a, b) => a.rating - b.rating);
      break;
  }

  return result;
}

function getUniqueFandoms() {
  const set = new Set();
  notes.forEach(n => {
    if (n.fandom) set.add(n.fandom);
  });
  return [...set];
}

function getCps(cpValue) {
  return String(cpValue || '')
    .split(/[,，;；\n]/)
    .map(value => value.trim())
    .filter(Boolean);
}

function getUniqueCps(fandom) {
  const counts = new Map();
  notes.forEach(n => {
    if (fandom && n.fandom !== fandom) return;
    getCps(n.cp).forEach(cp => {
      counts.set(cp, (counts.get(cp) || 0) + 1);
    });
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .map(([cp]) => cp);
}

function buildFandomTabs() {
  const fandoms = getUniqueFandoms();

  // 如果当前选中的 fandom 已经没有记录了，重置为全部
  if (activeFandom && !fandoms.includes(activeFandom)) {
    activeFandom = '';
    activeCp = 'all';
  }

  let html = `<button class="fandom-tab${activeFandom === '' ? ' active' : ''}" data-fandom="">📚 全部</button>`;

  fandoms.forEach(f => {
    const active = activeFandom === f ? ' active' : '';
    html += `<button class="fandom-tab${active}" data-fandom="${escapeAttribute(f)}">${escapeHtml(f)}</button>`;
  });

  $fandomTabs.innerHTML = html;

  // 绑定事件
  $fandomTabs.querySelectorAll('.fandom-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const fandom = tab.dataset.fandom;
      activeFandom = fandom;
      activeCp = 'all';
      updateCpFilter();
      buildFandomTabs();
      renderBookshelf();
    });
  });
}

function updateCpFilter() {
  const cps = getUniqueCps(activeFandom);
  if (activeCp !== 'all' && !cps.includes(activeCp)) activeCp = 'all';
  let html = `<button class="cp-tab${activeCp === 'all' ? ' active' : ''}" data-cp="all">全部 CP</button>`;
  cps.forEach(cp => {
    const active = activeCp === cp ? ' active' : '';
    html += `<button class="cp-tab${active}" data-cp="${escapeAttribute(cp)}" title="${escapeAttribute(cp)}">${escapeHtml(cp)}</button>`;
  });
  $cpTabs.innerHTML = html;
  $cpTabs.querySelectorAll('.cp-tab').forEach(tab => {
    const cp = tab.dataset.cp;
    if (cp !== 'all') {
      const color = getCpAccentColor(cp);
      tab.style.setProperty('--cp-accent', color);
    }
    tab.addEventListener('click', () => {
      activeCp = cp;
      renderBookshelf();
    });
  });
}

function renderHeartIcons(rating) {
  const count = Math.round(Math.min(5, Math.max(0, Number(rating) || 0)));
  return count > 0 ? '♥'.repeat(count) : '';
}

function truncateText(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

function getPrimaryCp(cpValue) {
  return String(cpValue || '')
    .split(/[,，;；\n]/)[0]
    .trim()
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/g, ' ');
}

function getCpAccentColor(cpValue) {
  const primaryCp = getPrimaryCp(cpValue);
  if (!primaryCp) return '';
  let hash = 0;
  for (const char of primaryCp) {
    hash = ((hash * 31) + char.codePointAt(0)) >>> 0;
  }
  const hue = hash % 360;
  const saturation = 18 + ((hash >>> 8) % 7);
  const lightness = 58 + ((hash >>> 16) % 7);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function renderBookshelf() {
  buildFandomTabs();
  updateCpFilter();
  const filtered = getFilteredNotes();
  $resultCount.textContent = `共 ${filtered.length} 篇阅读记录`;

  if (filtered.length === 0) {
    $booksContainer.innerHTML = EMPTY_STATE_HTML;
  } else {
    $booksContainer.innerHTML = '';
    filtered.forEach(note => {
      $booksContainer.appendChild(createBookCard(note));
    });
  }

  updateActiveTagFilterUI();
}

function createBookCard(note) {
  const card = document.createElement('div');
  card.className = `book-card rating-${note.rating}`;
  const cpAccentColor = getCpAccentColor(note.cp);
  if (cpAccentColor) card.style.borderLeftColor = cpAccentColor;
  else card.classList.add('no-cp');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `打开《${note.title || '未命名'}》详情`);
  card.addEventListener('click', () => openDetail(note.id));
  card.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openDetail(note.id);
    }
  });

  const heartCount = Math.round(Math.min(5, Math.max(0, Number(note.rating) || 0)));
  const heartsHtml = renderHeartIcons(heartCount);

  const privateTagsHtml = (note.privateTags || []).map(t =>
    `<span class="card-tag private" data-tag="${escapeAttribute(t)}">${escapeHtml(t)}</span>`
  ).join('');

  card.innerHTML = `
    <div class="card-header">
      <div class="card-title">${escapeHtml(note.title || '未命名')}</div>
      ${heartsHtml ? `<div class="card-stars" aria-label="喜欢程度 ${heartCount} 颗心">${heartsHtml}</div>` : ''}
    </div>
    <div class="card-meta">
      <span>${escapeHtml(note.author || '未知作者')}</span>
    </div>
    ${note.fandom ? `<div class="card-meta card-fandom"><span>${escapeHtml(note.fandom)}</span></div>` : ''}
    ${note.cp ? `<div class="card-meta card-cp"><span>${escapeHtml(note.cp)}</span></div>` : ''}
    ${note.workId ? `<div class="card-meta card-workid"><span>${escapeHtml(note.workId)}</span></div>` : ''}
    ${privateTagsHtml ? `<div class="card-tags">${privateTagsHtml}</div>` : ''}
    ${note.notes ? `<div class="card-notes-preview">${escapeHtml(note.notes)}</div>` : ''}
  `;

  // 标签点击筛选（阻止冒泡）
  card.querySelectorAll('.card-tag').forEach(tagEl => {
    tagEl.addEventListener('click', e => {
      e.stopPropagation();
      const tagText = tagEl.dataset.tag;
      setTagFilter(tagText);
    });
  });

  return card;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

function escapeAttribute(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function safeAo3Url(value) {
  try {
    const url = new URL(value);
    const validHost = url.hostname === 'archiveofourown.org' || url.hostname === 'www.archiveofourown.org';
    return url.protocol === 'https:' && validHost && /^\/works\/\d+/.test(url.pathname) ? url.href : '';
  } catch {
    return '';
  }
}

function setTagFilter(tag) {
  activeTagFilter = tag;
  updateActiveTagFilterUI();
  renderBookshelf();
}

function clearTagFilter() {
  activeTagFilter = null;
  updateActiveTagFilterUI();
  renderBookshelf();
}

function updateActiveTagFilterUI() {
  if (activeTagFilter) {
    $activeTagFilters.style.display = 'flex';
    $activeFilterTags.innerHTML = `<span class="active-filter-tag">${escapeHtml(activeTagFilter)}</span>`;
    $activeFilterTags.querySelector('.active-filter-tag').addEventListener('click', clearTagFilter);
  } else {
    $activeTagFilters.style.display = 'none';
    $activeFilterTags.innerHTML = '';
  }
}

// 搜索事件
$searchInput.addEventListener('input', () => {
  searchQuery = $searchInput.value.trim();
  $btnSearchClear.style.display = searchQuery ? '' : 'none';
  renderBookshelf();
});

$btnSearchClear.addEventListener('click', () => {
  $searchInput.value = '';
  searchQuery = '';
  $btnSearchClear.style.display = 'none';
  renderBookshelf();
});

// 筛选事件
$filterRating.addEventListener('change', () => renderBookshelf());
$filterStatus.addEventListener('change', () => renderBookshelf());
$sortBy.addEventListener('change', () => renderBookshelf());

$btnFilterToggle.addEventListener('click', () => {
  const isOpen = $filterBar.classList.toggle('open');
  $btnFilterToggle.setAttribute('aria-expanded', String(isOpen));
});

// 视图切换
$btnViewCard.addEventListener('click', () => {
  viewMode = 'card';
  $btnViewCard.classList.add('active');
  $btnViewList.classList.remove('active');
  $booksContainer.classList.remove('list-view');
  $booksContainer.classList.add('card-view');
});

$btnViewList.addEventListener('click', () => {
  viewMode = 'list';
  $btnViewList.classList.add('active');
  $btnViewCard.classList.remove('active');
  $booksContainer.classList.add('list-view');
  $booksContainer.classList.remove('card-view');
});

$btnClearTagFilter.addEventListener('click', clearTagFilter);

// 导出
$btnExport.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ao3-notes-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// 导入
$btnImport.addEventListener('click', () => $inputImportFile.click());

$inputImportFile.addEventListener('change', () => {
  const file = $inputImportFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported)) throw new Error('格式错误');
      const validNotes = imported.map(normalizeImportedNote).filter(Boolean);
      if (validNotes.length === 0 && imported.length > 0) throw new Error('没有有效记录');
      // 合并：以 id 去重，导入的覆盖已有
      const map = new Map(notes.map(n => [n.id, n]));
      validNotes.forEach(n => map.set(n.id, n));
      notes = Array.from(map.values());
      saveNotes();
      // 加入云端同步队列
      validNotes.forEach(n => {
        const updatedAt = n.updatedAt || new Date().toISOString();
        n.updatedAt = updatedAt;
        queueSyncOperation({ type: 'upsert', id: n.id, note: n, updatedAt });
      });
      syncWithCloud();
      renderBookshelf();
      const skipped = imported.length - validNotes.length;
      alert(`成功导入 ${validNotes.length} 条记录${skipped ? `，跳过 ${skipped} 条无效数据` : ''}`);
    } catch (e) {
      alert('导入失败：文件格式不正确');
    }
  };
  reader.readAsText(file);
  $inputImportFile.value = '';
});

function normalizeImportedNote(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = typeof value.title === 'string' ? value.title.trim().slice(0, 500) : '';
  const author = typeof value.author === 'string' ? value.author.trim().slice(0, 300) : '';
  if (!title || !author) return null;
  const stringValue = (key, max = 5000) => typeof value[key] === 'string' ? value[key].slice(0, max) : '';
  const tagList = key => Array.isArray(value[key])
    ? value[key].filter(tag => typeof tag === 'string').map(tag => tag.trim().slice(0, 200)).filter(Boolean).slice(0, 200)
    : [];
  const updatedAt = Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : new Date().toISOString();
  return {
    id: typeof value.id === 'string' && value.id ? value.id.slice(0, 200) : generateId(),
    ao3Url: safeAo3Url(value.ao3Url), title, author,
    fandom: stringValue('fandom', 500), cp: stringValue('cp', 500),
    wordCount: stringValue('wordCount', 100), completionStatus: stringValue('completionStatus', 30),
    workId: stringValue('workId', 100), rating: Math.min(5, Math.max(0, Number(value.rating) || 0)),
    ao3Tags: tagList('ao3Tags'), privateTags: tagList('privateTags'),
    notes: stringValue('notes', 100000), readingDate: stringValue('readingDate', 20),
    summary: stringValue('summary', 50000),
    createdAt: Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : updatedAt,
    updatedAt,
  };
}

// 添加按钮
$btnAdd.addEventListener('click', () => {
  editingId = null;
  resetForm();
  restoreDraft();
  showView('form');
});

// ========== 添加/编辑表单 ==========

const $inputAo3Url = document.getElementById('input-ao3-url');
const $btnAutoFetch = document.getElementById('btn-auto-fetch');
const $fetchStatus = document.getElementById('fetch-status');
const $ocrSection = document.getElementById('ocr-section');
const $inputScreenshot = document.getElementById('input-screenshot');
const $btnUploadScreenshot = document.getElementById('btn-upload-screenshot');
const $ocrPreview = document.getElementById('ocr-preview');
const $ocrPreviewImg = document.getElementById('ocr-preview-img');
const $ocrProgress = document.getElementById('ocr-progress');
const $ocrProgressBar = document.getElementById('ocr-progress-bar');
const $ocrProgressText = document.getElementById('ocr-progress-text');
const $inputTitle = document.getElementById('input-title');
const $inputAuthor = document.getElementById('input-author');
const $inputFandom = document.getElementById('input-fandom');
const $inputCp = document.getElementById('input-cp');
const $inputWordcount = document.getElementById('input-wordcount');
const $inputStatus = document.getElementById('input-status');
const $inputWorkId = document.getElementById('input-workid');
const $inputSummary = document.getElementById('input-summary');
const $inputDate = document.getElementById('input-date');
const $inputNotes = document.getElementById('input-notes');
const $starRating = document.getElementById('star-rating');
const $ao3TagsContainer = document.getElementById('ao3-tags-container');
const $inputAo3Tag = document.getElementById('input-ao3-tag');
const $privateTagsContainer = document.getElementById('private-tags-container');
const $inputPrivateTag = document.getElementById('input-private-tag');
const $presetTags = document.getElementById('preset-tags');
const $btnSave = document.getElementById('btn-save');
const $btnCancelForm = document.getElementById('btn-cancel-form');

let formRating = 0;
let formAo3Tags = [];
let formPrivateTags = [];
let formBaseline = '';
let draftTimer = null;

function captureFormState() {
  return {
    editingId,
    ao3Url: $inputAo3Url.value,
    title: $inputTitle.value,
    author: $inputAuthor.value,
    fandom: $inputFandom.value,
    cp: $inputCp.value,
    wordCount: $inputWordcount.value,
    completionStatus: $inputStatus.value,
    workId: $inputWorkId.value,
    summary: $inputSummary.value,
    readingDate: $inputDate.value,
    notes: $inputNotes.value,
    rating: formRating,
    ao3Tags: [...formAo3Tags],
    privateTags: [...formPrivateTags],
  };
}

function markFormBaseline() {
  formBaseline = JSON.stringify(captureFormState());
}

function isFormDirty() {
  return currentView === 'form' && JSON.stringify(captureFormState()) !== formBaseline;
}

function saveDraftSoon() {
  if (currentView !== 'form') return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(captureFormState()));
  }, 250);
}

function clearDraft() {
  clearTimeout(draftTimer);
  localStorage.removeItem(DRAFT_KEY);
}

function restoreDraft(expectedEditingId = null) {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (!draft || (draft.editingId || null) !== expectedEditingId) return;
    $inputAo3Url.value = draft.ao3Url || '';
    $inputTitle.value = draft.title || '';
    $inputAuthor.value = draft.author || '';
    $inputFandom.value = draft.fandom || '';
    $inputCp.value = draft.cp || '';
    $inputWordcount.value = draft.wordCount || '';
    $inputStatus.value = draft.completionStatus || '';
    $inputWorkId.value = draft.workId || '';
    $inputSummary.value = draft.summary || '';
    $inputDate.value = draft.readingDate || new Date().toISOString().split('T')[0];
    $inputNotes.value = draft.notes || '';
    formRating = Number(draft.rating) || 0;
    formAo3Tags = Array.isArray(draft.ao3Tags) ? draft.ao3Tags : [];
    formPrivateTags = Array.isArray(draft.privateTags) ? draft.privateTags : [];
    renderStars();
    renderTags($ao3TagsContainer, formAo3Tags, 'ao3');
    renderTags($privateTagsContainer, formPrivateTags, 'private');
    updatePresetTagState();
  } catch {
    clearDraft();
  }
}

function confirmLeaveForm() {
  if (!isFormDirty()) return true;
  if (!window.confirm('这次填写还没有保存，确定要离开吗？')) return false;
  clearDraft();
  return true;
}

function resetForm() {
  $inputAo3Url.value = '';
  $inputTitle.value = '';
  $inputAuthor.value = '';
  $inputFandom.value = '';
  $inputCp.value = '';
  $inputWordcount.value = '';
  $inputStatus.value = '';
  $inputWorkId.value = '';
  $inputSummary.value = '';
  $inputDate.value = new Date().toISOString().split('T')[0];
  $inputNotes.value = '';
  formRating = 0;
  formAo3Tags = [];
  formPrivateTags = [];
  renderStars();
  renderTags($ao3TagsContainer, formAo3Tags, 'ao3');
  renderTags($privateTagsContainer, formPrivateTags, 'private');
  updatePresetTagState();
  $fetchStatus.style.display = 'none';
  $fetchStatus.textContent = '';
  $ocrSection.style.display = 'none';
  $ocrPreview.style.display = 'none';
  $ocrProgress.style.display = 'none';
  resetOcrButton();
  markFormBaseline();
}

function fillForm(note) {
  $inputAo3Url.value = note.ao3Url || '';
  $inputTitle.value = note.title || '';
  $inputAuthor.value = note.author || '';
  $inputFandom.value = note.fandom || '';
  $inputCp.value = note.cp || '';
  $inputWordcount.value = note.wordCount || '';
  $inputStatus.value = note.completionStatus || '';
  $inputWorkId.value = note.workId || '';
  $inputSummary.value = note.summary || '';
  $inputDate.value = note.readingDate || new Date().toISOString().split('T')[0];
  $inputNotes.value = note.notes || '';
  formRating = note.rating || 0;
  formAo3Tags = [...(note.ao3Tags || [])];
  formPrivateTags = [...(note.privateTags || [])];
  renderStars();
  renderTags($ao3TagsContainer, formAo3Tags, 'ao3');
  renderTags($privateTagsContainer, formPrivateTags, 'private');
  updatePresetTagState();
  markFormBaseline();
}

function formToNote() {
  const now = new Date().toISOString();
  const note = {
    id: editingId || generateId(),
    ao3Url: $inputAo3Url.value.trim(),
    title: $inputTitle.value.trim(),
    author: $inputAuthor.value.trim(),
    fandom: $inputFandom.value.trim(),
    cp: $inputCp.value.trim(),
    wordCount: $inputWordcount.value.trim(),
    completionStatus: $inputStatus.value,
    workId: $inputWorkId.value.trim(),
    summary: $inputSummary.value.trim(),
    rating: formRating,
    ao3Tags: [...formAo3Tags],
    privateTags: [...formPrivateTags],
    notes: $inputNotes.value.trim(),
    readingDate: $inputDate.value,
    updatedAt: now,
  };
  if (!editingId) {
    note.createdAt = now;
  } else {
    const existing = findNoteById(editingId);
    if (existing) note.createdAt = existing.createdAt;
  }
  return note;
}

// 喜欢程度组件
function renderStars() {
  const stars = $starRating.querySelectorAll('.star');
  stars.forEach(star => {
    const r = parseInt(star.dataset.rating);
    star.textContent = r <= formRating ? '♥' : '♡';
    star.classList.toggle('active', r <= formRating);
  });
}

$starRating.addEventListener('click', (e) => {
  const star = e.target.closest('.star');
  if (!star) return;
  const newRating = parseInt(star.dataset.rating);
  formRating = formRating === newRating ? 0 : newRating;
  renderStars();
  saveDraftSoon();
});

// 标签组件
function renderTags(container, tags, type) {
  container.innerHTML = tags.map(t =>
    `<span class="tag-item ${type}">
      ${escapeHtml(t)}
      <button type="button" class="tag-remove" aria-label="移除标签 ${escapeAttribute(t)}" data-tag="${escapeAttribute(t)}" data-type="${type}">×</button>
    </span>`
  ).join('');

  container.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      const tagsArr = getTagArray(btn.dataset.type);
      const idx = tagsArr.indexOf(tag);
      if (idx >= 0) {
        tagsArr.splice(idx, 1);
        renderTags(container, tagsArr, type);
        if (btn.dataset.type === 'private') updatePresetTagState();
        saveDraftSoon();
      }
    });
  });
}

function getTagArray(type) {
  return type === 'ao3' ? formAo3Tags : formPrivateTags;
}

function addTagInputHandler(inputEl, container, type) {
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = inputEl.value.trim();
      const tagsArr = getTagArray(type);
      if (val && !tagsArr.includes(val)) {
        tagsArr.push(val);
        renderTags(container, tagsArr, type);
        if (type === 'private') updatePresetTagState();
      }
      inputEl.value = '';
      saveDraftSoon();
    }
  });
}

addTagInputHandler($inputAo3Tag, $ao3TagsContainer, 'ao3');
addTagInputHandler($inputPrivateTag, $privateTagsContainer, 'private');

// 预置标签
function updatePresetTagState() {
  $presetTags.querySelectorAll('.preset-tag').forEach(btn => {
    btn.classList.toggle('added', formPrivateTags.includes(btn.dataset.tag));
  });
}

$presetTags.addEventListener('click', (e) => {
  const btn = e.target.closest('.preset-tag');
  if (!btn) return;
  const tag = btn.dataset.tag;
  const idx = formPrivateTags.indexOf(tag);
  if (idx >= 0) {
    formPrivateTags.splice(idx, 1);
  } else {
    formPrivateTags.push(tag);
  }
  renderTags($privateTagsContainer, formPrivateTags, 'private');
  updatePresetTagState();
  saveDraftSoon();
});

// 保存
$btnSave.addEventListener('click', () => {
  const note = formToNote();
  if (!note.title) {
    shakeElement($inputTitle);
    return;
  }
  if (!note.author) {
    shakeElement($inputAuthor);
    return;
  }

  if (editingId) {
    const idx = findNoteIndex(editingId);
    if (idx >= 0) notes[idx] = note;
  } else {
    notes.push(note);
  }
  saveAndSync(note);
  clearDraft();
  showView('bookshelf');
  renderBookshelf();
});

$btnCancelForm.addEventListener('click', () => {
  if (!confirmLeaveForm()) return;
  showView('bookshelf');
  renderBookshelf();
});

$formView.addEventListener('input', saveDraftSoon);
$formView.addEventListener('change', saveDraftSoon);

function shakeElement(el) {
  el.style.borderColor = '#c0392b';
  el.style.animation = 'none';
  el.offsetHeight;
  el.style.animation = 'shake 0.4s ease';
  setTimeout(() => { el.style.borderColor = ''; el.style.animation = ''; }, 400);
}

// ========== 详情页 ==========

const $detailContent = document.getElementById('detail-content');
const $btnEdit = document.getElementById('btn-edit');
const $btnDelete = document.getElementById('btn-delete');
const $confirmDialog = document.getElementById('confirm-dialog');
const $btnConfirmDelete = document.getElementById('btn-confirm-delete');
const $btnCancelDelete = document.getElementById('btn-cancel-delete');

let pendingDeleteId = null;
let dialogReturnFocus = null;

function openDetail(id) {
  currentDetailId = id;
  const note = findNoteById(id);
  if (!note) return;

  const heartCount = Math.round(Math.min(5, Math.max(0, Number(note.rating) || 0)));
  const heartsHtml = renderHeartIcons(heartCount);
  const ao3Link = safeAo3Url(note.ao3Url);
  const ao3TagsHtml = (note.ao3Tags || []).map(t =>
    `<span class="tag-item ao3">${escapeHtml(t)}</span>`
  ).join('');
  const privateTagsHtml = (note.privateTags || []).map(t =>
    `<span class="tag-item private">${escapeHtml(t)}</span>`
  ).join('');

  $detailContent.innerHTML = `
    <div class="detail-title">${escapeHtml(note.title || '未命名')}</div>
    <div class="detail-author">
      ${ao3Link ? `<a href="${escapeAttribute(ao3Link)}" target="_blank" rel="noopener">🔗</a> ` : ''}
      ${escapeHtml(note.author || '未知作者')}
    </div>
    ${heartsHtml ? `<div class="detail-stars" aria-label="喜欢程度 ${heartCount} 颗心">${heartsHtml}</div>` : ''}
    ${note.fandom ? `<div class="detail-field"><div class="detail-field-label">Fandom</div><div class="detail-field-value">${escapeHtml(note.fandom)}</div></div>` : ''}
    ${note.cp ? `<div class="detail-field"><div class="detail-field-label">CP</div><div class="detail-field-value">${escapeHtml(note.cp)}</div></div>` : ''}
    ${note.wordCount ? `<div class="detail-field"><div class="detail-field-label">字数</div><div class="detail-field-value">${escapeHtml(note.wordCount)}</div></div>` : ''}
    ${note.completionStatus ? `<div class="detail-field"><div class="detail-field-label">完结状态</div><div class="detail-field-value">${escapeHtml(note.completionStatus)}</div></div>` : ''}
    ${note.workId ? `<div class="detail-field"><div class="detail-field-label">门牌号</div><div class="detail-field-value">${escapeHtml(note.workId)}</div></div>` : ''}
    ${note.summary ? `<div class="detail-field"><div class="detail-field-label">文章简介</div><div class="detail-summary">${escapeHtml(note.summary)}</div></div>` : ''}
    ${ao3TagsHtml ? `<div class="detail-field"><div class="detail-field-label">AO3 标签</div><div class="detail-tags">${ao3TagsHtml}</div></div>` : ''}
    ${privateTagsHtml ? `<div class="detail-field"><div class="detail-field-label">私人 Tag</div><div class="detail-tags">${privateTagsHtml}</div></div>` : ''}
    ${note.readingDate ? `<div class="detail-field"><div class="detail-field-label">阅读日期</div><div class="detail-field-value">${note.readingDate}</div></div>` : ''}
    ${note.notes ? `<div class="detail-notes">${escapeHtml(note.notes)}</div>` : ''}
    ${note.createdAt ? `<div class="detail-date">创建于 ${new Date(note.createdAt).toLocaleDateString('zh-CN')}</div>` : ''}
  `;

  showView('detail');
}

$btnEdit.addEventListener('click', () => {
  const note = findNoteById(currentDetailId);
  if (!note) return;
  editingId = note.id;
  fillForm(note);
  restoreDraft(editingId);
  showView('form');
});

$btnDelete.addEventListener('click', () => {
  pendingDeleteId = currentDetailId;
  dialogReturnFocus = document.activeElement;
  $confirmDialog.style.display = '';
  $btnCancelDelete.focus();
});

function closeDeleteDialog() {
  pendingDeleteId = null;
  $confirmDialog.style.display = 'none';
  if (dialogReturnFocus) dialogReturnFocus.focus();
}

$btnCancelDelete.addEventListener('click', closeDeleteDialog);
$confirmDialog.addEventListener('click', event => {
  if (event.target === $confirmDialog) closeDeleteDialog();
});
$confirmDialog.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeDeleteDialog();
  if (event.key === 'Tab') {
    const buttons = [$btnConfirmDelete, $btnCancelDelete];
    const current = buttons.indexOf(document.activeElement);
    event.preventDefault();
    buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
  }
});

$btnConfirmDelete.addEventListener('click', () => {
  if (pendingDeleteId) {
    deleteAndSync(pendingDeleteId);
    pendingDeleteId = null;
  }
  $confirmDialog.style.display = 'none';
  showView('bookshelf');
  renderBookshelf();
});

// ================================================================
// AO3 自动获取（方案一：后端 API，方案二：OCR 截图识别）
// ================================================================

// 🔧 部署后请将此地址替换为你的 Render.com 后端地址
const BACKEND_URL = 'https://ao3-reader.onrender.com';

async function fetchAO3FromBackend(url) {
  const resp = await fetch(`${BACKEND_URL}/api/fetch?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(30000),
  });
  const json = await resp.json();
  if (!json.ok) {
    throw new Error(json.error || '后端获取失败');
  }
  return json.data;
}

function fillFormFromAO3Data(data) {
  if (data.title) $inputTitle.value = data.title;
  if (data.author) $inputAuthor.value = data.author;

  // Fandom
  if (data.fandom.length > 0) {
    $inputFandom.value = data.fandom.join(', ');
  }

  // CP (从 relationships 取第一个)
  if (data.relationships.length > 0) {
    $inputCp.value = data.relationships.join(', ');
  }

  // 字数
  if (data.wordCount) $inputWordcount.value = data.wordCount;

  // 完结状态推断
  if (data.chapters) {
    const parts = data.chapters.split('/');
    if (parts.length === 2 && parts[0] === parts[1]) {
      if (parts[0] === '1') $inputStatus.value = '一发完';
      else $inputStatus.value = '已完结';
    } else if (parts.length === 2 && parts[0] !== parts[1]) {
      $inputStatus.value = '连载中';
    }
  }

  // 门牌号（从链接提取 work ID）
  if (data.workId) $inputWorkId.value = data.workId;

  // AO3 标签
  const allTags = [...data.fandom, ...data.relationships, ...data.characters, ...data.freeformTags];
  formAo3Tags = [...new Set(allTags)]; // 去重
  renderTags($ao3TagsContainer, formAo3Tags, 'ao3');

  // AO3 Summary 独立保存为文章简介，不混入个人读后感
  if (data.summary) $inputSummary.value = data.summary;
  saveDraftSoon();
}

$btnAutoFetch.addEventListener('click', async () => {
  const url = $inputAo3Url.value.trim();
  if (!url) {
    showFetchStatus('请先粘贴 AO3 链接', 'error');
    return;
  }

  if (!url.includes('archiveofourown.org/works/')) {
    showFetchStatus('请输入有效的 AO3 作品链接', 'error');
    return;
  }

  showFetchStatus('正在从后端获取信息...', 'loading');
  $btnAutoFetch.disabled = true;

  try {
    const data = await fetchAO3FromBackend(url);

    if (!data.title && !data.author) {
      throw new Error('未能解析到有效信息');
    }

    fillFormFromAO3Data(data);
    showFetchStatus('✅ 信息获取成功！请核对并补充', 'success');
    $ocrSection.style.display = 'none';
  } catch (e) {
    console.error('AO3 fetch failed:', e);
    showFetchStatus('❌ 自动获取失败，试试上传截图识别？', 'error');
    $ocrSection.style.display = '';
  } finally {
    $btnAutoFetch.disabled = false;
  }
});

function showFetchStatus(msg, type) {
  $fetchStatus.style.display = '';
  $fetchStatus.textContent = msg;
  $fetchStatus.className = 'fetch-status ' + type;
}

// ================================================================
// 截图 OCR 识别（方案二：Tesseract.js）
// ================================================================

function resetOcrButton() {
  $btnUploadScreenshot.textContent = '📷 上传 AO3 页面截图';
  $btnUploadScreenshot.style.display = '';
  $ocrPreview.style.display = 'none';
  $ocrProgress.style.display = 'none';
}

$btnUploadScreenshot.addEventListener('click', () => {
  $inputScreenshot.click();
});

$inputScreenshot.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // 显示预览
  const reader = new FileReader();
  reader.onload = (ev) => {
    $ocrPreviewImg.src = ev.target.result;
    $ocrPreview.style.display = '';
  };
  reader.readAsDataURL(file);

  // 加载 Tesseract
  $btnUploadScreenshot.style.display = 'none';
  $ocrProgress.style.display = '';
  $ocrProgressText.textContent = '正在加载识别引擎...';
  $ocrProgressBar.value = 0;

  try {
    // 动态加载 Tesseract
    if (typeof Tesseract === 'undefined') {
      await loadTesseract();
    }

    $ocrProgressText.textContent = '正在识别文字...';

    const worker = await Tesseract.createWorker('chi_sim+eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          $ocrProgressBar.value = Math.round(m.progress * 100);
          $ocrProgressText.textContent = `正在识别文字... ${Math.round(m.progress * 100)}%`;
        }
      },
    });

    const { data } = await worker.recognize(file);
    await worker.terminate();

    $ocrProgressBar.value = 100;
    $ocrProgressText.textContent = '识别完成，正在提取信息...';

    const extracted = extractFieldsFromOCR(data.text);
    fillFormFromOCRData(extracted);

    $ocrProgressText.textContent = '✅ 识别完成！请核对并修正';
    setTimeout(() => { $ocrProgress.style.display = 'none'; resetOcrButton(); }, 2000);
  } catch (err) {
    console.error('OCR error:', err);
    $ocrProgressText.textContent = '❌ 识别失败，请手动填写';
    setTimeout(() => { $ocrProgress.style.display = 'none'; resetOcrButton(); }, 2000);
  }
});

function loadTesseract() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function extractFieldsFromOCR(text) {
  const result = {
    title: '',
    author: '',
    fandom: '',
    cp: '',
    wordCount: '',
    chapters: '',
    completionStatus: '',
    ao3Tags: [],
  };

  // 清洗 OCR 文本：去除明显噪声
  const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const lines = rawLines.map(l => l.replace(/[|{}[\]~`^<>«»""''…]/g, '').trim()).filter(Boolean);

  // AO3 已知值（用于分类）
  const knownRatings = /^(General Audiences|Teen And Up Audiences|Mature|Explicit|Not Rated|普遍级|辅导级|限制级|成人级|未分级)$/i;
  const knownWarnings = /^(No Archive Warnings Apply|Creator Chose Not To Use Archive Warnings|Graphic Depictions Of Violence|Major Character Death|Rape\/Non-Con|Underage)$/i;
  const knownCategories = /^(F\/F|M\/M|F\/M|Gen|Multi|Other)$/i;
  const knownStatus = /^(Completed|In Progress|Work In Progress|WIP|Ongoing|已完结|连载中|进行中|一发完)$/i;
  const ao3NavNoise  = /^(AO3|Archive of Our Own|Log In|Sign Up|Search|Works|Bookmarks|People|About|Contact|Terms|Privacy|DMCA|Top|Bottom|Previous|Next|Chapter|Entire Work|Download|Comment|Kudos|Bookmark|Mark|Subscribe|Share|Report|Menu|Home)$/i;

  // 预处理：标记已知的 Rating / Warning / Category 行
  const knownLines = new Set();
  const ratingIdx = lines.findIndex(l => knownRatings.test(l));
  const warningIdx = lines.findIndex(l => knownWarnings.test(l));
  const categoryIdx = lines.findIndex(l => knownCategories.test(l));
  if (ratingIdx >= 0) knownLines.add(ratingIdx);
  if (warningIdx >= 0) knownLines.add(warningIdx);
  if (categoryIdx >= 0) knownLines.add(categoryIdx);

  // 收集候选
  const cpCandidates = [];
  const nameCandidates = [];    // 看起来像人名的行
  const tagCandidates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (knownLines.has(i)) continue;

    // 跳过 AO3 导航/UI 噪声
    if (ao3NavNoise.test(line) && line.length < 20) continue;
    if (/^(Share|Report)$/i.test(line)) continue;

    // 跳过纯数字或纯符号行
    if (/^[\d.,/+\-\s×·•]+$/.test(line)) continue;

    // 提取 Words / 字数
    const wordsMatch = line.match(/(?:Words|字数)\s*[:：]?\s*([\d,]+)/i);
    if (wordsMatch) { result.wordCount = wordsMatch[1]; continue; }

    // 提取 Chapters / 章节
    const chMatch = line.match(/(?:Chapters|章节)\s*[:：]?\s*([\d/]+)/i);
    if (chMatch) { result.chapters = chMatch[1]; continue; }

    // 提取 Language（跳过，不作为 tag）
    if (/^(Language|语言)\s*[:：]/i.test(line)) continue;

    // 提取 Published / Updated
    if (/^(Published|Updated|发布|更新)\s*[:：]/i.test(line)) continue;

    // 检测完结状态
    if (knownStatus.test(line)) {
      if (/已完结|Completed/i.test(line)) result.completionStatus = '已完结';
      else if (/连载中|进行中|WIP|In Progress/i.test(line)) result.completionStatus = '连载中';
      else if (/一发完|One.?Shot/i.test(line)) result.completionStatus = '一发完';
      continue;
    }

    // 检测 CP / Relationship（含 "/" 且像人名）
    if (line.includes('/') && !/^\d+\/\d+$/.test(line) && !/^\d{4}\/\d{2}\/\d{2}$/.test(line)) {
      // 排除像 URL 或纯数字的
      if (!/^(https?|www)/i.test(line)) {
        cpCandidates.push(line);
        continue;
      }
    }

    // 检测作者行：以 "by " 开头，或 "by " 出现在行中
    const byMatch = line.match(/^by\s+(.+)/i);
    const inlineByMatch = line.match(/\s+by\s+(.+)$/i);
    if (byMatch) {
      result.author = byMatch[1].trim();
      // 标题 = by 前面那行
      const prevLine = lines[i - 1];
      if (prevLine && !knownRatings.test(prevLine) && !knownWarnings.test(prevLine) && !knownCategories.test(prevLine)) {
        result.title = prevLine;
      }
      continue;
    }
    if (inlineByMatch) {
      // "Title by Author" 在同一行 — OCR 把标题和作者合并了
      const titlePart = line.slice(0, line.lastIndexOf(inlineByMatch[0])).trim();
      result.author = inlineByMatch[1].trim();
      if (titlePart && !knownRatings.test(titlePart)) {
        result.title = titlePart;
      }
      continue;
    }

    // 检测下划线词（AO3 标签特征）
    if (/[A-Za-z0-9]+_[A-Za-z0-9]+/.test(line)) {
      tagCandidates.push(line);
      continue;
    }

    // 检测纯英文用户名（无空格、3-30 字符）
    if (/^[A-Za-z0-9_]{3,30}$/.test(line) && !/^(the|and|for|not|are|you|all|can|has|had|was|see|did|its|his|her)$/i.test(line)) {
      if (!result.author && i < 8) {
        result.author = line;
        continue;
      }
    }

    // 收集其他有意义行作为 tag 候选
    if (line.length > 2 && line.length < 80) {
      if (!/^(the|and|for|not|are|you|all|can|has|had|was|see|did|its|his|her|this|that|with|from|have|been|were|they|them|will|would|could|should|about|there|their|also|than|then|just|like|make|made|more|some|only|over|back|into|been|when|what|who|how|why|where|each|every|part|such|much|very|many|long|good|high|even)$/i.test(line)) {
        tagCandidates.push(line);
      }
    }
  }

  // ====== 第二轮：从候选中提取结果 ======

  // Title 兜底：如果第一轮没通过 "by" 找到，从最前面的候选行中选
  if (!result.title) {
    const topCandidates = lines.slice(0, Math.min(6, lines.length)).filter(l =>
      l.length > 2 && l.length < 200 &&
      !knownRatings.test(l) && !knownWarnings.test(l) && !knownCategories.test(l) &&
      !knownLines.has(lines.indexOf(l)) && !cpCandidates.includes(l) && l !== result.author
    );
    if (topCandidates.length > 0) {
      result.title = topCandidates[0];
    }
  }

  // 从 tagCandidates 中移除已作为 title 的行
  const ti = tagCandidates.indexOf(result.title);
  if (ti >= 0) tagCandidates.splice(ti, 1);

  // Fandom: 取前几行中像 fandom 的（含关键词 RPF, TV, Movies, Books, 或含 "&"）
  const fandomPatterns = /(RPF|TV|Movies|Books|Anime|Manga|Cartoons|Video.?Games|Theatre|Music|Celebrities|K-pop|J-pop|C-pop|Bandom)/i;
  const topLines = tagCandidates.filter(t => lines.indexOf(t) < 5);
  const fandomFromPattern = topLines.find(t => fandomPatterns.test(t));
  const fandomFromAmpersand = lines.find(l => /&/.test(l) && l.length > 5 && l.length < 60);

  if (fandomFromPattern) {
    result.fandom = fandomFromPattern.replace(/_/g, ' ');
    const fi = tagCandidates.indexOf(fandomFromPattern);
    if (fi >= 0) tagCandidates.splice(fi, 1);
  } else if (fandomFromAmpersand && !fandomFromAmpersand.includes('/')) {
    result.fandom = fandomFromAmpersand.replace(/_/g, ' ');
  } else {
    // 取前几行中第一个不包含 "/" 的行（排除 title 和 author）
    const fandomFallback = tagCandidates
      .find(t => t !== result.title && t !== result.author && !t.includes('/') && t.length > 4 && t.length < 60);
    if (fandomFallback) {
      result.fandom = fandomFallback.replace(/_/g, ' ');
    }
  }

  // CP: 取含 "/" 的最佳候选（优先选包含已知角色的）
  if (cpCandidates.length > 0) {
    // 优先选含下划线的（AO3 标签格式），其次选第一个
    const bestCp = cpCandidates.find(c => /_/.test(c)) || cpCandidates[0];
    result.cp = bestCp.replace(/_/g, ' ');
  }

  // Author fallback: 如果还没找到，从 tagCandidates 中找用户名
  if (!result.author) {
    const usernameIdx = tagCandidates.findIndex(t => /^[A-Za-z0-9_]{3,30}$/.test(t) && !knownRatings.test(t));
    if (usernameIdx >= 0) {
      result.author = tagCandidates[usernameIdx];
      tagCandidates.splice(usernameIdx, 1);
    }
  }

  // AO3 原生标签：清除掉已识别的字段
  const usedFields = new Set([result.title, result.author, result.fandom, result.cp]);
  result.ao3Tags = tagCandidates
    .filter(t => !usedFields.has(t))
    .filter(t => t.length > 2)
    .map(t => t.replace(/_/g, ' '));

  // 全文兜底搜索 Words / Chapters / Status
  if (!result.wordCount) {
    const wm = text.match(/(?:Words|字数)\s*[:：]?\s*([\d,]+)/i);
    if (wm) result.wordCount = wm[1];
  }
  if (!result.chapters) {
    const cm = text.match(/(?:Chapters|章节)\s*[:：]?\s*([\d/]+)/i);
    if (cm) result.chapters = cm[1];
  }
  if (!result.completionStatus && result.chapters) {
    const parts = result.chapters.split('/');
    if (parts.length === 2) {
      result.completionStatus = parts[0] === parts[1] ? (parts[0] === '1' ? '一发完' : '已完结') : '连载中';
    }
  }

  // 如果还没状态，全文搜
  if (!result.completionStatus) {
    if (/Completed|已完结/i.test(text)) result.completionStatus = '已完结';
    else if (/In Progress|WIP|连载中|进行中/i.test(text)) result.completionStatus = '连载中';
    else if (/One.?Shot|一发完/i.test(text)) result.completionStatus = '一发完';
  }

  return result;
}

function fillFormFromOCRData(data) {
  if (data.title && !$inputTitle.value) $inputTitle.value = data.title;
  if (data.author && !$inputAuthor.value) $inputAuthor.value = data.author;
  if (data.fandom && !$inputFandom.value) $inputFandom.value = data.fandom;
  if (data.cp && !$inputCp.value) $inputCp.value = data.cp;
  if (data.wordCount && !$inputWordcount.value) $inputWordcount.value = data.wordCount;
  if (data.completionStatus && !$inputStatus.value) $inputStatus.value = data.completionStatus;

  // AO3 原生标签
  if (data.ao3Tags && data.ao3Tags.length > 0) {
    const existing = new Set(formAo3Tags);
    data.ao3Tags.forEach(t => {
      if (!existing.has(t)) {
        formAo3Tags.push(t);
        existing.add(t);
      }
    });
    renderTags($ao3TagsContainer, formAo3Tags, 'ao3');
  }
  saveDraftSoon();
}

// ================================================================
// 初始化
// ================================================================

const $loginEmail = document.getElementById('login-email');
const $loginPassword = document.getElementById('login-password');
const $loginStatus = document.getElementById('login-status');
const $btnLogin = document.getElementById('btn-login');

function showLoginStatus(message, type = 'error') {
  $loginStatus.style.display = '';
  $loginStatus.textContent = message;
  $loginStatus.className = `fetch-status ${type}`;
}

async function handleLogin() {
  const email = $loginEmail.value.trim();
  const password = $loginPassword.value;
  if (!email || !password) {
    showLoginStatus('请输入邮箱和密码');
    return;
  }
  $btnLogin.disabled = true;
  showLoginStatus('正在登录…', 'loading');
  const { data, error } = await cloud.auth.signInWithPassword({ email, password });
  $btnLogin.disabled = false;
  if (error) {
    showLoginStatus('登录失败，请检查邮箱或密码');
    return;
  }
  currentUser = data.user;
  $loginPassword.value = '';
  $loginStatus.style.display = 'none';
  showView('bookshelf');
  renderBookshelf();
  syncWithCloud();
}

$btnLogin.addEventListener('click', handleLogin);
$loginPassword.addEventListener('keydown', event => {
  if (event.key === 'Enter') handleLogin();
});

async function init() {
  // 即时从 localStorage 加载并渲染
  loadNotes();

  // 设置默认日期
  $inputDate.value = new Date().toISOString().split('T')[0];

  // 添加 shake 动画
  const style = document.createElement('style');
  style.textContent = `
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-6px); }
      50% { transform: translateX(6px); }
      75% { transform: translateX(-4px); }
    }
  `;
  document.head.appendChild(style);

  if (!initCloudClient()) {
    showView('login');
    showLoginStatus('云端尚未配置，请先填写 config.js');
    $btnLogin.disabled = true;
    return;
  }

  const { data: { session } } = await cloud.auth.getSession();
  currentUser = session?.user || null;
  if (currentUser) {
    showView('bookshelf');
    renderBookshelf();
    syncWithCloud();
  } else {
    showView('login');
  }

  cloud.auth.onAuthStateChange((_event, sessionValue) => {
    currentUser = sessionValue?.user || null;
    if (!currentUser) showView('login');
  });
}

init();

window.addEventListener('online', () => syncWithCloud());
window.addEventListener('beforeunload', event => {
  if (!isFormDirty()) return;
  event.preventDefault();
  event.returnValue = '';
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncWithCloud();
});

// iOS 主屏 Web App 有时会在输入框失焦后保留焦点缩放。
// 输入期间临时锁定比例，失焦后恢复正常缩放能力。
const viewportMeta = document.querySelector('meta[name="viewport"]');
const normalViewport = 'width=device-width, initial-scale=1.0';
const lockedViewport = 'width=device-width, initial-scale=1.0, maximum-scale=1.0';
const isStandaloneWebApp = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

if (viewportMeta && isStandaloneWebApp) {
  document.addEventListener('focusin', event => {
    if (event.target.matches('input, textarea, select')) {
      viewportMeta.setAttribute('content', lockedViewport);
    }
  });

  document.addEventListener('focusout', event => {
    if (!event.target.matches('input, textarea, select')) return;
    viewportMeta.setAttribute('content', lockedViewport);
    setTimeout(() => {
      viewportMeta.setAttribute('content', normalViewport);
      window.scrollTo({ left: 0, top: window.scrollY, behavior: 'auto' });
    }, 350);
  });
}
