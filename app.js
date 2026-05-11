/* ================================================================
   AO3 读后感 - 数据层 & 全局状态
   ================================================================ */

const STORAGE_KEY = 'ao3_reading_notes';
const API_KEY = 'ao3-reader-2026-jiao';
let notes = [];
let currentView = 'bookshelf';
let editingId = null;
let currentDetailId = null;
let ocrWorker = null;
let activeFandom = '';
let activeCp = 'all';
let backendAvailable = false;

// ========== 后端同步 ==========

async function syncFromBackend() {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/notes?key=${encodeURIComponent(API_KEY)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.ok && json.data) {
      backendAvailable = true;
      return json.data;
    }
  } catch (e) {
    backendAvailable = false;
    console.warn('Backend unavailable, using local storage');
  }
  return null;
}

async function syncToBackend(note) {
  if (!backendAvailable) return;
  try {
    await fetch(`${BACKEND_URL}/api/notes?key=${encodeURIComponent(API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: note.id, data: note, updatedAt: note.updatedAt || new Date().toISOString() }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    backendAvailable = false;
    console.warn('Backend sync failed');
  }
}

async function deleteFromBackend(id) {
  if (!backendAvailable) return;
  try {
    await fetch(`${BACKEND_URL}/api/notes/${id}?key=${encodeURIComponent(API_KEY)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    backendAvailable = false;
  }
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

async function syncFromBackendInBackground() {
  const remote = await syncFromBackend();
  if (!remote || remote.length === 0) {
    // 本地有数据但后端为空，把本地数据推送到后端
    if (notes.length > 0) {
      backendAvailable = true;
      for (const n of notes) {
        await syncToBackend(n);
      }
    }
    return;
  }

  // 合并：以后端为主，本地数据补充（以 updatedAt 为准）
  const localMap = new Map(notes.map(n => [n.id, n]));
  const remoteMap = new Map(remote.map(n => [n.id, n]));

  for (const [id, local] of localMap) {
    const remoteNote = remoteMap.get(id);
    if (!remoteNote) {
      remoteMap.set(id, local);
    } else if (new Date(local.updatedAt) > new Date(remoteNote.updatedAt)) {
      remoteMap.set(id, local);
    }
  }

  notes = Array.from(remoteMap.values());
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  renderBookshelf();
}

function saveNotes() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

// 保存并同步到后端
function saveAndSync(note) {
  saveNotes();
  syncToBackend(note);
}

// 删除并同步到后端
function deleteAndSync(id) {
  notes = notes.filter(n => n.id !== id);
  saveNotes();
  deleteFromBackend(id);
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
const $headerTitle = document.getElementById('header-title');
const $btnBack = document.getElementById('btn-back');
const $headerActions = document.getElementById('header-actions');

function showView(view) {
  currentView = view;
  $bookshelfView.style.display = view === 'bookshelf' ? '' : 'none';
  $formView.style.display = view === 'form' ? '' : 'none';
  $detailView.style.display = view === 'detail' ? '' : 'none';

  if (view === 'bookshelf') {
    $headerTitle.textContent = '📖 我的书架';
    $btnBack.style.display = 'none';
    $headerActions.innerHTML = '';
    $btnAdd.style.display = '';
  } else if (view === 'form') {
    $headerTitle.textContent = editingId ? '编辑记录' : '添加记录';
    $btnBack.style.display = '';
    $headerActions.innerHTML = '';
    $btnAdd.style.display = 'none';
  } else if (view === 'detail') {
    $headerTitle.textContent = '文章详情';
    $btnBack.style.display = '';
    $headerActions.innerHTML = '';
    $btnAdd.style.display = 'none';
  }
}

$btnBack.addEventListener('click', () => {
  if (currentView === 'form' || currentView === 'detail') {
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
const $filterRating = document.getElementById('filter-rating');
const $filterStatus = document.getElementById('filter-status');
const $filterCp = document.getElementById('filter-cp');
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
    result = result.filter(n => {
      if (!n.cp) return false;
      const cps = n.cp.split(/[,，]/).map(s => s.trim());
      return cps.includes(activeCp);
    });
  }

  // 搜索
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    result = result.filter(n =>
      n.title.toLowerCase().includes(q) ||
      n.author.toLowerCase().includes(q)
    );
  }

  // 评分筛选
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
      n.ao3Tags.includes(activeTagFilter) ||
      n.privateTags.includes(activeTagFilter)
    );
  }

  // 排序
  const sortVal = $sortBy.value;
  switch (sortVal) {
    case 'date-desc':
      result.sort((a, b) => b.readingDate.localeCompare(a.readingDate));
      break;
    case 'date-asc':
      result.sort((a, b) => a.readingDate.localeCompare(b.readingDate));
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

function getUniqueCps(fandom) {
  const set = new Set();
  notes.forEach(n => {
    if (fandom && n.fandom !== fandom) return;
    if (!n.cp) return;
    n.cp.split(/[,，]/).forEach(s => {
      const cp = s.trim();
      if (cp) set.add(cp);
    });
  });
  return [...set];
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
    html += `<button class="fandom-tab${active}" data-fandom="${escapeHtml(f)}">${escapeHtml(f)}</button>`;
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
  let html = '<option value="all">全部 CP</option>';
  cps.forEach(cp => {
    const sel = activeCp === cp ? ' selected' : '';
    html += `<option value="${escapeHtml(cp)}"${sel}>${escapeHtml(cp)}</option>`;
  });
  $filterCp.innerHTML = html;
  $filterCp.value = activeCp;
}

function renderStarIcons(rating) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    html += i <= rating ? '★' : '☆';
  }
  return html;
}

function truncateText(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

function renderBookshelf() {
  buildFandomTabs();
  updateCpFilter();
  const filtered = getFilteredNotes();
  $resultCount.textContent = `共 ${filtered.length} 条记录`;

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
  card.addEventListener('click', () => openDetail(note.id));

  const starsHtml = renderStarIcons(note.rating);

  const privateTagsHtml = (note.privateTags || []).map(t =>
    `<span class="card-tag private" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`
  ).join('');

  card.innerHTML = `
    <div class="card-header">
      <div class="card-title">${escapeHtml(note.title || '未命名')}</div>
      <div class="card-stars">${starsHtml}</div>
    </div>
    <div class="card-meta">
      <span>${escapeHtml(note.author || '未知作者')}</span>
    </div>
    ${note.fandom ? `<div class="card-meta card-fandom"><span>${escapeHtml(note.fandom)}</span></div>` : ''}
    ${note.cp ? `<div class="card-meta card-cp"><span>${escapeHtml(note.cp)}</span></div>` : ''}
    ${note.workId ? `<div class="card-meta card-workid"><span>${escapeHtml(note.workId)}</span></div>` : ''}
    ${privateTagsHtml ? `<div class="card-tags">${privateTagsHtml}</div>` : ''}
    ${note.notes ? `<div class="card-notes-preview">${escapeHtml(note.notes)}</div>` : ''}
    <div class="card-date">${note.readingDate}</div>
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
  div.textContent = str;
  return div.innerHTML;
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
$filterCp.addEventListener('change', () => {
  activeCp = $filterCp.value;
  renderBookshelf();
});
$sortBy.addEventListener('change', () => renderBookshelf());

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
      // 合并：以 id 去重，导入的覆盖已有
      const map = new Map(notes.map(n => [n.id, n]));
      imported.forEach(n => { if (n.id) map.set(n.id, n); });
      notes = Array.from(map.values());
      saveNotes();
      // 同步到后端
      backendAvailable = true;
      imported.forEach(n => syncToBackend(n));
      renderBookshelf();
      alert(`成功导入 ${imported.length} 条记录`);
    } catch (e) {
      alert('导入失败：文件格式不正确');
    }
  };
  reader.readAsText(file);
  $inputImportFile.value = '';
});

// 添加按钮
$btnAdd.addEventListener('click', () => {
  editingId = null;
  resetForm();
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

function resetForm() {
  $inputAo3Url.value = '';
  $inputTitle.value = '';
  $inputAuthor.value = '';
  $inputFandom.value = '';
  $inputCp.value = '';
  $inputWordcount.value = '';
  $inputStatus.value = '';
  $inputWorkId.value = '';
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
  $inputDate.value = note.readingDate || new Date().toISOString().split('T')[0];
  $inputNotes.value = note.notes || '';
  formRating = note.rating || 0;
  formAo3Tags = [...(note.ao3Tags || [])];
  formPrivateTags = [...(note.privateTags || [])];
  renderStars();
  renderTags($ao3TagsContainer, formAo3Tags, 'ao3');
  renderTags($privateTagsContainer, formPrivateTags, 'private');
  updatePresetTagState();
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

// 评分组件
function renderStars() {
  const stars = $starRating.querySelectorAll('.star');
  stars.forEach(star => {
    const r = parseInt(star.dataset.rating);
    star.textContent = r <= formRating ? '★' : '☆';
    star.classList.toggle('active', r <= formRating);
  });
}

$starRating.addEventListener('click', (e) => {
  const star = e.target.closest('.star');
  if (!star) return;
  const newRating = parseInt(star.dataset.rating);
  formRating = formRating === newRating ? 0 : newRating;
  renderStars();
});

// 标签组件
function renderTags(container, tags, type) {
  container.innerHTML = tags.map(t =>
    `<span class="tag-item ${type}">
      ${escapeHtml(t)}
      <span class="tag-remove" data-tag="${escapeHtml(t)}" data-type="${type}">×</span>
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
  showView('bookshelf');
  renderBookshelf();
});

$btnCancelForm.addEventListener('click', () => {
  showView('bookshelf');
  renderBookshelf();
});

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

function openDetail(id) {
  currentDetailId = id;
  const note = findNoteById(id);
  if (!note) return;

  const starsHtml = renderStarIcons(note.rating);
  const ao3TagsHtml = (note.ao3Tags || []).map(t =>
    `<span class="tag-item ao3">${escapeHtml(t)}</span>`
  ).join('');
  const privateTagsHtml = (note.privateTags || []).map(t =>
    `<span class="tag-item private">${escapeHtml(t)}</span>`
  ).join('');

  $detailContent.innerHTML = `
    <div class="detail-title">${escapeHtml(note.title || '未命名')}</div>
    <div class="detail-author">
      ${note.ao3Url ? `<a href="${escapeHtml(note.ao3Url)}" target="_blank" rel="noopener">🔗</a> ` : ''}
      ${escapeHtml(note.author || '未知作者')}
    </div>
    <div class="detail-stars">${starsHtml}</div>
    ${note.fandom ? `<div class="detail-field"><div class="detail-field-label">Fandom</div><div class="detail-field-value">${escapeHtml(note.fandom)}</div></div>` : ''}
    ${note.cp ? `<div class="detail-field"><div class="detail-field-label">CP</div><div class="detail-field-value">${escapeHtml(note.cp)}</div></div>` : ''}
    ${note.wordCount ? `<div class="detail-field"><div class="detail-field-label">字数</div><div class="detail-field-value">${escapeHtml(note.wordCount)}</div></div>` : ''}
    ${note.completionStatus ? `<div class="detail-field"><div class="detail-field-label">完结状态</div><div class="detail-field-value">${escapeHtml(note.completionStatus)}</div></div>` : ''}
    ${note.workId ? `<div class="detail-field"><div class="detail-field-label">门牌号</div><div class="detail-field-value">${escapeHtml(note.workId)}</div></div>` : ''}
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
  showView('form');
});

$btnDelete.addEventListener('click', () => {
  pendingDeleteId = currentDetailId;
  $confirmDialog.style.display = '';
});

$btnCancelDelete.addEventListener('click', () => {
  pendingDeleteId = null;
  $confirmDialog.style.display = 'none';
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

  // 摘要预填到读后感
  if (data.summary && !$inputNotes.value) {
    $inputNotes.value = '【摘要】\n' + data.summary + '\n\n';
  }
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
}

// ================================================================
// 初始化
// ================================================================

function init() {
  // 即时从 localStorage 加载并渲染
  loadNotes();

  // 设置默认日期
  $inputDate.value = new Date().toISOString().split('T')[0];

  // 初始渲染
  showView('bookshelf');
  renderBookshelf();

  // 后台异步同步后端（不阻塞渲染）
  syncFromBackendInBackground();

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
}

init();
