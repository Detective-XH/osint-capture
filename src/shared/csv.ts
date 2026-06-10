/**
 * @module shared/csv
 * Shared CSV helpers — single source of truth for RFC 4180 escaping, previously copied into
 * popup-export.ts and popup-merge.ts. (CSV *parsing* lives in popup-merge.ts, the only reader.)
 */

// WHY: CSV escaping — wrap in quotes if value contains the delimiter, double-quotes,
// or newlines; double any existing quotes inside the value (RFC 4180)
export function csvEscape(value: string, sep: string): string {
  if (value.includes(sep) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}
