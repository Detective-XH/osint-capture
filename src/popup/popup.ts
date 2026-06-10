/**
 * @module popup
 * @responsibility Manage INBOX/PREVIEW/DETAIL/SETTINGS state machine; orchestrate capture flow (content.js → background.js → preview); save/delete items
 * @owns chrome.storage.local writes (captures, pick_pending, pick_pending_item); state transitions including SCHEMA and MERGE states; _currentItems, _selectedId, _pendingItem, _dateParseRetry, _filterSchema module state; custom_fields reads/writes on _pendingItem and _currentItems[]; schema_id/schema_name stamped on CaptureItem at save time; schema-driven detail render (buildDetailField, _buildFallbackSchema, showDetail); inbox filter bar (_renderFilterBar) and schema badge rendering; #toolbar + #context-bar visibility in setState(); _refreshSchemaSelect() (context-bar schema dropdown); context-schema-select change handler
 * @not-owns Page extraction (content.js owns extractPage); SHA-256 computation (background.js owns computeHash); hub import logic; date normalization algorithm (popup-utils.js); export file generation (popup-export.js); capture messaging (popup-capture.js); settings storage (popup-settings.js); CSV merge logic (popup-merge.js)
 * @depends-on popup-utils.js (timeAgo, showStatus, normalizeDate, applyDateNormalize), popup-capture.js (captureCurrentTab, sendPickMode, checkAndClearPickResult), popup-export.js (exportItems, updateExportSelectedBtn), popup-settings.js (openSettings, saveSettings, setupOperatorInlineEdit), popup-schema.js (openSchemaEditor, getExportSchema), popup-merge.js (openMerge), chrome.storage.local (captures, pick_pending_item), chrome.tabs, chrome.runtime, crypto.randomUUID
 * @depended-by nothing — terminal UI module; no callers
 * @context popup — runs in extension popup
 * @test manual — capture a page, edit fields, save to inbox, export JSON; verify CaptureExport schema matches SCHEMA.md §5.3
 * @known-constraints EXPORT-SCHEMA-MODAL-SINGLE: schema selection UI skipped when all items share one schema_name — avoids unnecessary friction for the common single-schema case
 * @known-constraints ARTICLE-DATE-NA-PASSTHROUGH: 'na'/'NA' inputs produce null article_date (intentional — unknown date signal)
 * @known-constraints CAPTURED-AT-IMMUTABLE: captured_at is never overwritten in savePreviewItem() — immutable capture provenance per D-012
 * @known-constraints PREVIEW-BAR-DISPLAY: preview-bar visibility controlled via explicit style.display (not CSS only) because CSS hidden attribute alone was insufficient in certain browser states — Issue 4 fix (line 24)
 * @known-constraints CUSTOM-FIELDS-OMIT-EMPTY: custom_fields key is omitted from CaptureItem when all values are empty — Phase 3 export treats missing key as no custom data
 * @known-constraints SCHEMA-BINDING: schema_id and schema_name written to CaptureItem from _previewSchema at save time; captures without these fields (pre-Step 5) are normalized on loadInbox() to Default schema (id: 00000000-0000-0000-0000-000000000001)
 * @known-constraints DETAIL-PICK-CONTEXT: pick_pending_item carries _pickContext='detail' flag when pick initiated from DETAIL state; init() uses this to route pick result to showDetail() instead of showPreview()
 * @known-constraints FALLBACK-SCHEMA-DUPLICATED: _buildFallbackSchema() is also defined in popup-export.js — export variant adds `name` field for CSV filename generation; no shared import path exists without creating a circular dep (popup.js already imports popup-export.js)
 */

import type {
  CaptureItem,
  Schema,
  Column,
  PickResult,
  PickPending,
  PickPendingItem,
} from '../types';
import type {} from './popup-schema-store.js';
declare const SchemaStore: Window['SchemaStore'];
import { timeAgo, showStatus, normalizeDate, applyDateNormalize } from './popup-utils.js';
import { captureCurrentTab, sendPickMode, checkAndClearPickResult } from './popup-capture.js';
import { exportItems, updateExportSelectedBtn } from './popup-export.js';
import { openSettings, saveSettings, setupOperatorInlineEdit } from './popup-settings.js';
import { openSchemaEditor, getExportSchema } from './popup-schema.js';
import { openMerge } from './popup-merge.js';

// OSINT Capture — Popup UI

// ── State machine ──────────────────────────────────────────────────────────

const STATE = {
  INBOX: 'INBOX',
  PREVIEW: 'PREVIEW',
  DETAIL: 'DETAIL',
  SETTINGS: 'SETTINGS',
  SCHEMA: 'SCHEMA',
  MERGE: 'MERGE',
};
let _state = STATE.INBOX;
let _currentItems: CaptureItem[] = [];
let _selectedId: string | null = null;
let _pendingItem: PickPendingItem | null = null; // item in preview, not yet saved to storage
let _dateParseRetry = false; // WHY: two-Enter flow — first Enter warns on parse failure, second accepts raw as-is
let _previewSchema: Schema | null = null; // WHY: cached schema from last showPreview() call; savePreviewItem() reads same schema that was rendered
let _filterSchema = 'All'; // WHY: schema filter for inbox list; intentionally non-persistent — resets each popup open per spec

