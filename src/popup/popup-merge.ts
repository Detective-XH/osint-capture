/**
 * @module popup-merge
 * @responsibility Team CSV merge: folder read, header-based grouping across schemas, per-group URL dedup, custom field conflict resolution, per-group merged CSV download
 * @owns MERGE state panel rendering; folder read + header-grouping logic; CSV parse/merge/dedup algorithm; schema name extraction from filename pattern; inline _csvEscape (private copy of popup-export.js pattern)
 * @not-owns State machine (callback injection from popup.js); export schema storage (popup-schema.js); delimiter setting storage (popup-settings.js)
 * @depends-on popup-utils.js (showStatus); popup-schema.js (getExportSchema); chrome.storage.local (csv_delimiter, operator_name, download_subfolder)
 * @depended-by popup.js (init wiring)
 * @context popup — runs in extension popup; no access to page DOM
 * @test manual — merge folder with CSVs from 2+ schemas; verify header grouping, per-group dedup + conflict resolution, per-group download
 * @known-constraints POPUP-CLOSE-RISK: Chrome extension popups may close when file picker opens via input.click(); user reopens popup and retries if needed
 * @known-constraints NON-STANDARD-FILENAME: files not matching {timestamp}_{schema}_{operator}.csv fall back to 'unknown-schema' in the merged output filename
 * @known-constraints REJECTION-HANDLING: _runMerge() rejections are caught at the call site via
 *   .catch() → showStatus() (8 s, error) + console.error. Individual FileReader failures skip
 *   the affected file (console.warn + emptyFiles list) rather than aborting the batch.
 */

import { showStatus } from './popup-utils.js';
import { getExportSchema } from './popup-schema.js';

// ── Local type aliases (erased by esbuild) ─────────────────────────────────

/** A merged CSV row: string array with an optional attribution label grafted on. */
type MergedRow = string[] & { _opLabel?: string };

/** One entry in the per-file allRows list accumulated during folder read. */
interface RowEntry {
  row: string[];
  filename: string;
}

/** One header-homogeneous group produced in step 1. */
interface Group {
  header: string[];
  allRows: RowEntry[];
  totalRows: number;
  sourceFiles: string[];
}

