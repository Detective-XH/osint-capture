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
 * @known-constraints LINK-CAPTURE-DUPLICATE-UTILS: normalizeDate/_validateISO/localISOWithOffset/
 *   loadCleanRules/cleanUrl duplicated from popup-utils.js and content.js — classic SW cannot
 *   import shared modules; update both copies if algorithm changes
 */

// OSINT Capture — Background service worker

// ── Badge count ─────────────────────────────────────────────────────────────

async function updateBadge() {
  const { captures = [] } = await chrome.storage.local.get('captures') as { captures?: any[] };
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
  const { schemas: sd = {} } = await chrome.storage.local.get('schemas') as { schemas?: any };
  const list   = Array.isArray(sd.schemas) ? sd.schemas : [];
  const active = list.find((s: any) => s.id === sd.active_schema_id) ?? list[0];
  return {
    id:   active?.id   ?? '00000000-0000-0000-0000-000000000001',
    name: active?.name ?? 'Default',
  };
}

// ── Append capture ──────────────────────────────────────────────────────────

async function appendCapture(item: any) {
  // WHY: prepend to captures[] so newest items appear first — matches popup.js saveInbox order
  const { captures = [] } = await chrome.storage.local.get('captures') as { captures?: any[] };
  await chrome.storage.local.set({ captures: [item, ...captures] });
}

// ── localISOWithOffset — DUPLICATED from popup-utils.js (classic SW cannot import) ──────────

function localISOWithOffset() {
  const now    = new Date();
  const offset = -now.getTimezoneOffset();
  const sign   = offset >= 0 ? '+' : '-';
  const pad    = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return now.toISOString().slice(0, 19) + sign + pad(offset / 60) + ':' + pad(offset % 60);
}

// ── normalizeDate — DUPLICATED from popup-utils.js (classic SW cannot import) ───────────────
// WHY: apply date normalization to article:published_time meta values before storing —
// skipping popup's preview step means we normalize at capture time instead.
// Supported formats: ISO passthrough, YYYY-MM-DD, YYYY/MM/DD [HH:MM], compact 8/12/14-digit,
// Chinese date (YYYY年M月D日), English month names. All timezone-naive → UTC (Z).

function _validateISO(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? { iso: null, failed: true } : { iso, failed: false };
}

function normalizeDate(input: string) {
  if (!input || !input.trim()) return { iso: null, failed: false };
  const s = input.trim();
  if (s.toLowerCase() === 'na') return { iso: null, failed: false };
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    return { iso: s, failed: false };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return _validateISO(s + 'T00:00:00Z');
  const slashDT = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (slashDT) return _validateISO(`${slashDT[1]}-${slashDT[2]}-${slashDT[3]}T${slashDT[4]}:${slashDT[5]}:00Z`);
  const slashD = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashD) return _validateISO(`${slashD[1]}-${slashD[2]}-${slashD[3]}T00:00:00Z`);
  const d14 = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (d14) return _validateISO(`${d14[1]}-${d14[2]}-${d14[3]}T${d14[4]}:${d14[5]}:${d14[6]}Z`);
  const d12 = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (d12) return _validateISO(`${d12[1]}-${d12[2]}-${d12[3]}T${d12[4]}:${d12[5]}:00Z`);
  const d8 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (d8) return _validateISO(`${d8[1]}-${d8[2]}-${d8[3]}T00:00:00Z`);
  const cn = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s+(\d{2}):(\d{2}))?$/);
  if (cn) {
    const mm = String(cn[2]).padStart(2, '0'), dd = String(cn[3]).padStart(2, '0');
    return _validateISO(`${cn[1]}-${mm}-${dd}T${cn[4] ? `${cn[4]}:${cn[5]}:00` : '00:00:00'}Z`);
  }
  const MONTHS: Record<string, number> = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const engA = s.match(/^(\d{4})\s+([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{2}):(\d{2}))?$/);
  if (engA) {
    const mo = MONTHS[engA[2].substring(0, 3).toLowerCase()];
    if (mo) {
      const mm = String(mo).padStart(2, '0'), dd = String(engA[3]).padStart(2, '0');
      return _validateISO(`${engA[1]}-${mm}-${dd}T${engA[4] ? `${engA[4]}:${engA[5]}:00` : '00:00:00'}Z`);
    }
  }
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

// ── ClearURLs — DUPLICATED from content.js (classic SW cannot import) ────────────────────────

async function loadCleanRules() {
  const url  = chrome.runtime.getURL('lib/data.min.json');
  const res  = await fetch(url);
  const data = await res.json();
  return data.providers;
}

function cleanUrl(rawUrl: string, providers: any) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return rawUrl; }
  for (const provider of Object.values(providers) as any[]) {
    try { if (!new RegExp(provider.urlPattern, 'i').test(rawUrl)) continue; } catch { continue; }
    const exceptions = provider.exceptions ?? [];
    if (exceptions.some((ex: any) => { try { return new RegExp(ex, 'i').test(rawUrl); } catch { return false; } })) continue;
    for (const rule of (provider.rules ?? [])) {
      let re; try { re = new RegExp('^(?:' + rule + ')$', 'i'); } catch { continue; }
      for (const key of [...parsed.searchParams.keys()]) { if (re.test(key)) parsed.searchParams.delete(key); }
    }
    for (const raw of (provider.rawRules ?? [])) {
      try { parsed.pathname = parsed.pathname.replace(new RegExp(raw, 'i'), ''); } catch { /* skip */ }
    }
  }
  return parsed.toString();
}

// ── Meta extraction (DOMParser with regex fallback) ─────────────────────────

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