function setState(newState: string) {
  _state = newState;

  const inbox = document.getElementById('inbox') as HTMLElement;
  const previewPanel = document.getElementById('preview-panel') as HTMLElement;
  const previewBar = document.getElementById('preview-bar') as HTMLElement;
  const detail = document.getElementById('detail-panel') as HTMLElement;
  const settings = document.getElementById('settings-panel') as HTMLElement;
  const schema = document.getElementById('schema-panel') as HTMLElement;
  const merge = document.getElementById('merge-panel') as HTMLElement;
  const toolbar = document.getElementById('toolbar') as HTMLElement;
  const contextBar = document.getElementById('context-bar') as HTMLElement;

  // Hide everything first
  inbox.hidden = true;
  previewPanel.hidden = true;
  previewBar.style.display = 'none'; // WHY: Issue 4 — explicit display control, not CSS-only
  detail.hidden = true;
  settings.hidden = true;
  schema.hidden = true;
  merge.hidden = true;
  // WHY: both chrome rows hidden by default; only shown for INBOX/PREVIEW/DETAIL
  toolbar.hidden = true;
  contextBar.hidden = true;

  switch (newState) {
    case STATE.INBOX:
      inbox.hidden = false;
      toolbar.hidden = false;
      contextBar.hidden = false;
      _refreshSchemaSelect(); // WHY: refresh on every INBOX entry — schema list may have changed in SCHEMA state
      break;
    case STATE.PREVIEW:
      previewPanel.hidden = false;
      previewBar.style.display = 'flex'; // WHY: Issue 4 — only shown in PREVIEW
      toolbar.hidden = false;
      contextBar.hidden = false;
      break;
    case STATE.DETAIL:
      detail.hidden = false;
      toolbar.hidden = false;
      contextBar.hidden = false;
      break;
    case STATE.SETTINGS:
      settings.hidden = false;
      // WHY: sub-page owns full panel height; chrome rows stay hidden (set above)
      break;
    case STATE.SCHEMA:
      schema.hidden = false;
      // WHY: sub-page owns full panel height; chrome rows stay hidden (set above)
      break;
    case STATE.MERGE:
      merge.hidden = false;
      // WHY: sub-page owns full panel height; chrome rows stay hidden (set above)
      break;
  }
}

// ── Storage helpers ────────────────────────────────────────────────────────

// WHY: must equal popup-schema-store.js DEFAULT_SCHEMA_ID — duplicated here to avoid
// importing a non-exported const; used only for backward-compat normalization of old captures
const _DEFAULT_SCHEMA_ID = '00000000-0000-0000-0000-000000000001';

// WHY: old captures (pre-Step 5) have no schema_id/schema_name/custom_fields;
// normalize on read so all in-memory items have a consistent shape
function _normalizeCapture(item: CaptureItem): CaptureItem {
  return {
    ...item,
    schema_id: item.schema_id ?? _DEFAULT_SCHEMA_ID,
    schema_name: item.schema_name ?? 'Default',
    custom_fields: item.custom_fields ?? {},
  };
}

function loadInbox() {
  return new Promise<CaptureItem[]>((resolve) => {
    chrome.storage.local.get('captures', (result) => {
      const raw = Array.isArray(result.captures) ? (result.captures as CaptureItem[]) : [];
      resolve(raw.map(_normalizeCapture));
    });
  });
}

function saveInbox(items: CaptureItem[]) {
  return new Promise<void>((resolve) => {
    chrome.storage.local.set({ captures: items }, resolve);
  });
}

// ── Inbox rendering ────────────────────────────────────────────────────────

// WHY: renders sticky filter bar at top of #inbox — dropdown for schema filter + live count;
// called by renderInbox only when items.length > 0;
// allSchemas from SchemaStore so schemas with zero captures still appear in filter
function _renderFilterBar(inbox: HTMLElement, items: CaptureItem[], allSchemas: Schema[]) {
  const bar = document.createElement('div');
  bar.className = 'inbox-filter-bar';

  const sel = document.createElement('select');
  sel.className = 'inbox-filter-select';

  const allOpt = document.createElement('option');
  allOpt.value = 'All';
  allOpt.textContent = 'All Items';
  if (_filterSchema === 'All') allOpt.selected = true;
  sel.appendChild(allOpt);

  for (const schema of allSchemas) {
    // WHY: allSchemas includes schemas with zero captures
    const opt = document.createElement('option');
    opt.value = schema.name;
    opt.textContent = schema.name;
    if (_filterSchema === schema.name) opt.selected = true;
    sel.appendChild(opt);
  }

  sel.addEventListener('change', () => {
    _filterSchema = sel.value;
    renderInbox(_currentItems, _selectedId);
  });

  bar.appendChild(sel);

  // Count: "12 items" or "5 of 12 items"
  const displayCount =
    _filterSchema === 'All'
      ? items.length
      : items.filter((i) => i.schema_name === _filterSchema).length;
  const countEl = document.createElement('span');
  countEl.className = 'inbox-filter-count';
  countEl.textContent =
    _filterSchema === 'All' ? `${items.length} items` : `${displayCount} of ${items.length}`;
  bar.appendChild(countEl);

  inbox.appendChild(bar);
}