/** A fully merged group ready for rendering / download. */
interface MergedGroup {
  index: number;
  header: string[];
  mergedRows: MergedRow[];
  sourceFiles: string[];
  totalRows: number;
  conflicts: number;
  filename: string;
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Open the folder picker and begin the CSV merge flow.
 * WHY: callback injection — setState is popup.js FSM; direct import would create circular dependency.
 * @param {Function} setState
 */
export function openMerge(setState: (s: string) => void): void {
  // WHY: webkitdirectory is the only reliable way to pick a folder in an extension popup.
  // showDirectoryPicker() (File System Access API) is blocked in extension popup origin.
  const input = document.getElementById('merge-folder-input') as HTMLInputElement;

  // Re-wire change handler fresh each invocation to avoid duplicate listeners from prior opens
  const handler = (e: Event) => {
    input.removeEventListener('change', handler);
    // WHY: .catch() surfaces any async rejection (storage API, getExportSchema, FileReader)
    // as a visible error — MERGE panel stays hidden but user sees an 8-second error status.
    _runMerge((e.target as HTMLInputElement).files!, setState).catch(err => {
      console.error('[popup-merge] Merge failed:', err);
      showStatus('Merge failed: ' + (err.message || 'unknown error'), true, 8000);
    });
    // Reset so the same folder can be re-selected on retry
    input.value = '';
  };
  input.addEventListener('change', handler);
  input.click();
}

// ── Core merge orchestration ───────────────────────────────────────────────

async function _runMerge(fileList: FileList, setState: (s: string) => void): Promise<void> {
  const csvFiles = Array.from(fileList).filter((f: File) =>
    /\.(csv|tsv)$/i.test(f.name));

  if (csvFiles.length === 0) {
    // WHY: showStatus() writes to #status-bar (visible in all states). MERGE panel is NOT shown
    // on this early exit — setState('MERGE') is never called here. 8-second error duration
    // ensures the message stays visible long enough for the user to read it.
    showStatus('No CSV files found in selected folder.', true, 8000);
    return;
  }

  // WHY: load schema + settings in parallel to minimise latency.
  // Rejection from either promise propagates to the .catch() at the call site in openMerge().
  const [schema, settings] = await Promise.all([
    getExportSchema(),
    new Promise(resolve =>
      chrome.storage.local.get(['csv_delimiter', 'operator_name', 'download_subfolder'], resolve)),
  ]);

  const outputSep = (settings as Record<string, string>).csv_delimiter === 'tab' ? '\t' : ',';

  // WHY: URL and operator column names come from the active schema.
  // Groups whose headers don't include these names fall back gracefully (urlIdx/opIdx = -1).
  const urlColName = schema.columns.find(c => c.source === 'url')?.name ?? null;
  const opColName  = schema.columns.find(c => c.source === 'operator_name')?.name ?? null;

  // ── Step 1: Group files by header ─────────────────────────────────────────
  // WHY: files from different schemas have different headers and must be merged independently;
  // key = null-byte-joined header string (null bytes are safe — unlikely in CSV column names).
  const groupMap   = new Map<string, Group>(); // headerKey → { header, allRows, totalRows, sourceFiles }
  const emptyFiles: string[] = [];             // files with no parseable header

  for (const file of csvFiles) {
    let text: string;
    try {
      text = await _readFile(file);
    } catch (err) {
      // WHY: isolate per-file failures — one unreadable file must not abort the entire batch
      console.warn('[popup-merge] Skipping unreadable file:', file.name, (err as Error).message);
      emptyFiles.push(file.name);
      continue;
    }
    // WHY: input files may use tab or comma; detect from extension to handle both formats
    const inputSep = _detectSep(file.name);
    const { header, rows } = _parseCsv(text, inputSep);

    if (header.length === 0) {
      emptyFiles.push(file.name);
      continue;
    }

    const key = header.join('\x00');
    if (!groupMap.has(key)) {
      groupMap.set(key, { header, allRows: [], totalRows: 0, sourceFiles: [] });
    }
    const group = groupMap.get(key)!;
    group.totalRows += rows.length;
    group.sourceFiles.push(file.name);
    for (const row of rows) {
      group.allRows.push({ row, filename: file.name });
    }
  }

  if (groupMap.size === 0) {
    // WHY: same early-exit pattern as csvFiles.length === 0 — showStatus only (8-second error);
    // MERGE panel stays hidden. Reached when all CSV files had empty or unparseable headers.
    showStatus('No valid CSV files could be read.', true, 8000);
    return;
  }

  // ── Step 2: Merge each group independently ────────────────────────────────
  const now       = new Date();
  const ts        = now.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const subfolder = ((settings as Record<string, string>).download_subfolder || 'osint-captures').replace(/[^a-z0-9_\-]/gi, '-');
  const ext       = outputSep === '\t' ? 'tsv' : 'csv';

  const mergedGroups: MergedGroup[] = [];
  let groupIndex = 0;

  for (const [, group] of groupMap) {
    groupIndex++;
    // WHY: compute column indices per group — each group has its own header, so positions differ
    const urlIdx = urlColName !== null ? group.header.indexOf(urlColName) : -1;
    const opIdx  = opColName  !== null ? group.header.indexOf(opColName)  : -1;

    const { mergedMap, conflicts } = _mergeRows(group.allRows, urlIdx, opIdx);
    const mergedRows = Array.from(mergedMap.values());

    mergedGroups.push({
      index:       groupIndex,
      header:      group.header,
      mergedRows,
      sourceFiles: group.sourceFiles,
      totalRows:   group.totalRows,
      conflicts,
      filename:    _mergedFilename(group.sourceFiles, ts, subfolder, ext),
    });
  }

  _renderGroupSummary(mergedGroups, emptyFiles, outputSep);
  setState('MERGE');
}

// ── Merge algorithm ────────────────────────────────────────────────────────

/**
 * Merge rows from all files by URL dedup with conflict resolution.
 * WHY: URL is the canonical dedup key — same article captured by multiple analysts → one row.
 */
function _mergeRows(allRows: RowEntry[], urlIdx: number, opIdx: number): { mergedMap: Map<string, MergedRow>; conflicts: number } {
  const mergedMap = new Map<string, MergedRow>();  // url → merged row array
  let conflicts = 0;

  for (const { row, filename } of allRows) {
    // WHY: rows without a URL are unidentifiable — use synthetic key to preserve all rows
    const url    = urlIdx >= 0 ? (row[urlIdx] || '') : '';
    const rowKey = url || `__no_url__${mergedMap.size}`;

    if (!mergedMap.has(rowKey)) {
      const stored: MergedRow = [...row];
      // WHY: store filename as fallback attribution when no operator column exists
      stored._opLabel = opIdx >= 0 ? (row[opIdx] || filename) : filename;
      mergedMap.set(rowKey, stored);
      continue;
    }

    const existing = mergedMap.get(rowKey)!;
    for (let i = 0; i < Math.max(existing.length, row.length); i++) {
      if (i === urlIdx) continue; // URL column — already matched; don't mutate

      const a = existing[i] || '';
      const b = row[i] || '';

      if (!a && b) {
        // WHY: fill: existing is empty but incoming has a value — keep it
        existing[i] = b;
      } else if (a && b && a !== b) {
        // WHY: conflict — both have different values; concatenate with operator attribution
        // so analysts can see who contributed each value during review
        const opA = opIdx >= 0 ? (existing[opIdx] || existing._opLabel || 'Unknown') : (existing._opLabel || 'Unknown');
        const opB = opIdx >= 0 ? (row[opIdx]      || filename            || 'Unknown') : (filename || 'Unknown');
        existing[i] = `${a} [${opA}] | ${b} [${opB}]`;
        conflicts++;
      }
      // else: both empty or identical → no change
    }
  }

  return { mergedMap, conflicts };
}

// ── Summary UI ─────────────────────────────────────────────────────────────

/**
 * Render the merge summary into #merge-summary and wire the primary action
 * button into #merge-primary-actions.
 * WHY: groups are independent — different schemas, different headers, separate output files.
 * Single group: compact intro + stats + one Download. Multi: "Found N" header +
 * per-group sections + Download All.
 */
function _renderGroupSummary(mergedGroups: MergedGroup[], emptyFiles: string[], outputSep: string): void {
  const container    = document.getElementById('merge-summary') as HTMLElement;
  const actionsSlot  = document.getElementById('merge-primary-actions') as HTMLElement;
  container.innerHTML   = '';
  actionsSlot.innerHTML = '';

  const isSingle = mergedGroups.length === 1;

  if (!isSingle) {
    // WHY: multi-group header tells the operator how many distinct file types were found
    const hdr = document.createElement('div');
    hdr.className   = 'merge-multi-header';
    hdr.textContent = `Found ${mergedGroups.length} file types`;
    container.appendChild(hdr);
  }

  for (const group of mergedGroups) {
    const schemaName = _groupSchemaName(group);
    const dupes      = group.totalRows - group.mergedRows.length;

    if (isSingle) {
      // WHY: single-group intro summarises the merge on one line before the stats
      const n    = group.sourceFiles.length;
      const intro = document.createElement('div');
      intro.className   = 'merge-group-intro';
      intro.textContent = `${n} file${n !== 1 ? 's' : ''} combined (${schemaName})`;
      container.appendChild(intro);

      _appendStat(container, 'Total entries',   group.totalRows);
      if (dupes > 0)            _appendStat(container, 'Duplicates removed', dupes);
      _appendStat(container, 'Unique entries',  group.mergedRows.length);
      if (group.conflicts > 0)  _appendStat(container, 'Conflicts resolved', group.conflicts);
    } else {
      // WHY: separator visually scopes each file-type section; schema name + file count at a glance
      const n   = group.sourceFiles.length;
      const sep = document.createElement('div');
      sep.className   = 'merge-group-sep';
      sep.textContent = `── ${schemaName} (${n} file${n !== 1 ? 's' : ''}) ──`;
      container.appendChild(sep);

      _appendStat(container, 'Items captured',  group.totalRows);
      if (dupes > 0)            _appendStat(container, 'Duplicates removed', dupes);
      _appendStat(container, 'Unique items',    group.mergedRows.length);
      if (group.conflicts > 0)  _appendStat(container, 'Conflicts resolved', group.conflicts);

      // Per-group download button (only rendered for multi — single uses the primary slot below)
      const dlBtn = document.createElement('button');
      dlBtn.className = 'btn-primary merge-group-dl';
      dlBtn.textContent = 'Download';
      // WHY: capture loop variable to avoid closure referencing last group after iteration
      const capturedGroup = group;
      dlBtn.addEventListener('click', () => {
        _downloadGroup(capturedGroup.header, capturedGroup.mergedRows, capturedGroup.filename, outputSep);
      });
      container.appendChild(dlBtn);
    }
  }

  if (emptyFiles.length > 0) {
    _appendStat(container, 'Skipped files', emptyFiles.length);
    for (const name of emptyFiles) {
      const item = document.createElement('div');
      item.className  = 'merge-skipped';
      item.textContent = name;
      container.appendChild(item);
    }
  }

  // WHY: primary action button lives in .merge-actions alongside the static Cancel button
  // so both appear on the same flex row at the panel bottom
  const primaryBtn = document.createElement('button');
  primaryBtn.className = 'btn-primary';

  if (isSingle) {
    primaryBtn.textContent = 'Download';
    const g = mergedGroups[0];
    primaryBtn.addEventListener('click', () => {
      _downloadGroup(g.header, g.mergedRows, g.filename, outputSep);
    });
  } else {
    primaryBtn.textContent = 'Download All';
    // WHY: sequential downloads — triggering all at once can exceed Chrome download rate limits
    primaryBtn.addEventListener('click', () => {
      for (const g of mergedGroups) {
        _downloadGroup(g.header, g.mergedRows, g.filename, outputSep);
      }
    });
  }

  actionsSlot.appendChild(primaryBtn);
}

/**
 * Resolve a human-readable schema name for a group.
 * WHY: _extractSchemaName returns 'unknown-schema' for non-standard filenames;
 * fall back to positional label so the summary always shows a meaningful name.
 */
function _groupSchemaName(group: MergedGroup): string {
  const raw = _extractSchemaName(group.sourceFiles[0]);
  return raw === 'unknown-schema' ? `Type ${group.index}` : raw;
}

/** Append a plain-text "label: value" stat line to a container element. */
function _appendStat(container: HTMLElement, label: string, value: string | number): void {
  const row = document.createElement('div');
  row.className   = 'merge-stat';
  row.textContent = `${label}: ${value}`;
  container.appendChild(row);
}

// ── Filename helpers ───────────────────────────────────────────────────────

/**
 * Build the output merged filename for a group.
 * WHY: mirrors popup-export.js naming convention so merged files sort alongside their sources.
 * Operator segment omitted when blank — avoids trailing-underscore filenames.
 */
function _mergedFilename(sourceFiles: string[], ts: string, subfolder: string, ext: string): string {
  const schemaName = _extractSchemaName(sourceFiles[0]);
  const stem       = sourceFiles[0].replace(/\.(csv|tsv)$/i, '');
  const parts      = stem.split('_');
  // WHY: last segment of a standard export filename is the operator name
  const opName     = parts.length >= 2 ? parts[parts.length - 1] : '';
  const schemaSafe = schemaName.replace(/[^a-z0-9_\-]/gi, '-');
  const opSafe     = opName.replace(/[^a-z0-9_\-]/gi, '-');

  const fileStem = opSafe
    ? `merged_${ts}_${schemaSafe}_${opSafe}`
    : `merged_${ts}_${schemaSafe}`;
  return `${subfolder}/${fileStem}.${ext}`;
}

/**
 * Parse the schema name from an export filename.
 * WHY: export filename pattern is {timestamp}_{schema_name}_{operator_name}.csv;
 * middle segments (between first and last _-delimited parts) form the schema name.
 * Falls back to 'unknown-schema' for files not matching the standard pattern.
 */
function _extractSchemaName(filename: string): string {
  const stem  = filename.replace(/\.(csv|tsv)$/i, '');
  const parts = stem.split('_');
  if (parts.length >= 3) return parts.slice(1, -1).join('_');
  return 'unknown-schema';
}

// ── CSV download ───────────────────────────────────────────────────────────

/**
 * Download one group's merged CSV.
 * WHY: filename (including subfolder path) is pre-computed in _runMerge so all groups
 * share the same timestamp — consistent batch naming even if downloads are triggered later.
 */
function _downloadGroup(header: string[], rows: MergedRow[], filename: string, sep: string): void {
  const text = _buildCsvText(header, rows, sep);
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const stem = filename.split('/').pop();

  chrome.downloads.download({
    url:    URL.createObjectURL(blob),
    filename,
    saveAs: false,
  });

  showStatus(`Downloaded ${stem} — ${rows.length} rows`);
}

// ── CSV utilities ──────────────────────────────────────────────────────────

/**
 * Build final CSV text: UTF-8 BOM + header + data rows, CRLF line endings.
 * WHY: UTF-8 BOM prefix ensures Excel and Google Sheets correctly interpret
 * CJK characters without encoding prompt — matches Phase 3 export format.
 */
function _buildCsvText(header: string[], rows: MergedRow[], sep: string): string {
  const BOM = '﻿';
  const escape = (v: string) => _csvEscape(v, sep);

  const headerLine = header.map(escape).join(sep);
  const dataLines  = rows.map(row =>
    header.map((_, i) => escape(row[i] == null ? '' : String(row[i]))).join(sep));

  return BOM + [headerLine, ...dataLines].join('\r\n');
}

/**
 * Read a File object as a UTF-8 string.
 * @param {File} file
 * @returns {Promise<string>}
 */
function _readFile(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve((e.target as FileReader).result as string);
    // WHY: rejection propagates to the try/catch in the _runMerge loop — the failed file is
    // skipped (logged to console.warn, added to emptyFiles); remaining files continue.
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsText(file, 'utf-8');
  });
}

