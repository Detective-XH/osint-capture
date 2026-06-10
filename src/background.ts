/**
 * @module background
 * @responsibility Maintain inbox badge count; compute SHA-256 hashes; handle context menu
 *   (open popup for page captures, direct fetch+store for link captures) and keyboard shortcut
 * @owns Badge text/color/background; SHA-256 computation; context menu items "capture-page"
 *   and "capture-link"; captures[] writes via appendCapture() (link-capture path only)
 * @not-owns popup-triggered captures (popup.js saveInbox() owns that path); page extraction
 *   for popup path; UI rendering
 * @depends-on chrome.storage.local (read: captures, schemas; write: captures for link-capture),
 *   chrome.action, chrome.contextMenus, chrome.commands, chrome.runtime.onMessage,
 *   self.crypto.subtle, DOMParser (optional, link-capture; regex fallback when unavailable),
 *   fetch (link-capture)
 * @depended-by popup.js (sends HASH_CONTENT message to compute hash in service worker context)
 * @context service-worker — Manifest V3 service worker; no DOM access
 * @test manual — right-click a link, verify badge flashes ✓ and inbox gains new item;
 *   capture via popup, verify badge increments; check content_hash field in exported JSON
 * @known-constraints SHA256-SERVICE-WORKER: crypto.subtle must run in service worker (secure
 *   context); popup.js delegates hash computation here because service workers have
 *   self.crypto.subtle reliably; popup context availability varies by browser version
 * @known-constraints CONTEXT-MENU-OPEN-ONLY: capture-page context menu calls
 *   chrome.action.openPopup() only — does not auto-capture; user must click Capture in popup
 * @known-constraints OPEN-POPUP-CHROME-VERSION: chrome.action.openPopup() available for
 *   released (non-dev-mode) extensions only from Chrome/Edge 127+; silently no-ops on older
 * @known-constraints LINK-CAPTURE-DOMPARSER-FALLBACK: typeof DOMParser guard used before
 *   instantiation; regex fallback handles Brave and other forks that omit DOMParser from
 *   service worker global scope (confirmed missing in Brave Chromium 146)
 * @known-constraints LINK-CAPTURE-EPOCH-FALLBACK: if article:published_time year < 2000, falls
 *   back to article:modified_time — covers broken CMS metadata (e.g., udn.com epoch dates)
 * @known-constraints LINK-CAPTURE-NO-DEFUDDLE: link capture uses OG/meta tag extraction only —
 *   no article body (description meta only); lower fidelity than popup path by design
 * @known-constraints LINK-CAPTURE-SHARED-UTILS: normalizeDate/localISOWithOffset/loadCleanRules/
 *   cleanUrl imported from src/shared/ (esbuild inlines them; bundled output is still a classic
 *   script with no top-level import/export statements)
 */

// OSINT Capture — Background service worker

import { localISOWithOffset, normalizeDate } from './shared/datetime';
import { loadCleanRules, cleanUrl } from './shared/clearurls';
import type { CaptureItem, SchemaStorage } from './types';

// ── Badge count ─────────────────────────────────────────────────────────────

async function updateBadge() {
  const { captures = [] } = await chrome.storage.local.get('captures') as { captures?: CaptureItem[] };
  const count = captures.length;
  if (count === 0) {
    chrome.action.setBadgeText({ text: '' });
  } else {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#4493f8' });
    chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }
}

// ── SHA-256 hash (runs in secure service worker context) ────────────────────

async function computeHash(text: string) {
  try {
    const data = new TextEncoder().encode(text);
    const buf = await self.crypto.subtle.digest('SHA-256', data);
    const hex = Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    return 'sha256:' + hex;
  } catch {
    return null;
  }
}

// ── Badge flash ─────────────────────────────────────────────────────────────

