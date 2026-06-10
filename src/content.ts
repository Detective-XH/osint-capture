/**
 * @module content
 * @responsibility Extract page metadata (title, URL, author, article_date, content) from active tab on demand; serve as Pick mode text-selection relay
 * @owns Page extraction logic (Defuddle + ClearURLs), captured_at timestamp generation, #osint-pick-hint overlay injection
 * @not-owns chrome.storage writes (only writes pick_result on PICK_MODE); SHA-256 hash computation (delegated to background.js); UI rendering
 * @depends-on Defuddle (ESM import, bundled at build time), lib/data.min.json (loaded via chrome.runtime.getURL at capture time), chrome.runtime.onMessage, chrome.storage.local (write-only for pick_result)
 * @depended-by popup.js (sends CAPTURE_PAGE and PICK_MODE messages)
 * @context content-script — runs in page isolated world; injected at document_idle on all URLs
 * @test manual — load extension in Edge, navigate to target page, click Capture; check popup preview fields
 * @known-constraints CLEARURLS-RUNTIME-LOAD: ClearURLs rules loaded via fetch(chrome.runtime.getURL) on every capture — async, no caching between captures (content scripts are stateless between messages)
 * @known-constraints ARTICLE-DATE-RAW: article_date is Defuddle's raw published string — format is site-dependent; no normalization applied here; may be non-ISO for sites without OG/schema.org metadata (see EXT-DATE-NORMALIZE roadmap item)
 * @known-constraints CHINESE-SITES-NULL: 中國軍網, 解放軍報, 人民日報, 微博, 微信公眾號 typically lack OG/schema.org markup → Defuddle returns null for published → article_date: null is the normal case for these sources; analyst uses Pick or manual entry
 */

import Defuddle from 'defuddle';
import { localISOWithOffset } from './shared/datetime';
import { loadCleanRules, cleanUrl } from './shared/clearurls';

// ── Author normalization ───────────────────────────────────────────────────

function normalizeAuthor(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const parts = raw
    .split(/,|\band\b/i)
    .map((s: string) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : null;
}

// ── HTML to plain text ─────────────────────────────────────────────────────

function htmlToText(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.innerText.trim();
}

// ── Main extract ───────────────────────────────────────────────────────────

async function extractPage() {
  const providers = await loadCleanRules();

  const result = new Defuddle(document, { url: window.location.href }).parse();

  const cleanedUrl = cleanUrl(window.location.href, providers);
  const captureTimestamp = localISOWithOffset();

  return {
    title: result.title?.trim() || document.title?.trim() || '',
    url: cleanedUrl,
    source: result.site?.trim() || new URL(cleanedUrl).hostname,
    author: normalizeAuthor(result.author),
    captured_at: captureTimestamp, // immutable capture record (D-012 revised)
    article_date: result.published ?? null, // Defuddle-extracted article date, may be null
    content: htmlToText(result.content ?? ''),
    content_hash: null, // computed by background.js (crypto.subtle secure context)
    raw_html_path: null,
    pdf_path: null,
  };
}

// ── Message listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CAPTURE_PAGE') {
    extractPage()
      .then((item) => sendResponse({ ok: true, item }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep message channel open for async response
  }

  if (message.type === 'PICK_MODE') {
    const field = message.field;

    // Remove any previous hint
    document.getElementById('osint-pick-hint')?.remove();

    const hint = document.createElement('div');
    hint.id = 'osint-pick-hint';
    hint.textContent = `Select text for "${field}", then re-open the extension.`;
    hint.style.cssText = [
      'position:fixed',
      'top:12px',
      'right:12px',
      'z-index:999999',
      'background:#0f1117',
      'color:#e6edf3',
      'padding:10px 14px',
      'border-radius:8px',
      'font-size:13px',
      'font-family:system-ui',
      'border-left:3px solid #4493f8',
      'max-width:280px',
      'box-shadow:0 2px 8px rgba(0,0,0,.5)',
    ].join(';');
    document.body.appendChild(hint);

    const onMouseUp = () => {
      const selected = window.getSelection()?.toString().trim();
      if (selected) {
        chrome.storage.local.set({ pick_result: { field, value: selected } }, () => {
          chrome.runtime.sendMessage({ type: 'PICK_DONE' });
        });
        hint.remove();
        document.removeEventListener('mouseup', onMouseUp);
      }
    };
    document.addEventListener('mouseup', onMouseUp);
    sendResponse({ ok: true });
    return true;
  }
});