/**
 * Detect CSV delimiter from file extension.
 * WHY: .tsv files use tab by convention; all others default to comma.
 */
function _detectSep(filename: string): string {
  return /\.tsv$/i.test(filename) ? '\t' : ',';
}

/**
 * Parse a CSV/TSV string into header + rows arrays.
 * Handles: quoted fields, escaped double-quotes (RFC 4180), CRLF or LF.
 * WHY: BOM stripped from first field so header comparison works across
 * files with and without BOM prefix.
 */
function _parseCsv(text: string, sep: string): { header: string[]; rows: string[][] } {
  // WHY: strip UTF-8 BOM if present — Excel adds it; without stripping,
  // the first header field won't match the schema display name
  const clean = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/);

  const result: string[][] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    result.push(_parseCsvLine(line, sep));
  }

  if (result.length === 0) return { header: [], rows: [] };
  return { header: result[0], rows: result.slice(1) };
}

/**
 * Parse one CSV line respecting RFC 4180 quoting.
 */
function _parseCsvLine(line: string, sep: string): string[] {
  const fields: string[] = [];
  let i = 0;

  while (i <= line.length) {
    if (i === line.length) { fields.push(''); break; }

    if (line[i] === '"') {
      // Quoted field: consume until closing quote, doubling escape ""
      let field = '';
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          field += line[i++];
        }
      }
      fields.push(field);
      // Skip trailing separator
      if (line[i] === sep) i++;
    } else {
      // Unquoted field: read until separator or end
      const start = i;
      while (i < line.length && line[i] !== sep) i++;
      fields.push(line.slice(start, i));
      if (line[i] === sep) i++;
    }
  }

  return fields;
}

/**
 * CSV escape: wrap in quotes if value contains the delimiter, double-quotes, or newlines.
 * WHY: inline copy — popup-export.js _csvEscape is private to that module (not exported).
 * Implementation matches RFC 4180 and Phase 3 export format exactly.
 */
function _csvEscape(value: string, sep: string): string {
  if (value.includes(sep) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}
