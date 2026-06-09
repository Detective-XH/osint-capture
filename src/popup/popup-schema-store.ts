/**
 * @module popup-schema-store
 * @responsibility Multi-schema storage data layer: CRUD, migration from legacy single-schema
 * @owns chrome.storage read/write for 'schemas' key; Default schema definition; migration from 'export_schema'; _uniqueName() dedup helper (EXT-UI-RESTRUCTURE Step 1c)
 * @not-owns Schema editor UI (popup-schema.js); export logic (popup-export.js); state machine (popup.js)
 * @depends-on chrome.storage.local
 * @depended-by popup-schema.js (all CRUD), popup-export.js (getSchemaById), popup.js (indirect via popup-schema.js)
 * @context popup — runs in extension popup; DOM-free, safe in service worker
 * @test manual — load schema editor, create/edit/delete schema, verify chrome.storage.local schemas key; verify duplicate name auto-suffix "(2)/(3)" on create/rename/import
 */

import type { Schema, Column, SchemaStorage, LegacyExportSchema } from '../types';

// ── Storage key ─────────────────────────────────────────────────────────────

// WHY: single top-level key avoids partial-write races between schemas[] and active_schema_id
const STORAGE_KEY = 'schemas';
const LEGACY_KEY  = 'export_schema'; // WHY: actual key used by popup-schema.js (prompt says 'exportSchema' but code uses 'export_schema')

// ── Default schema ──────────────────────────────────────────────────────────

// WHY: fixed UUIDs so active_schema_id can reference Default stably across sessions
const DEFAULT_SCHEMA_ID = '00000000-0000-0000-0000-000000000001';

// WHY: fixed column UUIDs so custom_fields keys remain consistent for the Default schema
const DEFAULT_SCHEMA: Schema = Object.freeze({
  id:         DEFAULT_SCHEMA_ID,
  name:       'Default',
  is_default: true,
  columns: [
    { id: '00000000-0000-0000-0001-000000000001', name: 'Title',        source: 'title' },
    { id: '00000000-0000-0000-0001-000000000002', name: 'URL',          source: 'url' },
    { id: '00000000-0000-0000-0001-000000000003', name: 'Source',       source: 'source' },
    { id: '00000000-0000-0000-0001-000000000004', name: 'Author',       source: 'author' },
    { id: '00000000-0000-0000-0001-000000000005', name: 'Captured At',  source: 'captured_at' },
    { id: '00000000-0000-0000-0001-000000000006', name: 'Published',    source: 'article_date' },
    { id: '00000000-0000-0000-0001-000000000007', name: 'Content',      source: 'content' },
    { id: '00000000-0000-0000-0001-000000000008', name: 'Content Hash', source: 'content_hash' },
  ],
});

// ── New-schema column template ───────────────────────────────────────────────

// WHY: 7-column starting point for new schemas — covers standard OSINT capture fields without
// the audit-only Content Hash column; display names chosen for analyst workflow, not raw field names
const DEFAULT_NEW_SCHEMA_COLUMNS: Pick<Column, 'name' | 'source'>[] = [
  { name: 'Title',        source: 'title' },
  { name: 'URL',          source: 'url' },
  { name: 'Source',       source: 'source' },
  { name: 'Author',       source: 'author' },
  { name: 'Capture Time', source: 'captured_at' },
  { name: 'Publish Time', source: 'article_date' },
  { name: 'Content',      source: 'content' },
];

// ── Storage helpers ──────────────────────────────────────────────────────────

// WHY: all reads go through _load() so callers never touch chrome.storage directly
function _load(): Promise<SchemaStorage | null> {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEY, result => {
      resolve((result[STORAGE_KEY] as SchemaStorage) || null);
    });
  });
}

function _save(stored: SchemaStorage): Promise<void> {
  return new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_KEY]: stored }, resolve);
  });
}

// WHY: returns a deep copy with DEFAULT_SCHEMA always first so UI can rely on position
function _ensureDefault(stored: SchemaStorage | null): SchemaStorage {
  if (!stored) {
    return { schemas: [_cloneDefault()], active_schema_id: DEFAULT_SCHEMA_ID };
  }
  const hasDefault = stored.schemas.some((s: Schema) => s.id === DEFAULT_SCHEMA_ID);
  if (!hasDefault) {
    stored.schemas = [_cloneDefault(), ...stored.schemas];
  }
  return stored;
}

