/**
 * @module popup-schema
 * @responsibility Schema editor UI: schema list management, column CRUD, source mapping, import/export
 * @owns SCHEMA state panel rendering; openSchemaEditor() entry point; getExportSchema() public getter
 * @not-owns chrome.storage access (SchemaStore owns all storage); state machine (popup.js); export logic
 * @depends-on popup-utils.js (showStatus), popup-schema-store.js (SchemaStore CRUD via ESM import)
 * @depended-by popup.js (openSchemaEditor, getExportSchema), popup-merge.js (getExportSchema)
 * @context popup — runs in extension popup
 * @test manual — open schema editor, create column, reorder, import/export schema JSON, verify save; verify import no longer prompts on collision — auto-suffixes silently; verify duplicate column name auto-suffix "(2)" on add + blur; verify source change auto-updates name unless manually edited; verify drag-and-drop column reorder, readonly rows not draggable
 */

import { showStatus } from './popup-utils.js';
import type { Schema, Column } from '../types';
import {
  getAllSchemas,
  getActiveSchema,
  saveSchema,
  deleteSchema,
  duplicateSchema,
  setActiveSchema,
  importSchema,
  exportSchema,
} from './popup-schema-store.js';

// ── Source registry ─────────────────────────────────────────────────────────

// WHY: maps CaptureItem field names to display labels; used for source dropdown + auto-fill
const SOURCES = [
  { value: 'captured_at',   label: 'Captured At' },
  { value: 'article_date',  label: 'Published' },
  { value: 'title',         label: 'Title' },
  { value: 'url',           label: 'URL' },
  { value: 'source',        label: 'Source' },
  { value: 'author',        label: 'Author' },
  { value: 'content',       label: 'Content' },
  { value: 'content_hash',  label: 'Content Hash' },
  { value: 'operator_name', label: 'Operator' },
];

// WHY: canonical display names for auto-fill when source changes — uses DEFAULT_NEW_SCHEMA_COLUMNS
// naming (Capture Time / Publish Time) not SOURCES labels (Captured At / Published) so new-schema
// columns stay consistent with the 7-column template; '' maps to 'New Column' for custom source
// (EXT-UI-RESTRUCTURE Step 1e)
const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  'title':         'Title',
  'url':           'URL',
  'source':        'Source',
  'author':        'Author',
  'captured_at':   'Capture Time',
  'article_date':  'Publish Time',
  'content':       'Content',
  'content_hash':  'Content Hash',
  'operator_name': 'Operator',
  '':              'New Column',
};

// ── Module state ─────────────────────────────────────────────────────────────

// WHY: module-level refs so button handlers can close over current schema context
let _schemas:   Schema[]        = [];   // latest list from SchemaStore
let _activeId:  string | null   = null; // id of schema loaded in column editor
let _onSaved:   (() => void) | null = null; // callback: navigate back to SETTINGS (injected by popup.js)
let _dragSrcIdx = -1; // WHY: tracks dragged column index during HTML5 drag-and-drop reorder (EXT-UI-RESTRUCTURE Step 1f)

// ── Private helpers ──────────────────────────────────────────────────────────

function _sourceLabel(source: string | null): string {
  if (!source) return 'Custom (empty on export)';
  const entry = SOURCES.find(s => s.value === source);
  return entry ? entry.label : source;
}

// WHY: builds <select> options for source dropdown; selected = current column source value
function _buildSourceSelect(currentSource: string | null): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'schema-source-select';

  for (const s of SOURCES) {
    const opt = document.createElement('option');
    opt.value = s.value;
    opt.textContent = s.label;
    if (s.value === currentSource) opt.selected = true;
    sel.appendChild(opt);
  }

  const customOpt = document.createElement('option');
  customOpt.value = '';
  customOpt.textContent = 'Custom (empty on export)';
  if (!currentSource) customOpt.selected = true;
  sel.appendChild(customOpt);

  return sel;
}

// WHY: local copy of popup-schema-store._uniqueName — not exported from store;
// used for column-level name dedup within a single schema (EXT-UI-RESTRUCTURE Step 1d)
function _uniqueName(name: string, existingLowerSet: Set<string>): string {
  if (!existingLowerSet.has(name.toLowerCase())) return name;
  let counter = 2;
  while (existingLowerSet.has(`${name} (${counter})`.toLowerCase())) {
    counter++;
  }
  return `${name} (${counter})`;
}

