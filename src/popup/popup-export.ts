/**
 * @module popup-export
 * @responsibility Per-schema export (JSON and/or CSV), schema selection support, file download trigger, export button state management
 * @owns Schema 1.2 envelope structure; CSV generation; schema column mapping (display name → item field); per-schema grouping; fallback schema for deleted schemas; storage quota warning; _csvEscape; _downloadJSON; _downloadCSV; download filename format; chrome.downloads.download call
 * @not-owns Capture items storage; inbox rendering; state machine; schema editor (popup-schema.js); schema selection UI (popup.js)
 * @depends-on popup-utils.js (showStatus, localTimestamp, localISOWithOffset), popup-schema-store.js (getSchemaById)
 * @depended-by popup.js (init wiring)
 * @context popup — runs in extension popup
 * @test manual — export 2+ captures with different schemas; verify one file per schema group
 * @known-constraints CUSTOM-FIELDS-DUAL-READ: _mapItem reads custom_fields by col.name first then col.id for backward compat — pre-Step-6 saves used col.id as key
 * @known-constraints FALLBACK-SCHEMA-DUPLICATED: _buildFallbackSchema() is a private copy, not imported from popup.js — export variant adds name field for filename generation; importing would create a circular dep or require a new util module
 */

import type { CaptureItem, Schema, Column, Settings, ExportFormat, CsvDelimiter, ExportEnvelope } from '../types';
import { showStatus, localTimestamp, localISOWithOffset } from './popup-utils.js';
import { getSchemaById } from './popup-schema-store.js';
// WHY: getExportSchema removed — Step 8 resolves schema per item group via getSchemaById

// ── Private helpers ─────────────────────────────────────────────────────────

// WHY: replace spaces with hyphens, strip chars unsafe in filenames, so schema/operator
// names compose cleanly into download paths without OS escaping issues
function _sanitizeFilename(str: string): string {
  return (str || '').replace(/\s+/g, '-').replace(/[^a-z0-9_\-]/gi, '');
}

// WHY: mirrors _buildFallbackSchema in popup.js; adds `name` field so filename
// generation works for captures whose schema was deleted since capture time
function _buildFallbackSchema(item: CaptureItem): Schema {
  const STD = ['title', 'url', 'source', 'author', 'captured_at', 'article_date', 'content', 'content_hash'];
  const cols: Column[] = STD.map(s => ({ id: s, name: s.replace(/_/g, ' '), source: s }));
  for (const key of Object.keys(item.custom_fields || {}))
    cols.push({ id: key, name: key, source: null });
  return { name: item.schema_name || 'Default', columns: cols } as Schema;
}

// WHY: warn after export if storage is getting full; > 80% of 5 MB (chrome default)
// triggers visible warning — user must act manually (no auto-delete)
function _checkStorageQuota() {
  chrome.storage.local.getBytesInUse(null, bytes => {
    const quota = chrome.storage.local.QUOTA_BYTES || 5242880;
    if (bytes / quota > 0.8)
      showStatus('Storage is getting full. Consider clearing exported captures.', true);
  });
}

// ── Export ─────────────────────────────────────────────────────────────────

/**
 * Export items per schema, emitting one file per schema group.
 * @param {Array} items - CaptureItem array to export (may span multiple schemas)
 */
export async function exportItems(items: CaptureItem[]) {
  if (!items || items.length === 0) {
    showStatus('Nothing to export.');
    return;
  }

  // WHY: load settings only — schema resolved per group below, not once globally
  const settings = await new Promise<Partial<Settings>>(resolve =>
    chrome.storage.local.get(
      ['operator_name', 'download_subfolder', 'export_format', 'csv_delimiter'],
      resolve as (items: { [key: string]: unknown }) => void)) as Partial<Settings>;

  const format    = settings.export_format    || 'json' as ExportFormat;
  const delimiter = settings.csv_delimiter    || 'comma' as CsvDelimiter;
  const operator  = settings.operator_name    || '';
  const subfolder = (settings.download_subfolder || 'osint-captures').replace(/[^a-z0-9_\-]/gi, '-');
  const timestamp = localTimestamp();

  // WHY: group by schema_id so each schema group gets its own file; captures without
  // schema_id are already normalized to Default by loadInbox() before reaching here
  const groups = new Map();
  for (const item of items) {
    const sid = item.schema_id;
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push(item);
  }

  let totalExported = 0;
  for (const [schemaId, groupItems] of groups) {
    // WHY: getSchemaById returns null for deleted schemas — fall back to synthetic
    // schema so captured data is never silently lost on export
    const schema = (await getSchemaById(schemaId)) || _buildFallbackSchema(groupItems[0]);
    const schemaSafe   = _sanitizeFilename(schema.name);
    const operatorSafe = _sanitizeFilename(operator);
    // WHY: omit trailing underscore+segment when operator is blank — avoids ugly double-dash filenames
    const fileStem = operatorSafe ? `${timestamp}_${schemaSafe}_${operatorSafe}` : `${timestamp}_${schemaSafe}`;

    if (format === 'json' || format === 'both') {
      _downloadJSON(groupItems, schema, operator, subfolder, fileStem);
    }
    if (format === 'csv' || format === 'both') {
      _downloadCSV(groupItems, schema, operator, delimiter, subfolder, fileStem);
    }
    totalExported += groupItems.length;
  }

  const schemaCount = groups.size;
  const label = format === 'both' ? 'JSON + CSV' : format.toUpperCase();
  const schemaLabel = schemaCount > 1 ? ` across ${schemaCount} schemas` : '';
  showStatus(`Exported ${totalExported} item${totalExported !== 1 ? 's' : ''}${schemaLabel} as ${label}`);

  _checkStorageQuota();
}

