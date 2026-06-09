/**
 * @module popup-capture
 * @responsibility Page capture trigger, content script messaging, pick mode for field selection; btn-capture stays 'Capture' permanently (extension popup always operates on the current tab)
 * @owns captureCurrentTab flow (tab query → content.js CAPTURE_PAGE → background.js HASH_CONTENT → callback); pick_pending chrome.storage writes
 * @not-owns Preview UI population; state machine; inbox rendering
 * @depends-on popup-utils.js (showStatus)
 * @depended-by popup.js (init wiring)
 * @context popup — runs in extension popup; no access to page DOM except btn-capture
 * @test manual — click Capture, verify preview fields; test Pick mode for each field
 */

import { showStatus } from './popup-utils.js';

// ── Pick mode helpers ──────────────────────────────────────────────────────

export function checkAndClearPickResult() {
  return new Promise(resolve => {
    chrome.storage.local.get(['pick_result', 'pick_pending'], result => {
      const pickResult  = result.pick_result ?? null;
      const pickPending = result.pick_pending ?? null;
      if (pickResult) {
        chrome.storage.local.remove(['pick_result', 'pick_pending'], () => resolve({ pickResult, pickPending }));
      } else {
        resolve(null);
      }
    });
  });
}

export function sendPickMode(itemId, field) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]) return;
    chrome.storage.local.set({ pick_pending: { itemId, field } }, () => {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'PICK_MODE', field }, () => {
        if (chrome.runtime.lastError) {
          chrome.storage.local.remove('pick_pending');
        }
      });
    });
  });
}

// ── Capture current tab ────────────────────────────────────────────────────

// WHY: onPreview callback injection — showPreview mutates popup.js module state
// (_pendingItem, setState); direct import would create circular dependency.
export function captureCurrentTab(onPreview) {
  const btn = document.getElementById('btn-capture');
  btn.disabled    = true;
  btn.textContent = 'Capturing…';
  btn.classList.add('capturing');

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab) {
      showStatus('No active tab found.', true);
      btn.disabled    = false;
      // WHY: 'Capture' is permanent — extension popup always operates on the current tab;
      //      long label was causing toolbar overflow at system font > 13px
      btn.textContent = 'Capture';
      btn.classList.remove('capturing');
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_PAGE' }, response => {
      if (chrome.runtime.lastError || !response) {
        showStatus(
          chrome.runtime.lastError?.message || 'Content script not ready. Reload the page.',
          true
        );
        btn.disabled    = false;
        btn.textContent = 'Capture';
        btn.classList.remove('capturing');
        return;
      }

      if (!response.ok) {
        showStatus(`Capture failed: ${response.error ?? 'unknown error'}`, true);
        btn.disabled    = false;
        btn.textContent = 'Capture';
        btn.classList.remove('capturing');
        return;
      }

      const item = response.item;

      // Hash computed in background.js (secure context — works on HTTP too)
      chrome.runtime.sendMessage({ type: 'HASH_CONTENT', text: item.content || '' }, hashResponse => {
        item.content_hash = hashResponse?.hash ?? null;
        btn.disabled      = false;
        btn.textContent   = 'Capture';
        btn.classList.remove('capturing');
        onPreview(item); // WHY: callback — showPreview is popup.js state mutator; avoid circular import
      });
    });
  });
}