// WHY: deep copy so mutations to stored data never affect the constant DEFAULT_SCHEMA
function _cloneDefault(): Schema {
  return {
    id:         DEFAULT_SCHEMA.id,
    name:       DEFAULT_SCHEMA.name,
    is_default: true,
    columns:    DEFAULT_SCHEMA.columns.map((c: Column) => ({ ...c })),
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

function _validateSchema(schema: Schema): void {
  if (!schema.name || !schema.name.trim()) {
    throw new Error('Schema name must be non-empty');
  }
  if (!Array.isArray(schema.columns) || schema.columns.length === 0) {
    throw new Error('Schema must have at least one column');
  }
  const names = schema.columns.map((c: Column) => c.name);
  const unique = new Set(names);
  if (unique.size !== names.length) {
    throw new Error('Duplicate column names are not allowed within a schema');
  }
  for (const col of schema.columns) {
    if (!col.name || !col.name.trim()) {
      throw new Error('All column names must be non-empty');
    }
  }
}

// ── Name deduplication ───────────────────────────────────────────────────────

// WHY: auto-suffix "(2)", "(3)" etc. until name is unique; case-insensitive to prevent
// "Default" vs "default" collision; used when creating new schemas, renaming, and importing
// (EXT-UI-RESTRUCTURE Step 1c)
function _uniqueName(name: string, existingLowerSet: Set<string>): string {
  if (!existingLowerSet.has(name.toLowerCase())) return name;
  let counter = 2;
  while (existingLowerSet.has(`${name} (${counter})`.toLowerCase())) {
    counter++;
  }
  return `${name} (${counter})`;
}

// ── Read API ─────────────────────────────────────────────────────────────────

export async function getAllSchemas() {
  const stored = await _load();
  if (!stored) return [_cloneDefault()];
  const hasDefault = stored.schemas.some(s => s.id === DEFAULT_SCHEMA_ID);
  if (!hasDefault) return [_cloneDefault(), ...stored.schemas];
  return stored.schemas;
}

export async function getActiveSchema() {
  const stored = await _load();
  if (!stored) return _cloneDefault();
  const active = stored.schemas.find(s => s.id === stored.active_schema_id);
  return active || _cloneDefault();
}

export async function getSchemaById(id: string): Promise<Schema | null> {
  const stored = await _load();
  if (!stored) return id === DEFAULT_SCHEMA_ID ? _cloneDefault() : null;
  return stored.schemas.find((s: Schema) => s.id === id) || null;
}

// ── Write API ────────────────────────────────────────────────────────────────

export async function saveSchema(schema: Schema): Promise<void> {
  if (schema.is_default) throw new Error('Default schema cannot be modified');
  _validateSchema(schema);

  const stored = _ensureDefault(await _load());
  const idx = stored.schemas.findIndex((s: Schema) => s.id === schema.id);
  if (idx >= 0) {
    // WHY: exclude self so same-name save is a no-op; auto-suffix on collision with a
    // different schema (rename path — EXT-UI-RESTRUCTURE Step 1c)
    const existingLower = new Set(
      stored.schemas.filter((s: Schema) => s.id !== schema.id).map((s: Schema) => s.name.toLowerCase())
    );
    stored.schemas[idx] = { ...schema, name: _uniqueName(schema.name, existingLower) };
  } else {
    // WHY: btn-schema-new in popup-schema.js creates a single stub column { name: 'New Column', source: null };
    // substitute the 7-column template so new schemas start pre-populated (EXT-UI-RESTRUCTURE Step 1)
    const isStub = schema.columns.length === 1
      && schema.columns[0].name === 'New Column'
      && schema.columns[0].source === null;
    if (isStub) {
      schema = {
        ...schema,
        columns: DEFAULT_NEW_SCHEMA_COLUMNS.map((c: Pick<Column, 'name' | 'source'>) => ({
          id: crypto.randomUUID(), name: c.name, source: c.source,
        })),
      };
    }
    // WHY: auto-suffix name before push so new schemas never silently collide
    // (EXT-UI-RESTRUCTURE Step 1c)
    const existingLower = new Set(stored.schemas.map((s: Schema) => s.name.toLowerCase()));
    schema = { ...schema, name: _uniqueName(schema.name, existingLower) };
    stored.schemas.push(schema);
  }
  await _save(stored);
}

export async function deleteSchema(id: string): Promise<void> {
  const stored = _ensureDefault(await _load());
  const target = stored.schemas.find((s: Schema) => s.id === id);
  if (!target) throw new Error(`Schema not found: ${id}`);
  if (target.is_default) throw new Error('Default schema cannot be deleted');

  stored.schemas = stored.schemas.filter((s: Schema) => s.id !== id);
  // WHY: if deleting active schema, fall back to Default so active_schema_id is always valid
  if (stored.active_schema_id === id) {
    stored.active_schema_id = DEFAULT_SCHEMA_ID;
  }
  await _save(stored);
}

export async function duplicateSchema(id: string): Promise<Schema> {
  const stored = _ensureDefault(await _load());
  const source = stored.schemas.find((s: Schema) => s.id === id);
  if (!source) throw new Error(`Schema not found: ${id}`);

  // WHY: reuse _uniqueName() for case-insensitive dedup; base is "Name (Copy)";
  // if "(Copy)" is taken, falls through to "(Copy) (2)", "(Copy) (3)" etc.
  const existingLower = new Set(stored.schemas.map((s: Schema) => s.name.toLowerCase()));
  const candidateName = _uniqueName(`${source.name} (Copy)`, existingLower);

  const copy: Schema = {
    id:         crypto.randomUUID(),
    name:       candidateName,
    is_default: false,
    columns:    source.columns.map((c: Column) => ({ ...c, id: crypto.randomUUID() })),
  };

  stored.schemas.push(copy);
  await _save(stored);
  return copy;
}

export async function setActiveSchema(id: string): Promise<void> {
  const stored = _ensureDefault(await _load());
  const exists = stored.schemas.some((s: Schema) => s.id === id);
  if (!exists) throw new Error(`Schema not found: ${id}`);
  stored.active_schema_id = id;
  await _save(stored);
}

// ── Import / Export ──────────────────────────────────────────────────────────

// WHY: importSchema accepts a parsed object { schema_name, columns[] } — caller is responsible for JSON.parse
export async function importSchema(json: unknown): Promise<{ success: false; error: string } | { success: true; name: string }> {
  const { schema_name, columns } = (json as Record<string, unknown>) || {};

  if (!schema_name || !(schema_name as string).trim()) {
    return { success: false, error: 'schema_name is required' };
  }
  if (!Array.isArray(columns)) {
    return { success: false, error: 'columns must be an array' };
  }

  const stored = _ensureDefault(await _load());
  // WHY: auto-suffix instead of rejecting — caller receives the final name so UI can
  // locate the imported schema without a second lookup (EXT-UI-RESTRUCTURE Step 1c)
  const existingLower = new Set(stored.schemas.map((s: Schema) => s.name.toLowerCase()));
  const uniqueName = _uniqueName((schema_name as string).trim(), existingLower);

  const schema: Schema = {
    id:         crypto.randomUUID(),
    name:       uniqueName,
    is_default: false,
    columns:    (columns as Array<{ name?: string; source?: string | null }>).map(c => ({
      id:     crypto.randomUUID(), // WHY: generate new ids on import; round-trip id stability is not guaranteed
      name:   c.name || '',
      source: c.source || null,
    })),
  };

  try {
    _validateSchema(schema);
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }

  stored.schemas.push(schema);
  await _save(stored);
  // WHY: return uniqueName so caller can locate the imported schema by its final stored name
  return { success: true, name: uniqueName };
}

// WHY: exportSchema strips is_default and top-level id — output is a portable descriptor, not a storage record
export async function exportSchema(id: string): Promise<{ schema_name: string; columns: Column[] }> {
  const schema = await getSchemaById(id);
  if (!schema) throw new Error(`Schema not found: ${id}`);
  return {
    schema_name: schema.name,
    columns:     schema.columns.map((c: Column) => ({ id: c.id, name: c.name, source: c.source })),
  };
}

// ── Migration ────────────────────────────────────────────────────────────────

// WHY: called once from popup.js DOMContentLoaded (Step 3); safe to call multiple times (idempotent)
export async function migrateFromLegacy(): Promise<void> {
  const existing = await _load();
  if (existing) return; // WHY: already migrated — schemas key present, skip

  return new Promise(resolve => {
    chrome.storage.local.get(LEGACY_KEY, result => {
      const legacy = result[LEGACY_KEY] as LegacyExportSchema | undefined;

      if (legacy && Array.isArray(legacy.columns) && legacy.columns.length > 0) {
        // WHY: treat legacy export_schema as a custom schema (user may have edited it)
        const customSchema: Schema = {
          id:         crypto.randomUUID(),
          name:       'Custom',
          is_default: false,
          columns:    legacy.columns.map((c: Column) => ({
            id:     c.id || crypto.randomUUID(), // WHY: preserve existing column ids for custom_fields key stability
            name:   c.name || '',
            source: c.source || null,
          })),
        };
        _save({
          schemas:          [_cloneDefault(), customSchema],
          active_schema_id: customSchema.id,
        }).then(resolve);
      } else {
        // WHY: no legacy data — init fresh with Default as active
        _save({
          schemas:          [_cloneDefault()],
          active_schema_id: DEFAULT_SCHEMA_ID,
        }).then(resolve);
      }
      // WHY: legacy 'export_schema' key is NOT deleted — non-destructive migration
    });
  });
}

// ── Facade ───────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    SchemaStore: {
      getAllSchemas: typeof getAllSchemas;
      getActiveSchema: typeof getActiveSchema;
      getSchemaById: typeof getSchemaById;
      saveSchema: typeof saveSchema;
      deleteSchema: typeof deleteSchema;
      duplicateSchema: typeof duplicateSchema;
      setActiveSchema: typeof setActiveSchema;
      importSchema: typeof importSchema;
      exportSchema: typeof exportSchema;
      migrateFromLegacy: typeof migrateFromLegacy;
    };
  }
}

window.SchemaStore = Object.freeze({
  getAllSchemas,
  getActiveSchema,
  getSchemaById,
  saveSchema,
  deleteSchema,
  duplicateSchema,
  setActiveSchema,
  importSchema,
  exportSchema,
  migrateFromLegacy,
});