export function updateExportSelectedBtn() {
  const checked = document.querySelectorAll('#inbox input[type=checkbox]:checked').length;
  const btn     = document.getElementById('btn-export-selected') as HTMLButtonElement | null;
  if (btn) btn.disabled = checked === 0;
}

/**
 * Build a schema-mapped record from one CaptureItem.
 * WHY: display names (not raw field names) are used as keys — schema renames
 * propagate automatically to export output.
 */
function _mapItem(item: CaptureItem, schema: Schema, operator: string): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  schema.columns.forEach((col: Column) => {
    let value;
    if (col.source === null) {
      // WHY: dual-read col.name first (current save format), then col.id (pre-Step-6 saves)
      // so exports work correctly regardless of which era captured the item
      value = (item.custom_fields && (item.custom_fields[col.name] ?? item.custom_fields[col.id])) ?? null;
    } else if (col.source === 'operator_name') {
      // WHY: operator_name is a session-level setting, not per-item — read from storage at export time
      value = operator || null;
    } else {
      value = (item as unknown as Record<string, unknown>)[col.source] ?? null;
    }
    mapped[col.name] = value;
  });
  return mapped;
}

function _downloadJSON(items: CaptureItem[], schema: Schema, operator: string, subfolder: string, fileStem: string) {
  const mappedItems = items.map((item: CaptureItem) => _mapItem(item, schema, operator));

  const envelope: ExportEnvelope = {
    schema_version: '1.2',
    schema_name:    schema.name,  // WHY: top-level for quick identification without parsing export_schema
    exported_at:    localISOWithOffset(),
    exported_by:    operator,
    export_schema:  schema,
    items:          mappedItems,
  };

  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  chrome.downloads.download({
    url:      URL.createObjectURL(blob),
    filename: `${subfolder}/${fileStem}.json`,
    saveAs:   false,
  });
}

function _downloadCSV(items: CaptureItem[], schema: Schema, operator: string, delimiter: CsvDelimiter, subfolder: string, fileStem: string) {
  const sep = delimiter === 'tab' ? '\t' : ',';

  // WHY: UTF-8 BOM prefix ensures Excel and Google Sheets correctly interpret
  // CJK characters and other non-ASCII content without encoding prompt
  const BOM = '\uFEFF';

  const headers = schema.columns.map((col: Column) => _csvEscape(col.name, sep));

  const rows = items.map((item: CaptureItem) => {
    const mapped = _mapItem(item, schema, operator);
    return schema.columns.map((col: Column) => {
      const value = mapped[col.name];
      // WHY: convert null/undefined to empty string — CSV has no null representation
      return _csvEscape(value == null ? '' : String(value), sep);
    }).join(sep);
  });

  const csv = BOM + [headers.join(sep), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });

  // WHY: .tsv extension for tab-delimited files signals to OS/Sheets that the
  // file is tab-separated; comma-delimited uses .csv
  const ext = delimiter === 'tab' ? 'tsv' : 'csv';
  chrome.downloads.download({
    url:      URL.createObjectURL(blob),
    filename: `${subfolder}/${fileStem}.${ext}`,
    saveAs:   false,
  });
}

// WHY: CSV escaping — wrap in quotes if value contains the delimiter, double-quotes,
// or newlines; double any existing quotes inside the value (RFC 4180)
function _csvEscape(value: string, sep: string): string {
  if (value.includes(sep) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}
