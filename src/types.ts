/**
 * Shared data contracts for OSINT Capture.
 *
 * Single source of truth for every cross-module shape: capture records, schemas,
 * settings, chrome.storage keys, and runtime messages. Pure type declarations —
 * no runtime code, so this file contributes nothing to any bundle.
 *
 * Field provenance is pinned in plans/TS-MIGRATION.md (recon: data-shapes).
 */

/** One column in a capture schema. `source` maps to a CaptureItem field, or null for a custom field. */
export interface Column {
  id: string;
  name: string;
  source: string | null;
}

/** A capture schema: an ordered set of columns. The Default schema has a fixed UUID. */
export interface Schema {
  id: string;
  name: string;
  is_default?: boolean;
  columns: Column[];
}

/** chrome.storage.local['schemas'] wrapper. */
export interface SchemaStorage {
  schemas: Schema[];
  active_schema_id: string;
}

/** A single captured page/link record. Stored in chrome.storage.local['captures'] (newest first). */
export interface CaptureItem {
  id: string;
  title: string;
  url: string;
  source: string;
  author: string | null;
  /** ISO8601 with timezone offset; immutable once set. */
  captured_at: string;
  /** ISO8601, a raw unparsed string, or null. */
  article_date: string | null;
  /** Article body as plain text (no HTML). */
  content: string;
  /** 'sha256:' + hex, or null before hashing. */
  content_hash: string | null;
  /** Reserved for future use — always null today. */
  raw_html_path: null;
  /** Reserved for future use — always null today. */
  pdf_path: null;
  schema_id: string;
  schema_name: string;
  /** Omitted entirely when empty (CUSTOM-FIELDS-OMIT-EMPTY). Keyed by column display name. */
  custom_fields?: Record<string, string>;
}

export type CsvDelimiter = 'comma' | 'tab';

export interface Settings {
  operator_name: string;
  download_subfolder: string;
  csv_delimiter: CsvDelimiter;
}

/** A pending Pick operation (user is selecting a field value on the page). */
export interface PickPending {
  itemId: string;
  field: string;
}

/** The result of a completed Pick, written by the content script. */
export interface PickResult {
  field: string;
  value: string;
}

/** A capture held across a popup close during Pick mode. */
export type PickPendingItem = CaptureItem & { _pickContext?: 'detail' };

/**
 * chrome.storage.local key → value map. The 34-call safety net: typed read/write
 * helpers can be checked against this so a mistyped key or value shape fails at
 * compile time instead of at runtime.
 */
export interface StorageShape {
  captures: CaptureItem[];
  schemas: SchemaStorage;
  operator_name: string;
  download_subfolder: string;
  csv_delimiter: CsvDelimiter;
  pick_pending: PickPending;
  pick_result: PickResult;
  pick_pending_item: PickPendingItem;
}

/** Legacy single-schema shape, read only during migration. */
export interface LegacyExportSchema {
  columns: Column[];
  name?: string;
}

/** Runtime messages passed between content, popup, and background (discriminated by `type`). */
export type RuntimeMessage =
  | { type: 'CAPTURE_PAGE' }
  | { type: 'PICK_MODE'; field: string }
  | { type: 'HASH_CONTENT'; text: string }
  | { type: 'PICK_DONE' };

/** Response to CAPTURE_PAGE from the content script. The extracted item carries no id/schema yet. */
export interface CapturePageResponse {
  ok: boolean;
  item?: Omit<
    CaptureItem,
    'id' | 'schema_id' | 'schema_name' | 'custom_fields' | 'content_hash'
  > & { content_hash: null };
  error?: string;
}

/** Response to HASH_CONTENT from the background worker. */
export interface HashContentResponse {
  hash: string | null;
}
