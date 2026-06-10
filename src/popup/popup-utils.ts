/**
 * @module popup-utils
 * @responsibility Date formatting, timestamp generation, status bar display, date normalization
 * @owns _statusTimer; showStatus DOM writes (#status-bar); normalizeDate algorithm; applyDateNormalize UX logic
 * @not-owns State machine; chrome.storage; inbox rendering; capture flow
 * @depends-on shared/datetime (localISOWithOffset, normalizeDate)
 * @depended-by popup.js, popup-capture.js, popup-export.js
 * @context popup — runs in extension popup; no access to page DOM except own elements
 * @test manual — verify date normalization via Preview date field; verify status bar messages
 * @known-constraints ARTICLE-DATE-NA-PASSTHROUGH: 'na'/'NA' inputs produce null article_date (intentional — unknown date signal)
 */

// import for local use (applyDateNormalize) AND re-export so popup-utils importers keep working
import { localISOWithOffset, normalizeDate } from '../shared/datetime';
export { localISOWithOffset, normalizeDate };

// ── Time helpers ───────────────────────────────────────────────────────────

export function timeAgo(isoString: string): string {
  if (!isoString) return '';
  const then = new Date(isoString);
  if (isNaN(then.getTime())) return isoString;
  const diffMs = Date.now() - then.getTime();
  const secs   = Math.floor(diffMs / 1000);
  if (secs < 60)  return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function localTimestamp(): string {
  const d   = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ── Status bar ─────────────────────────────────────────────────────────────

let _statusTimer: ReturnType<typeof setTimeout> | null = null;

export function showStatus(msg: string, isError = false, durationMs = 3000): void {
  if (isError) durationMs = Math.max(durationMs, 4000);
  const bar = document.getElementById('status-bar')!;
  bar.textContent = msg;
  bar.className   = isError ? 'error' : '';
  bar.hidden      = false;
  clearTimeout(_statusTimer!);
  _statusTimer = setTimeout(() => { bar.hidden = true; }, durationMs);
}

// ── Date normalization UX ──────────────────────────────────────────────────

// WHY: extracted from init closure to enable unit boundary; reads DOM at call time
// (getElementById) rather than capturing refs, matching showStatus pattern.
// pendingItem param reserved for EXT-CUSTOM-SCHEMA (field-aware normalization).
// dateParseRetry replaces isSecondEnter — truthy means user already saw the ⚠ warning.
// Returns new dateParseRetry value for caller to store in module state.
export function applyDateNormalize(pendingItem: unknown, dateParseRetry: boolean): boolean {
  const pubInput = document.getElementById('prev-published') as HTMLInputElement;
  const dateHint = document.getElementById('date-hint')!;
  const result   = normalizeDate(pubInput.value);
  if (!result.failed && result.iso !== null) {
    // Success: replace input with normalized ISO, show ✓
    pubInput.value        = result.iso;
    dateHint.textContent  = '✓';
    dateHint.className    = 'date-hint success';
    return false;
  } else if (!result.failed && result.iso === null) {
    // Empty or 'na': clear input and hint
    pubInput.value        = '';
    dateHint.textContent  = '';
    dateHint.className    = 'date-hint';
    return false;
  } else if (result.failed && !dateParseRetry) {
    // WHY: first failure warns but does not discard — user may want to keep raw value
    dateHint.textContent  = '⚠ Could not parse — press Enter to keep as-is, or edit';
    dateHint.className    = 'date-hint warning';
    return true;
  } else {
    // Second Enter after failure, or blur after failure: accept raw as-is
    dateHint.textContent  = '';
    dateHint.className    = 'date-hint';
    return false;
  }
}