async function renderInbox(items: CaptureItem[], selectedId: string | null = null) {
  // WHY: async to await SchemaStore.getAllSchemas for full schema list
  _currentItems = items;
  _selectedId = selectedId;

  const exportAllBtn = document.getElementById('btn-export-all') as HTMLButtonElement;
  if (exportAllBtn) exportAllBtn.disabled = items.length === 0;

  const inbox = document.getElementById('inbox') as HTMLElement;
  inbox.innerHTML = '';

  if (items.length === 0) {
    inbox.innerHTML =
      '<div class="inbox-empty">No captures yet.<br>Click "Capture current tab" to start.</div>';
    return;
  }

  const allSchemas = await SchemaStore.getAllSchemas(); // WHY: full schema list so filter shows schemas with zero captures
  const allSchemaNames = allSchemas.map((s) => s.name);

  // WHY: defensive reset — if the active filter no longer exists (schema deleted), fall back to All
  if (_filterSchema !== 'All' && !allSchemaNames.includes(_filterSchema)) {
    _filterSchema = 'All';
  }

  _renderFilterBar(inbox, items, allSchemas);

  // Apply schema filter client-side on already-loaded captures[]
  const displayItems =
    _filterSchema === 'All' ? items : items.filter((i) => i.schema_name === _filterSchema);

  if (displayItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'inbox-empty';
    empty.textContent = 'No items match the selected schema filter.';
    inbox.appendChild(empty);
    return;
  }

  for (const item of displayItems) {
    const row = document.createElement('div');
    row.className = 'inbox-item' + (item.id === selectedId ? ' selected' : '');
    row.dataset.id = item.id;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.onclick = (e) => e.stopPropagation();
    cb.addEventListener('change', updateExportSelectedBtn);

    const body = document.createElement('div');
    body.className = 'inbox-item-body';

    const titleEl = document.createElement('div');
    titleEl.className = 'inbox-item-title';
    titleEl.textContent = item.title || '(untitled)';

    const meta = document.createElement('div');
    meta.className = 'inbox-item-meta';
    const source = item.source || '';
    // Sort key: article_date if available, else captured_at (fallback)
    const sortDate = item.article_date || item.captured_at || '';
    const ago = timeAgo(sortDate);
    meta.textContent = source && ago ? `${source} · ${ago}` : source || ago;

    // WHY: schema badge — small muted tag so user can see which schema each capture belongs to
    const badge = document.createElement('span');
    badge.className = 'inbox-schema-badge';
    badge.textContent = item.schema_name || 'Default';

    body.appendChild(titleEl);
    body.appendChild(meta);
    body.appendChild(badge);

    // Clicking the body (not checkbox) opens detail
    body.addEventListener('click', () => showDetail(item));

    row.appendChild(cb);
    row.appendChild(body);

    // Issue 3a: × delete button (visible on hover via CSS)
    const delBtn = document.createElement('button');
    delBtn.className = 'inbox-item-delete';
    delBtn.textContent = '×';
    delBtn.title = 'Delete';
    delBtn.onclick = (e) => {
      e.stopPropagation();
      delBtn.hidden = true;
      const confirmEl = document.createElement('span');
      confirmEl.className = 'inbox-delete-confirm';
      const yesBtn = document.createElement('button');
      yesBtn.className = 'btn-confirm-yes';
      yesBtn.textContent = 'Yes';
      yesBtn.onclick = async (ev) => {
        ev.stopPropagation();
        const updated = _currentItems.filter((i) => i.id !== item.id);
        await saveInbox(updated);
        _currentItems = updated;
        renderInbox(updated, _selectedId === item.id ? null : _selectedId);
      };
      const noBtn = document.createElement('button');
      noBtn.className = 'btn-confirm-no';
      noBtn.textContent = 'No';
      noBtn.onclick = (ev) => {
        ev.stopPropagation();
        confirmEl.remove();
        delBtn.hidden = false;
      };
      confirmEl.appendChild(document.createTextNode('Delete?'));
      confirmEl.appendChild(yesBtn);
      confirmEl.appendChild(noBtn);
      row.appendChild(confirmEl);
    };
    row.appendChild(delBtn);

    inbox.appendChild(row);
  }
}

// ── Preview state ──────────────────────────────────────────────────────────