function flashBadge(success: boolean) {
  // WHY: only feedback channel for background captures — no popup DOM available
  chrome.action.setBadgeText({ text: success ? '✓' : '✗' });
  chrome.action.setBadgeBackgroundColor({ color: success ? '#26a641' : '#d1242f' });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
  // WHY: restore count badge after 2s; onChanged may fire earlier — that's fine, count is correct
  setTimeout(updateBadge, 2000);
}

// ── Active schema lookup ────────────────────────────────────────────────────

async function getActiveSchema() {
  // WHY: stamps schema provenance on link-capture items (same field as popup.js savePreviewItem)
  const { schemas: sd = {} as SchemaStorage } = await chrome.storage.local.get('schemas') as { schemas?: SchemaStorage };
  const list   = Array.isArray(sd.schemas) ? sd.schemas : [];
  const active = list.find((s: { id: string }) => s.id === sd.active_schema_id) ?? list[0];
  return {
    id:   active?.id   ?? '00000000-0000-0000-0000-000000000001',
    name: active?.name ?? 'Default',
  };
}

// ── Append capture ──────────────────────────────────────────────────────────

async function appendCapture(item: CaptureItem) {
  // WHY: prepend to captures[] so newest items appear first — matches popup.js saveInbox order
  const { captures = [] } = await chrome.storage.local.get('captures') as { captures?: CaptureItem[] };
  await chrome.storage.local.set({ captures: [item, ...captures] });
}

// ── Meta extraction (DOMParser with regex fallback) ─────────────────────────

// eslint-disable-next-line complexity -- intrinsic: extracts 6 independent meta fields, each via a multi-source `?.content?.trim() ?? ...` fallback chain; ESLint counts every optional-chain link, so the score is field-count × fallback-depth, not nested logic. Splitting into dom/regex helpers leaves the DOM half ~33; not worth the indirection.
function extractMetaFromHTML(html: string, url: string) {
  // WHY: DOMParser absent in Brave/some Chromium forks — typeof guard avoids ReferenceError;
  // regex path extracts identical fields from the raw HTML string
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // WHY: prefer article:published_time (structured schema.org) over pubdate and time[datetime]
    let rawDate = (doc.querySelector('meta[property="article:published_time"]') as HTMLMetaElement | null)?.content
               ?? (doc.querySelector('meta[name="pubdate"]') as HTMLMetaElement | null)?.content
               ?? doc.querySelector('time[datetime]')?.getAttribute('datetime')
               ?? null;
    // WHY: some sites set article:published_time to Unix epoch (e.g., udn.com → 1970-01-01);
    // article:modified_time is a better proxy when published_time is clearly broken
    if (rawDate) {
      try {
        if (new Date(rawDate).getFullYear() < 2000) {
          rawDate = (doc.querySelector('meta[property="article:modified_time"]') as HTMLMetaElement | null)?.content ?? rawDate;
        }
      } catch { /* keep rawDate as-is */ }
    }
    return {
      // WHY: prefer og:title over <title> — og:title is the article headline; <title> often has
      // site name appended ("Article Title | Site Name")
      title:   (doc.querySelector('meta[property="og:title"]') as HTMLMetaElement | null)?.content?.trim()
               ?? doc.querySelector('title')?.textContent?.trim()
               ?? '',
      source:  (doc.querySelector('meta[property="og:site_name"]') as HTMLMetaElement | null)?.content?.trim()
               || new URL(url).hostname,
      author:  (doc.querySelector('meta[name="author"]') as HTMLMetaElement | null)?.content?.trim()
               || (doc.querySelector('meta[property="article:author"]') as HTMLMetaElement | null)?.content?.trim()
               || null,
      rawDate,
      // WHY: og:description is the best available content proxy when article body is not extracted
      content: (doc.querySelector('meta[property="og:description"]') as HTMLMetaElement | null)?.content?.trim()
               || (doc.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content?.trim()
               || '',
    };
  }
  // ── Regex fallback ─────────────────────────────────────────────────────────
  function _reMeta(nameAttr: string, nameVal: string) {
    // WHY: attribute order varies — match both orderings (property/name before/after content)
    const re = new RegExp(
      `<meta[^>]+${nameAttr}=["']${nameVal}["'][^>]+content=["']([^"'<>]+)["']` +
      `|<meta[^>]+content=["']([^"'<>]+)["'][^>]+${nameAttr}=["']${nameVal}["']`,
      'i'
    );
    const m = re.exec(html);
    return m ? (m[1] ?? m[2] ?? '').trim() || null : null;
  }
  const ogTitle  = _reMeta('property', 'og:title');
  const titleTag = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  const timeTag  = /<time[^>]+datetime=["']([^"'<>]+)["']/i.exec(html);
  let rawDate = _reMeta('property', 'article:published_time')
              ?? _reMeta('name', 'pubdate')
              ?? (timeTag ? timeTag[1].trim() : null);
  // WHY: same epoch fallback as DOMParser path
  if (rawDate) {
    try {
      if (new Date(rawDate).getFullYear() < 2000) {
        rawDate = _reMeta('property', 'article:modified_time') ?? rawDate;
      }
    } catch { /* keep rawDate as-is */ }
  }
  return {
    title:   ogTitle ?? (titleTag ? titleTag[1].trim() : '') ?? '',
    source:  _reMeta('property', 'og:site_name') || new URL(url).hostname,
    author:  _reMeta('name', 'author') ?? _reMeta('property', 'article:author'),
    rawDate,
    content: _reMeta('property', 'og:description') ?? _reMeta('name', 'description') ?? '',
  };
}