// WHY: readonly=true for Default schema — disables all editing controls in column rows
function _renderColumns(columns: Column[], readonly: boolean): void {
  const container = document.getElementById('schema-columns') as HTMLElement;
  container.innerHTML = '';

  columns.forEach((col, idx) => {
    const row = document.createElement('div');
    row.className = 'schema-row';
    row.dataset.id = col.id;

    if (!readonly) {
      // WHY: HTML5 native drag-and-drop replaces ↑↓ buttons — faster multi-step reorder
      // without losing cursor context after each move (EXT-UI-RESTRUCTURE Step 1f)
      row.draggable = true;

      row.addEventListener('dragstart', (e: DragEvent) => {
        _dragSrcIdx = idx;
        row.classList.add('dragging');
        e.dataTransfer!.effectAllowed = 'move';
      });

      row.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
        // WHY: remove class from all rows then re-apply to current target so only one
        // row shows the insertion indicator at a time
        container.querySelectorAll('.schema-row').forEach(r => r.classList.remove('drag-over'));
        row.classList.add('drag-over');
      });

      row.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault();
        if (_dragSrcIdx === -1 || _dragSrcIdx === idx) return;
        const cur = _readColumns();
        const [moved] = cur.splice(_dragSrcIdx, 1);
        // WHY: after removing _dragSrcIdx, items after it shift down by 1;
        // when dragging forward (src < target), the visual target's real index is idx-1
        const insertAt = _dragSrcIdx < idx ? idx - 1 : idx;
        cur.splice(insertAt, 0, moved);
        _renderColumns(cur, false);
      });

      row.addEventListener('dragend', () => {
        // WHY: clean up drag state regardless of whether drop succeeded or was cancelled
        container.querySelectorAll('.schema-row').forEach(r => {
          r.classList.remove('dragging', 'drag-over');
        });
        _dragSrcIdx = -1;
      });
    }

    // Display name input — becomes the CSV header
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = col.name;
    nameInput.placeholder = 'Column header';
    nameInput.dataset.colId = col.id;
    nameInput.className = 'schema-name-input';
    nameInput.readOnly = readonly;
    if (readonly) nameInput.style.opacity = '0.6';

    // Source dropdown
    const sel = _buildSourceSelect(col.source);
    sel.dataset.colId = col.id;
    sel.disabled = readonly;

    if (!readonly) {
      // WHY: auto-update display name when source changes, unless user has manually
      // edited the name; data-name-edited flag set by the input listener below
      // (EXT-UI-RESTRUCTURE Step 1e)
      sel.addEventListener('change', () => {
        if (!nameInput.dataset.nameEdited) {
          const defaultName = SOURCE_DISPLAY_NAMES[sel.value];
          if (defaultName !== undefined) nameInput.value = defaultName;
        }
      });

      // WHY: mark name as manually edited when user types — prevents source change
      // from overwriting a custom column name (EXT-UI-RESTRUCTURE Step 1e)
      nameInput.addEventListener('input', () => {
        nameInput.dataset.nameEdited = '1';
      });

      // WHY: auto-suffix column name on blur if it collides with another column in the
      // same schema; case-insensitive; self excluded so a no-op rename passes cleanly
      // (EXT-UI-RESTRUCTURE Step 1d)
      nameInput.addEventListener('blur', () => {
        const trimmed = nameInput.value.trim();
        if (!trimmed) return;
        const cur = _readColumns();
        const existingLower = new Set(
          cur.filter(c => c.id !== col.id).map(c => c.name.toLowerCase())
        );
        const unique = _uniqueName(trimmed, existingLower);
        if (unique !== trimmed) nameInput.value = unique;
      });
    }

    row.appendChild(nameInput);
    row.appendChild(sel);

    if (!readonly) {
      // × remove button
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove column';
      removeBtn.addEventListener('click', () => {
        const cur = _readColumns();
        if (cur.length <= 1) {
          showStatus('At least one column required');
          return;
        }
        const updated = cur.filter(c => c.id !== col.id);
        _renderColumns(updated, false);
      });
      row.appendChild(removeBtn);
    }

    container.appendChild(row);
  });
}

// WHY: reads current column state from DOM at save/reorder time so in-progress edits are preserved
function _readColumns(): Column[] {
  const container = document.getElementById('schema-columns') as HTMLElement;
  return [...container.querySelectorAll<HTMLElement>('.schema-row')].map(row => ({
    id:     row.dataset.id!,
    name:   row.querySelector<HTMLInputElement>('.schema-name-input')!.value,
    source: row.querySelector<HTMLSelectElement>('.schema-source-select')!.value || null,
  }));
}

// ── Schema list rendering ────────────────────────────────────────────────────