// WHY: determines rendering behaviour for each schema column:
// - content → textarea with constrained height
// - captured_at / content_hash → readonly input (immutable or auto-computed)
// - title, url, source, author, article_date, content → pickable (Pick button rendered; wired in Step 4)
// - source === null → custom column; value keyed by col.name in custom_fields
function buildPreviewField(container: HTMLElement, col: Column, item: CaptureItem) {
  const isContent = col.source === 'content';
  const isReadonly = col.source === 'captured_at' || col.source === 'content_hash';
  const PICKABLE = ['title', 'url', 'source', 'author', 'content', 'article_date'];
  const isPickable = col.source !== null && PICKABLE.includes(col.source) && !isReadonly;

  // Determine initial value
  const value =
    col.source !== null
      ? ((item as unknown as Record<string, unknown>)[col.source] as string) || ''
      : item.custom_fields?.[col.name] || '';

  const div = document.createElement('div');
  div.className = 'preview-field';

  const label = document.createElement('label');
  label.textContent = col.name;
  div.appendChild(label);

  // Build input or textarea
  const inputEl = isContent ? document.createElement('textarea') : document.createElement('input');
  // WHY: data-col-id used by savePreviewItem() to read values by stable UUID, not positional index
  inputEl.dataset.colId = col.id;
  inputEl.dataset.source = col.source ?? '';
  inputEl.value = value;

  if (!isContent) (inputEl as HTMLInputElement).type = 'text';
  if (isReadonly) inputEl.readOnly = true;

  // WHY: article_date input must keep id="prev-published" so applyDateNormalize() in popup-utils.js
  // can find it via document.getElementById — that file cannot be modified (Step 3 constraint)
  if (col.source === 'article_date') {
    inputEl.id = 'prev-published';
    inputEl.placeholder = 'YYYYMMDDHHMMSS or na if unknown ⏎';
  }

  if (isPickable) {
    const row = document.createElement('div');
    row.className = isContent ? 'preview-input-row' : 'preview-input-row';
    row.appendChild(inputEl);

    // WHY: data-pick-source used by event delegation handler below to identify target field
    const pickBtn = document.createElement('button');
    pickBtn.className = 'btn-pick';
    pickBtn.dataset.pickSource = col.source as string;
    pickBtn.dataset.colId = col.id;
    pickBtn.title = `Select "${col.source}" from page`;
    pickBtn.textContent = 'Pick';
    row.appendChild(pickBtn);
    div.appendChild(row);
  } else {
    div.appendChild(inputEl);
  }

  // WHY: date hint span keeps id="date-hint" for applyDateNormalize() compatibility (same reason as prev-published)
  if (col.source === 'article_date') {
    const hint = document.createElement('span');
    hint.id = 'date-hint';
    hint.className = 'date-hint';
    div.appendChild(hint);
  }

  container.appendChild(div);
}

// WHY: synthetic schema used when item.schema_id refers to a deleted schema —
// renders all standard source fields + any custom_fields keys the item already has
function _buildFallbackSchema(item: CaptureItem): { columns: Column[] } {
  const STD = [
    'title',
    'url',
    'source',
    'author',
    'captured_at',
    'article_date',
    'content',
    'content_hash',
  ];
  const cols: Column[] = STD.map((src) => ({ id: src, name: src.replace(/_/g, ' '), source: src }));
  // Render surviving custom_fields by key name (may be col.name or col.id from old saves)
  for (const key of Object.keys(item.custom_fields || {})) {
    cols.push({ id: key, name: key, source: null });
  }
  return { columns: cols };
}

// WHY: determines rendering behaviour for each schema column in detail view:
// - content → textarea; others → input
// - ALL fields editable (user can correct post-capture — no readonly constraint like Preview)
// - pickable fields (title, url, source, author, content, article_date) get Pick button
// - cross-URL pick shows inline warning; user may still proceed
function buildDetailField(
  container: HTMLElement,
  col: Column,
  item: CaptureItem,
  currentUrl: string,
) {
  const isContent = col.source === 'content';
  const PICKABLE = ['title', 'url', 'source', 'author', 'content', 'article_date'];
  const isPickable = col.source !== null && PICKABLE.includes(col.source);

  // Custom field: try col.name first (saved by savePreviewItem), fall back to col.id
  // WHY: pre-Step-6 detail auto-save used col.id; preview uses col.name — dual read for compat
  const value =
    col.source !== null
      ? (((item as unknown as Record<string, unknown>)[col.source] as string) ?? '')
      : item.custom_fields?.[col.name] || item.custom_fields?.[col.id] || '';

  const div = document.createElement('div');
  div.className = 'detail-field';

  const label = document.createElement('label');
  label.textContent = col.name;
  div.appendChild(label);

  const inputEl = isContent ? document.createElement('textarea') : document.createElement('input');
  inputEl.className = isContent ? 'detail-textarea' : 'detail-input';
  inputEl.dataset.colId = col.id;
  inputEl.dataset.source = col.source ?? '';
  inputEl.dataset.colName = col.name;
  inputEl.value = value;
  if (!isContent) (inputEl as HTMLInputElement).type = 'text';

  if (isPickable) {
    const row = document.createElement('div');
    row.className = 'preview-input-row'; // reuse preview row layout (flex + gap)
    row.appendChild(inputEl);

    const pickBtn = document.createElement('button');
    pickBtn.className = 'btn-pick';
    pickBtn.dataset.pickSource = col.source as string;
    pickBtn.dataset.colId = col.id;
    pickBtn.title = `Pick "${col.source}" from page`;
    pickBtn.textContent = 'Pick';
    row.appendChild(pickBtn);
    div.appendChild(row);

    // WHY: warn user if current tab differs from captured URL — pick may return unrelated content
    if (currentUrl && item.url && currentUrl !== item.url) {
      const warn = document.createElement('div');
      warn.className = 'detail-pick-warn';
      warn.textContent =
        'Current page differs from captured URL. Pick may return unrelated content.';
      div.appendChild(warn);
    }
  } else {
    div.appendChild(inputEl);
  }

  container.appendChild(div);
}