// ── Install / startup ───────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'capture-page',
    title: 'Capture this page (OSINT)',
    contexts: ['page', 'selection']
  });
  // WHY: separate menu item for link targets — direct fetch+store, no popup required
  chrome.contextMenus.create({
    id: 'capture-link',
    title: 'Capture this link (OSINT)',
    contexts: ['link']
  });
  updateBadge();
});

chrome.runtime.onStartup.addListener(updateBadge);

// ── Storage change → update badge ───────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.captures) updateBadge();
});

// ── Context menu click ──────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'capture-page') {
    chrome.action.openPopup();
  }
  if (info.menuItemId === 'capture-link') {
    // WHY: catch at top level — any failure in the async chain calls flashBadge(false)
    captureLinkItem(info.linkUrl!).catch(err => {
      console.error('[capture-link] failed:', err);
      flashBadge(false);
    });
  }
});

// ── Link capture ────────────────────────────────────────────────────────────

async function captureLinkItem(rawUrl: string) {
  const providers = await loadCleanRules();
  const url       = cleanUrl(rawUrl, providers);

  const response = await fetch(url);
  // WHY: non-2xx responses (login walls, paywalls) still return HTML — proceed; truly malformed
  // responses (network error, JSON, binary) are caught by the outer .catch() → flashBadge(false)
  const html = await response.text();

  // WHY: extractMetaFromHTML handles DOMParser unavailability via typeof guard + regex fallback
  const { title, source, author, rawDate, content } = extractMetaFromHTML(html, url);

  const norm        = rawDate ? normalizeDate(rawDate) : { iso: null, failed: false };
  const article_date = (norm.iso !== null) ? norm.iso : rawDate;

  const content_hash                    = await computeHash(content);
  const { id: schema_id, name: schema_name } = await getActiveSchema();

  const item = {
    id:            crypto.randomUUID(),
    title,
    url,
    source,
    author,
    captured_at:   localISOWithOffset(),
    article_date:  article_date || null,
    content,
    content_hash,
    raw_html_path: null,
    pdf_path:      null,
    schema_id,
    schema_name,
  };

  await appendCapture(item);
  flashBadge(true);
}

// ── Keyboard shortcut (Alt+Shift+C) ────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-page') {
    chrome.action.openPopup();
  }
});

// ── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'HASH_CONTENT') {
    computeHash(msg.text).then(hash => sendResponse({ hash }));
    return true; // async
  }
  if (msg.type === 'PICK_DONE') {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#3fb950' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 8000);
  }
});