// WHY: re-populates the <select> whenever schemas change (create/delete/duplicate/import)
function _renderSchemaSelect(): void {
  const sel = document.getElementById('schema-select') as HTMLSelectElement;
  sel.innerHTML = '';
  for (const s of _schemas) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.is_default ? `${s.name} 🔒` : s.name;
    if (s.id === _activeId) opt.selected = true;
    sel.appendChild(opt);
  }
}

// WHY: loads one schema into the name field + column editor; updates _activeId
function _loadSchema(schema: Schema): void {
  _activeId = schema.id;

  const nameInput = document.getElementById('schema-name-input') as HTMLInputElement;
  const lockIcon  = document.getElementById('schema-lock-icon') as HTMLElement;
  const addBtn    = document.getElementById('btn-schema-add') as HTMLElement;
  const saveBtn   = document.getElementById('btn-schema-save') as HTMLElement;
  const deleteBtn = document.getElementById('btn-schema-delete') as HTMLButtonElement;

  nameInput.value    = schema.name;
  nameInput.readOnly = !!schema.is_default;
  lockIcon.hidden    = !schema.is_default;

  // WHY: hide destructive/edit controls for the built-in Default schema
  if (addBtn)    addBtn.hidden    = !!schema.is_default;
  if (saveBtn)   saveBtn.hidden   = !!schema.is_default;
  if (deleteBtn) deleteBtn.disabled = !!schema.is_default;

  _renderColumns(schema.columns, !!schema.is_default);
}

// WHY: reload both the selector and editor after any list mutation
async function _reloadList(selectId: string | null): Promise<void> {
  _schemas = await getAllSchemas();
  const target = _schemas.find(s => s.id === selectId) || _schemas[0];
  _activeId = target.id;
  _renderSchemaSelect();
  _loadSchema(target);
}

// ── Import helper ────────────────────────────────────────────────────────────