async function showPreview(item: CaptureItem) {
  _pendingItem = {
    id: crypto.randomUUID(),
    ...(item as Omit<CaptureItem, 'id'>),
  } as PickPendingItem;
  _dateParseRetry = false;

  // WHY: fetch + cache schema; savePreviewItem() uses same schema so element IDs match
  const schema = await getExportSchema();
  _previewSchema = schema;

  const container = document.getElementById('preview-fields') as HTMLElement;
  container.innerHTML = '';
  schema.columns.forEach((col) => buildPreviewField(container, col, item));

  setState(STATE.PREVIEW);
}

async function savePreviewItem() {
  if (!_pendingItem || !_previewSchema) return;

  const container = document.getElementById('preview-fields') as HTMLElement;
  const custom_fields: Record<string, string> = {};

  for (const col of _previewSchema.columns) {
    // WHY: captured_at is immutable (CAPTURED-AT-IMMUTABLE constraint); content_hash auto-computed by background.js
    if (col.source === 'captured_at' || col.source === 'content_hash') continue;

    const el = container.querySelector(`[data-col-id="${col.id}"]`) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (!el) continue;

    if (col.source === 'article_date') {
      // WHY: defense-in-depth normalization — applies even if user skipped Enter/blur (EXT-DATE-NORMALIZE)
      const raw = el.value;
      const norm = normalizeDate(raw);
      _pendingItem.article_date =
        !norm.failed && norm.iso !== null ? norm.iso : norm.failed ? raw.trim() || null : null;
    } else if (col.source !== null) {
      // WHY: content kept verbatim (no trim) to preserve formatting; all other fields trimmed
      (_pendingItem as unknown as Record<string, unknown>)[col.source] =
        col.source === 'content' ? el.value : el.value.trim();
    } else {
      // WHY: custom columns keyed by display name (col.name) per Step 3 schema-driven spec;
      // empty values omitted — export treats missing key as empty (saves space)
      const val = el.value.trim();
      if (val) custom_fields[col.name] = val;
    }
  }

  if (Object.keys(custom_fields).length > 0) {
    _pendingItem.custom_fields = custom_fields;
  }

  // WHY: bind active schema at save time — provenance for future schema-aware display/migration
  _pendingItem.schema_id = _previewSchema.id;
  _pendingItem.schema_name = _previewSchema.name;

  const savedId = _pendingItem.id;
  const updated = [_pendingItem, ..._currentItems];
  _pendingItem = null;

  await saveInbox(updated);
  _currentItems = updated;
  setState(STATE.INBOX);
  renderInbox(updated, null);

  // Flash the newly saved row green
  requestAnimationFrame(() => {
    const row = document.querySelector(`#inbox .inbox-item[data-id="${savedId}"]`);
    if (row) {
      row.classList.add('flash-success');
      setTimeout(() => row.classList.remove('flash-success'), 700);
    }
  });
}

function discardPreview() {
  _pendingItem = null;
  setState(STATE.INBOX);
}

// ── Detail state ───────────────────────────────────────────────────────────

async function showDetail(item: CaptureItem) {
  _selectedId = item.id;

  // WHY: resolve schema from item's bound schema_id; fall back to synthetic schema
  // if the schema was deleted since capture — never silently drops field data
  let schema: { columns: Column[] } | null = await SchemaStore.getSchemaById(item.schema_id);
  const usingFallback = !schema;
  if (usingFallback) schema = _buildFallbackSchema(item);

  // Render header: schema name label + deleted-schema notice when applicable
  const header = document.getElementById('detail-header') as HTMLElement;
  header.innerHTML = '';
  const nameEl = document.createElement('span');
  nameEl.className = 'detail-schema-name';
  nameEl.textContent = item.schema_name || 'Default';
  header.appendChild(nameEl);
  if (usingFallback) {
    const warnEl = document.createElement('span');
    warnEl.className = 'detail-schema-warn';
    warnEl.textContent = ' (schema deleted)';
    header.appendChild(warnEl);
  }

  // Get current tab URL so buildDetailField can show cross-URL pick warnings
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentUrl = tabs[0]?.url || '';

  const container = document.getElementById('detail-fields') as HTMLElement;
  container.innerHTML = '';
  for (const col of schema!.columns) {
    buildDetailField(container, col, item, currentUrl);
  }

  // Reset delete button (in case inline confirm was left open from a prior view)
  const deleteBtn = document.getElementById('btn-delete') as HTMLButtonElement | null;
  if (deleteBtn) {
    deleteBtn.hidden = false;
    deleteBtn.onclick = () => confirmDelete(item);
  }

  setState(STATE.DETAIL);
  // WHY: renderInbox updates selection highlight; re-show detail+hide inbox after
  // because setState(DETAIL) hides inbox but renderInbox would show it again
  renderInbox(_currentItems, item.id);
  (document.getElementById('detail-panel') as HTMLElement).hidden = false;
  (document.getElementById('inbox') as HTMLElement).hidden = true;
}

