/**
 * @module popup-utils
 * @responsibility Date formatting, timestamp generation, status bar display, date normalization
 * @owns _statusTimer; showStatus DOM writes (#status-bar); normalizeDate algorithm; applyDateNormalize UX logic
 * @not-owns State machine; chrome.storage; inbox rendering; capture flow
 * @depends-on (none)
 * @depended-by popup.js, popup-capture.js, popup-export.js
 * @context popup — runs in extension popup; no access to page DOM except own elements
 * @test manual — verify date normalization via Preview date field; verify status bar messages
 * @known-constraints ARTICLE-DATE-NA-PASSTHROUGH: 'na'/'NA' inputs produce null article_date (intentional — unknown date signal)
 */

// ── Time helpers ───────────────────────────────────────────────────────────

export function timeAgo(isoString) {
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

export function localISOWithOffset() {
  const now    = new Date();
  const offset = -now.getTimezoneOffset();
  const sign   = offset >= 0 ? '+' : '-';
  const pad    = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return now.toISOString().slice(0, 19) + sign + pad(offset / 60) + ':' + pad(offset % 60);
}

export function localTimestamp() {
  const d   = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ── Status bar ─────────────────────────────────────────────────────────────

let _statusTimer = null;

export function showStatus(msg, isError = false, durationMs = 3000) {
  if (isError) durationMs = Math.max(durationMs, 4000);
  const bar = document.getElementById('status-bar');
  bar.textContent = msg;
  bar.className   = isError ? 'error' : '';
  bar.hidden      = false;
  clearTimeout(_statusTimer);
  _statusTimer = setTimeout(() => { bar.hidden = true; }, durationMs);
}

// ── Date normalization ─────────────────────────────────────────────────────

// WHY: article_date arrives in 12+ formats from Chinese/English military sites, Defuddle
// extraction, and manual entry. All timezone-naive inputs default to UTC (Z) per EXT-DATE-NORMALIZE.
// Supported: ISO passthrough, YYYY-MM-DD, YYYY/MM/DD HH:MM, YYYY/MM/DD, 14/12/8-digit compact,
// Chinese date (YYYY年M月D日 [HH:MM]), English month names (YYYY Mon DD, Mon DD YYYY).
export function normalizeDate(input) {
  if (!input || !input.trim()) return { iso: null, failed: false };
  const s = input.trim();
  if (s.toLowerCase() === 'na') return { iso: null, failed: false };

  // Pass-through: already ISO with timezone offset or Z
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    return { iso: s, failed: false };
  }
  // YYYY-MM-DD (date-only ISO, append T00:00:00Z)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return _validateISO(s + 'T00:00:00Z');
  }
  // YYYY/MM/DD HH:MM
  const slashDateTime = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (slashDateTime) {
    return _validateISO(`${slashDateTime[1]}-${slashDateTime[2]}-${slashDateTime[3]}T${slashDateTime[4]}:${slashDateTime[5]}:00Z`);
  }
  // YYYY/MM/DD
  const slashDate = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashDate) {
    return _validateISO(`${slashDate[1]}-${slashDate[2]}-${slashDate[3]}T00:00:00Z`);
  }
  // 14-digit compact: YYYYMMDDHHMMSS
  const d14 = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (d14) {
    return _validateISO(`${d14[1]}-${d14[2]}-${d14[3]}T${d14[4]}:${d14[5]}:${d14[6]}Z`);
  }
  // 12-digit compact: YYYYMMDDHHMM (SS defaults to 00)
  const d12 = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (d12) {
    return _validateISO(`${d12[1]}-${d12[2]}-${d12[3]}T${d12[4]}:${d12[5]}:00Z`);
  }
  // 8-digit compact: YYYYMMDD
  const d8 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (d8) {
    return _validateISO(`${d8[1]}-${d8[2]}-${d8[3]}T00:00:00Z`);
  }
  // Chinese date: YYYY年M月D日 [HH:MM] (optional time)
  const cn = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s+(\d{2}):(\d{2}))?$/);
  if (cn) {
    const mm = String(cn[2]).padStart(2, '0');
    const dd = String(cn[3]).padStart(2, '0');
    const time = cn[4] ? `${cn[4]}:${cn[5]}:00` : '00:00:00';
    return _validateISO(`${cn[1]}-${mm}-${dd}T${time}Z`);
  }
  // English month names — month map (first 3 chars, case-insensitive)
  const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  // "YYYY Mon DD [HH:MM]"
  const engA = s.match(/^(\d{4})\s+([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{2}):(\d{2}))?$/);
  if (engA) {
    const mo = MONTHS[engA[2].substring(0, 3).toLowerCase()];
    if (mo) {
      const mm = String(mo).padStart(2, '0'), dd = String(engA[3]).padStart(2, '0');
      const time = engA[4] ? `${engA[4]}:${engA[5]}:00` : '00:00:00';
      return _validateISO(`${engA[1]}-${mm}-${dd}T${time}Z`);
    }
  }
  // "Mon DD, YYYY" or "Month DD, YYYY"
  const engB = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (engB) {
    const mo = MONTHS[engB[1].substring(0, 3).toLowerCase()];
    if (mo) {
      const mm = String(mo).padStart(2, '0'), dd = String(engB[2]).padStart(2, '0');
      return _validateISO(`${engB[3]}-${mm}-${dd}T00:00:00Z`);
    }
  }
  return { iso: null, failed: true };
}

// WHY: validates the constructed ISO string to catch impossible dates (e.g. month 13, day 32)
function _validateISO(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? { iso: null, failed: true } : { iso, failed: false };
}

// ── Date normalization UX ──────────────────────────────────────────────────

// WHY: extracted from init closure to enable unit boundary; reads DOM at call time
// (getElementById) rather than capturing refs, matching showStatus pattern.
// pendingItem param reserved for EXT-CUSTOM-SCHEMA (field-aware normalization).
// dateParseRetry replaces isSecondEnter — truthy means user already saw the ⚠ warning.
// Returns new dateParseRetry value for caller to store in module state.
export function applyDateNormalize(pendingItem, dateParseRetry) {
  const pubInput = document.getElementById('prev-published');
  const dateHint = document.getElementById('date-hint');
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