// WHY: importSchema now auto-suffixes on name collision — no prompt needed; use
// result.name (the final stored name) to locate the schema after reload
// (EXT-UI-RESTRUCTURE Step 1c)
async function _doImport(parsed: unknown): Promise<void> {
  const result = await importSchema(parsed);
  if (result.success) {
    _schemas = await getAllSchemas();
    const imported = _schemas.find(s => s.name === result.name);
    await _reloadList(imported ? imported.id : _activeId);
    showStatus('Schema imported ✓');
  } else {
    showStatus(result.error || 'Import failed');
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

// WHY: setState + onSaved injected to avoid circular dependency with popup.js
export async function openSchemaEditor(setState: (s: string) => void, onSaved: () => void): Promise<void> {
  _onSaved = onSaved;

  // Load all schemas and active schema in parallel
  const [schemas, active] = await Promise.all([getAllSchemas(), getActiveSchema()]);
  _schemas  = schemas;
  _activeId = active.id;

  _renderSchemaSelect();
  _loadSchema(active);
  setState('SCHEMA');

  // ── Schema selector ──────────────────────────────────────────────────────
  (document.getElementById('schema-select') as HTMLSelectElement).onchange = async e => {
    await setActiveSchema((e.target as HTMLSelectElement).value);
    const schema = _schemas.find(s => s.id === (e.target as HTMLSelectElement).value);
    if (schema) _loadSchema(schema);
  };

  // ── New schema ───────────────────────────────────────────────────────────
  (document.getElementById('btn-schema-new') as HTMLElement).onclick = async () => {
    const name = window.prompt('New schema name:');
    if (!name || !name.trim()) return;
    try {
      const newSchema = {
        id:         crypto.randomUUID(),
        name:       name.trim(),
        is_default: false,
        columns:    [{ id: crypto.randomUUID(), name: 'New Column', source: null }],
      };
      await saveSchema(newSchema);
      await _reloadList(newSchema.id);
      await setActiveSchema(newSchema.id);
      showStatus('Schema created ✓');
    } catch (e: unknown) {
      showStatus((e as Error).message || 'Could not create schema');
    }
  };

  // ── Duplicate ────────────────────────────────────────────────────────────
  (document.getElementById('btn-schema-duplicate') as HTMLElement).onclick = async () => {
    try {
      const copy = await duplicateSchema(_activeId!);
      await setActiveSchema(copy.id);
      await _reloadList(copy.id);
      showStatus('Schema duplicated ✓');
    } catch (e: unknown) {
      showStatus((e as Error).message || 'Could not duplicate schema');
    }
  };

  // ── Delete ───────────────────────────────────────────────────────────────
  (document.getElementById('btn-schema-delete') as HTMLElement).onclick = async () => {
    const schema = _schemas.find(s => s.id === _activeId);
    if (!schema || schema.is_default) return;
    if (!window.confirm(`Delete schema "${schema.name}"? This cannot be undone.`)) return;
    try {
      await deleteSchema(_activeId!);
      const active = await getActiveSchema();
      await _reloadList(active.id);
      showStatus('Schema deleted');
    } catch (e: unknown) {
      showStatus((e as Error).message || 'Could not delete schema');
    }
  };

  // ── Import ───────────────────────────────────────────────────────────────
  (document.getElementById('btn-schema-import') as HTMLElement).onclick = () => {
    (document.getElementById('schema-import-input') as HTMLElement).click();
  };

  (document.getElementById('schema-import-input') as HTMLInputElement).onchange = async e => {
    const file = (e.target as HTMLInputElement).files![0];
    if (!file) return;
    (e.target as HTMLInputElement).value = ''; // WHY: reset so same file can be re-imported after cancel
    try {
      const text   = await file.text();
      const parsed = JSON.parse(text);
      await _doImport(parsed);
    } catch {
      showStatus('Invalid JSON file');
    }
  };

  // ── Export ───────────────────────────────────────────────────────────────
  (document.getElementById('btn-schema-export') as HTMLElement).onclick = async () => {
    try {
      const data     = await exportSchema(_activeId!);
      const json     = JSON.stringify(data, null, 2);
      const blob     = new Blob([json], { type: 'application/json' });
      const safeName = data.schema_name.replace(/[^a-z0-9_\-]/gi, '_');
      chrome.downloads.download({
        url:      URL.createObjectURL(blob),
        filename: `schema_${safeName}.json`,
        saveAs:   false,
      });
      showStatus('Schema exported ✓');
    } catch (e: unknown) {
      showStatus((e as Error).message || 'Export failed');
    }
  };

  // ── Schema rename (on blur) ───────────────────────────────────────────────
  const nameInput = document.getElementById('schema-name-input') as HTMLInputElement;
  nameInput.onblur = async () => {
    const schema = _schemas.find(s => s.id === _activeId);
    if (!schema || schema.is_default) return;
    const newName = nameInput.value.trim();
    if (!newName || newName === schema.name) return;
    try {
      await saveSchema({ ...schema, name: newName });
      _schemas = await getAllSchemas();
      // WHY: reflect actual saved name in case auto-suffix was applied (EXT-UI-RESTRUCTURE Step 1c)
      const saved = _schemas.find(s => s.id === _activeId);
      if (saved) nameInput.value = saved.name;
      _renderSchemaSelect();
      showStatus('Schema renamed ✓');
    } catch (e: unknown) {
      nameInput.value = schema.name; // WHY: revert on error (e.g. duplicate name)
      showStatus((e as Error).message || 'Could not rename schema');
    }
  };

  // ── Add column ───────────────────────────────────────────────────────────
  (document.getElementById('btn-schema-add') as HTMLElement).onclick = () => {
    const cur = _readColumns();
    // WHY: auto-suffix "New Column" if a column with that name already exists
    // (EXT-UI-RESTRUCTURE Step 1d)
    const existingLower = new Set(cur.map(c => c.name.toLowerCase()));
    const newName = _uniqueName('New Column', existingLower);
    cur.push({ id: crypto.randomUUID(), name: newName, source: null });
    _renderColumns(cur, false);
  };

  // ── Save columns ─────────────────────────────────────────────────────────
  (document.getElementById('btn-schema-save') as HTMLElement).onclick = async () => {
    const schema = _schemas.find(s => s.id === _activeId);
    if (!schema || schema.is_default) return;

    const columns = _readColumns();
    if (columns.length === 0) { showStatus('At least one column required'); return; }
    const emptyName = columns.find(c => !c.name.trim());
    if (emptyName) { showStatus('All column names must be non-empty'); return; }

    try {
      await saveSchema({ ...schema, columns });
      _schemas = await getAllSchemas();
      showStatus('Columns saved ✓');
    } catch (e: unknown) {
      showStatus((e as Error).message || 'Could not save columns');
    }
  };

  // ── Done / back ──────────────────────────────────────────────────────────
  (document.getElementById('btn-schema-done') as HTMLElement).onclick = () => {
    _onSaved!(); // WHY: owned by popup.js; navigates back to SETTINGS
  };
}

// WHY: drop-in replacement for old direct-storage getter; delegates to SchemaStore
export async function getExportSchema() {
  return getActiveSchema();
}