function confirmDelete(item: CaptureItem) {
  const actions = document.getElementById('detail-actions') as HTMLElement;
  const deleteBtn = document.getElementById('btn-delete') as HTMLElement;
  deleteBtn.hidden = true;

  const confirm = document.createElement('div');
  confirm.className = 'delete-confirm';
  confirm.innerHTML = 'Delete this item?';

  const yes = document.createElement('button');
  yes.className = 'btn-confirm-yes';
  yes.textContent = 'Yes';
  yes.onclick = async () => {
    const updated = _currentItems.filter((i) => i.id !== item.id);
    await saveInbox(updated);
    _currentItems = updated;
    _selectedId = null;
    setState(STATE.INBOX);
    renderInbox(updated, null);
  };

  const no = document.createElement('button');
  no.className = 'btn-confirm-no';
  no.textContent = 'No';
  no.onclick = () => {
    confirm.remove();
    deleteBtn.hidden = false;
  };

  confirm.appendChild(yes);
  confirm.appendChild(no);
  actions.appendChild(confirm);
}

// ── Export schema selection ────────────────────────────────────────────────

// WHY: when items span multiple schemas, show a schema selection modal before
// downloading — avoids silently exporting schemas the user didn't intend to include.
// Single-schema sets skip the modal entirely (EXPORT-SCHEMA-MODAL-SINGLE constraint).
function _showSchemaExportModal(items: CaptureItem[], onExport: (items: CaptureItem[]) => void) {
  // Group items by schema_name for display and filtering
  const groups = new Map<string, CaptureItem[]>();
  for (const item of items) {
    const name = item.schema_name || 'Default';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(item);
  }

  // WHY: single schema — no point showing selection UI; export immediately
  if (groups.size <= 1) {
    onExport(items);
    return;
  }

  // Build modal overlay
  const overlay = document.createElement('div');
  overlay.id = 'export-schema-modal';

  const inner = document.createElement('div');
  inner.className = 'export-modal-inner';

  const title = document.createElement('div');
  title.className = 'export-modal-title';
  title.textContent = 'Select schemas to export';
  inner.appendChild(title);

  // "Select all" row
  const selectAllRow = document.createElement('div');
  selectAllRow.className = 'export-modal-schema-row';
  const selectAllCb = document.createElement('input');
  selectAllCb.type = 'checkbox';
  selectAllCb.checked = true;
  const selectAllLabel = document.createElement('label');
  selectAllLabel.textContent = 'Select all';
  selectAllRow.appendChild(selectAllCb);
  selectAllRow.appendChild(selectAllLabel);

  const list = document.createElement('div');
  list.className = 'export-modal-schema-list';
  list.appendChild(selectAllRow);

  // Schema rows
  const schemaCheckboxes: HTMLInputElement[] = [];
  for (const [name, groupItems] of groups) {
    const row = document.createElement('div');
    row.className = 'export-modal-schema-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.schemaName = name;
    const lbl = document.createElement('label');
    lbl.textContent = `${name} (${groupItems.length})`;
    row.appendChild(cb);
    row.appendChild(lbl);
    list.appendChild(row);
    schemaCheckboxes.push(cb);
  }

  // WHY: "Select all" drives schema checkboxes; individual unchecks clear "select all"
  selectAllCb.addEventListener('change', () => {
    schemaCheckboxes.forEach((cb) => {
      cb.checked = selectAllCb.checked;
    });
  });
  schemaCheckboxes.forEach((cb) => {
    cb.addEventListener('change', () => {
      selectAllCb.checked = schemaCheckboxes.every((c) => c.checked);
    });
  });

  inner.appendChild(list);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'export-modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn-primary';
  exportBtn.textContent = 'Export';
  exportBtn.addEventListener('click', () => {
    const selected = new Set(
      schemaCheckboxes.filter((cb) => cb.checked).map((cb) => cb.dataset.schemaName),
    );
    const filtered = items.filter((i) => selected.has(i.schema_name || 'Default'));
    overlay.remove();
    onExport(filtered);
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(exportBtn);
  inner.appendChild(actions);
  overlay.appendChild(inner);
  document.body.appendChild(overlay);
}

// ── Schema selector ────────────────────────────────────────────────────────

// WHY: repopulates #context-schema-select on every toolbar-visible state entry so
// any create/rename/delete done inside the SCHEMA editor is reflected immediately
async function _refreshSchemaSelect() {
  const sel = document.getElementById('context-schema-select');
  if (!sel) return;
  const [schemas, active] = await Promise.all([
    SchemaStore.getAllSchemas(),
    SchemaStore.getActiveSchema(),
  ]);
  sel.innerHTML = '';
  for (const s of schemas) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    if (s.id === active.id) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line complexity -- popup bootstrap: resumes a pending Pick then wires ~18 DOM event handlers. A verified-safe split into _wire*() helpers exists (all shared state is module-level); deferred as mechanical churn with low value vs. this branch's size.
async function init() {
  // Operator name
  const opResult = await new Promise((resolve) =>
    chrome.storage.local.get('operator_name', resolve),
  );
  const opName = (opResult as Record<string, string>).operator_name || '';
  const opDisplay = document.getElementById('operator-name-display');
  if (opDisplay) opDisplay.textContent = opName;
  setupOperatorInlineEdit();
  await _refreshSchemaSelect(); // WHY: initial population of context-bar schema dropdown

  // If no operator set, open settings first
  if (!opName) {
    await openSettings(setState); // WHY: callback — setState owned by popup.js
  }

  // Check for pending pick result from selection assist
  const pending = (await checkAndClearPickResult()) as {
    pickResult: PickResult;
    pickPending: PickPending;
  } | null;
  const items = await loadInbox();
  _currentItems = items;

  setState(STATE.INBOX);
  renderInbox(items);

  if (pending) {
    const { pickResult, pickPending } = pending;
    if (pickPending?.itemId && pickResult?.value) {
      const stored = await new Promise<PickPendingItem | null>((resolve) =>
        chrome.storage.local.get(['pick_pending_item'], (r) =>
          resolve((r.pick_pending_item ?? null) as PickPendingItem | null),
        ),
      );
      if (stored) chrome.storage.local.remove('pick_pending_item');
      const field = pickPending.field;
      const DIRECT_PICK = ['title', 'url', 'source', 'author', 'content'];

      // WHY: _pickContext='detail' means pick was initiated from DETAIL state;
      // route result back to showDetail() on the live _currentItems entry (not showPreview)
      if (stored?._pickContext === 'detail') {
        const item = _currentItems.find((i) => i.id === pickPending.itemId);
        if (item && field) {
          if (DIRECT_PICK.includes(field)) {
            (item as unknown as Record<string, unknown>)[field] = pickResult.value;
          } else if (field === 'article_date') {
            const norm = normalizeDate(pickResult.value);
            item.article_date =
              !norm.failed && norm.iso !== null ? norm.iso : pickResult.value || null;
          }
          await saveInbox(_currentItems);
          await showDetail(item);
          showStatus(`"${field}" updated from page selection.`);
        }
      } else {
        // Preview pick resume (existing flow)
        if (stored) _pendingItem = stored;
        if (_pendingItem && field) {
          let _pickStatusShown = false;
          if (DIRECT_PICK.includes(field)) {
            (_pendingItem as unknown as Record<string, unknown>)[field] = pickResult.value;
          } else if (field === 'article_date') {
            // WHY: normalize picked date text; fall back to raw on parse failure per Step 4 spec
            const norm = normalizeDate(pickResult.value);
            _pendingItem.article_date =
              !norm.failed && norm.iso !== null ? norm.iso : pickResult.value || null;
            if (norm.failed && pickResult.value) {
              showStatus('Date not recognized — raw text filled. Edit manually.', true);
              _pickStatusShown = true;
            }
          }
          // WHY: await required — showPreview now async (getExportSchema call inside)
          await showPreview(_pendingItem);
          if (!_pickStatusShown) showStatus(`"${field}" updated from page selection.`);
        }
      }
    }
  }

  // ── Button wiring ──────────────────────────────────────────────────────

  // WHY: context-bar schema select — changing active schema determines which columns are used on next capture
  (document.getElementById('context-schema-select') as HTMLElement).addEventListener(
    'change',
    async (e) => {
      await SchemaStore.setActiveSchema((e.target as HTMLSelectElement).value);
    },
  );

  // WHY: captureCurrentTab callback — showPreview is popup.js state mutator; avoid circular import
  (document.getElementById('btn-capture') as HTMLElement).addEventListener('click', () =>
    captureCurrentTab(showPreview as unknown as Parameters<typeof captureCurrentTab>[0]),
  );

  (document.getElementById('btn-export-all') as HTMLElement).addEventListener('click', () => {
    _showSchemaExportModal(_currentItems, exportItems);
  });

  (document.getElementById('btn-export-selected') as HTMLElement).addEventListener('click', () => {
    const checked = (
      [...document.querySelectorAll('#inbox input[type=checkbox]:checked')]
        .map((cb) => cb.closest('.inbox-item'))
        .filter(Boolean) as HTMLElement[]
    )
      .map((row) => _currentItems.find((i) => i.id === row.dataset.id))
      .filter(Boolean) as CaptureItem[];
    _showSchemaExportModal(checked, exportItems);
  });

  // WHY: openSettings callback — setState owned by popup.js; direct call avoided to prevent circular import
  (document.getElementById('btn-settings') as HTMLElement).addEventListener('click', () =>
    openSettings(setState),
  );

  // WHY: openSchemaEditor callback injection — setState + onSaved owned by popup.js; prevents circular import
  (document.getElementById('btn-customize-schema') as HTMLElement).addEventListener('click', () => {
    openSchemaEditor(setState, () => setState(STATE.SETTINGS));
  });

  // WHY: ⊕ button triggers folder selection → CSV merge flow.
  // Callback injection: openMerge receives setState for FSM control.
  (document.getElementById('btn-merge') as HTMLElement).addEventListener('click', () =>
    openMerge(setState),
  );
  (document.getElementById('btn-merge-cancel') as HTMLElement).addEventListener('click', () => {
    setState(STATE.INBOX);
    renderInbox(_currentItems, _selectedId);
  });

  (document.getElementById('btn-save') as HTMLElement).addEventListener('click', savePreviewItem);
  (document.getElementById('btn-discard') as HTMLElement).addEventListener('click', discardPreview);

  (document.getElementById('btn-close-detail') as HTMLElement).addEventListener('click', () => {
    _selectedId = null;
    setState(STATE.INBOX);
    renderInbox(_currentItems, null);
  });

  // WHY: saveSettings callbacks — setState + renderInbox owned by popup.js; closure preserves _currentItems/_selectedId at call time
  (document.getElementById('btn-settings-save') as HTMLElement).addEventListener('click', () =>
    saveSettings(setState, () => renderInbox(_currentItems, _selectedId)),
  );
  (document.getElementById('btn-settings-cancel') as HTMLElement).addEventListener('click', () => {
    setState(STATE.INBOX);
    renderInbox(_currentItems, _selectedId);
  });

  // ── Date normalization UX for article_date field ───────────────────────
  // WHY: event delegation on #preview-fields so handlers work regardless of when the
  // article_date input is rendered by buildPreviewField(); avoids capturing a null ref
  // at init time. applyDateNormalize() uses id="prev-published" and id="date-hint" which
  // buildPreviewField() assigns to the article_date input and its hint span.
  const _previewFieldsEl = document.getElementById('preview-fields') as HTMLElement;

  _previewFieldsEl.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).id !== 'prev-published') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      _dateParseRetry = applyDateNormalize(_pendingItem, _dateParseRetry);
    }
  });
  _previewFieldsEl.addEventListener(
    'blur',
    (e) => {
      if ((e.target as HTMLElement).id !== 'prev-published') return;
      // blur: normalize if possible, silently accept raw on failure
      _dateParseRetry = applyDateNormalize(_pendingItem, false);
    },
    true,
  ); // WHY: useCapture=true because blur does not bubble
  _previewFieldsEl.addEventListener('input', (e) => {
    if ((e.target as HTMLElement).id !== 'prev-published') return;
    // WHY: user editing after a failed parse — reset retry flag and clear warning
    _dateParseRetry = false;
    const hint = document.getElementById('date-hint');
    if (hint) {
      hint.textContent = '';
      hint.className = 'date-hint';
    }
  });

  // WHY: event delegation on #preview-fields — pick buttons are dynamically rendered by
  // buildPreviewField(); delegating here avoids re-wiring on each showPreview() call.
  _previewFieldsEl.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).classList.contains('btn-pick')) return;
    const field = (e.target as HTMLElement).dataset.pickSource;
    if (!field || !_pendingItem) return;
    // WHY: persist _pendingItem before popup closes — on re-open, init() restores from
    // pick_pending_item and applies the pick result (chrome.storage round-trip)
    chrome.storage.local.set({ pick_pending_item: _pendingItem }, () => {
      sendPickMode(_pendingItem!.id, field);
      window.close();
    });
  });

  // WHY: auto-save all field edits on blur in Detail view — no explicit save button.
  // Delegation on #detail-fields covers both standard and custom fields.
  // useCapture=true because blur does not bubble.
  (document.getElementById('detail-fields') as HTMLElement).addEventListener(
    'blur',
    async (e) => {
      const el = e.target as HTMLInputElement | HTMLTextAreaElement;
      if (!el.classList.contains('detail-input') && !el.classList.contains('detail-textarea'))
        return;
      const colSource = el.dataset.source; // '' for custom columns
      const colName = el.dataset.colName!;
      // WHY: content kept verbatim; all other fields trimmed (same rule as savePreviewItem)
      const val = colSource === 'content' ? el.value : el.value.trim();
      const item = _currentItems.find((i) => i.id === _selectedId);
      if (!item) return;
      if (colSource) {
        // Standard field: write directly onto item
        (item as unknown as Record<string, unknown>)[colSource] = val;
      } else {
        // Custom field: key by col.name (consistent with savePreviewItem)
        if (!item.custom_fields) item.custom_fields = {};
        if (val) {
          item.custom_fields[colName] = val;
        } else {
          delete item.custom_fields[colName];
          // WHY: clean up empty object — export treats missing key as no custom data
          if (Object.keys(item.custom_fields).length === 0) delete item.custom_fields;
        }
      }
      await saveInbox(_currentItems);
    },
    true,
  );

  // WHY: event delegation on #detail-fields — pick buttons rendered by buildDetailField();
  // delegating avoids re-wiring on each showDetail() call.
  // _pickContext='detail' flag allows init() to route the pick result to showDetail() on re-open.
  (document.getElementById('detail-fields') as HTMLElement).addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).classList.contains('btn-pick')) return;
    const field = (e.target as HTMLElement).dataset.pickSource;
    const item = _currentItems.find((i) => i.id === _selectedId);
    if (!field || !item) return;
    chrome.storage.local.set({ pick_pending_item: { ...item, _pickContext: 'detail' } }, () => {
      sendPickMode(item.id, field);
      window.close();
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
