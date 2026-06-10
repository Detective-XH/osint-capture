/**
 * @module popup-settings
 * @responsibility Settings panel load/save (operator name, download subfolder, CSV delimiter), inline operator name edit, keyboard accessibility (Enter/Space) for operator name inline edit
 * @owns chrome.storage read/write for operator_name, download_subfolder, csv_delimiter settings; inline edit DOM wiring
 * @not-owns State machine; inbox rendering; capture flow
 * @depends-on chrome.storage.local (operator_name, download_subfolder, csv_delimiter)
 * @depended-by popup.js (init wiring)
 * @context popup — runs in extension popup
 * @test manual — open settings, change operator name + subfolder + delimiter, save, verify persisted
 */

import type { Settings } from '../types';

// ── Settings state ─────────────────────────────────────────────────────────

// WHY: setState callback injection — setState is popup.js FSM; direct import would create circular dependency
export async function openSettings(setState: (state: string) => void): Promise<void> {
  const result = await new Promise<Partial<Settings>>((resolve) =>
    chrome.storage.local.get(
      ['operator_name', 'download_subfolder', 'csv_delimiter'],
      resolve as (items: { [key: string]: unknown }) => void,
    ),
  );
  (document.getElementById('set-operator') as HTMLInputElement).value = result.operator_name || '';
  (document.getElementById('set-subfolder') as HTMLInputElement).value =
    result.download_subfolder || '';
  (document.getElementById('set-csv-delimiter') as HTMLSelectElement).value =
    result.csv_delimiter || 'comma';
  setState('SETTINGS'); // WHY: callback — setState owned by popup.js
}

// WHY: setState + renderInbox callback injection — both are popup.js-owned; passing as parameters avoids circular import
export async function saveSettings(
  setState: (state: string) => void,
  renderInbox: () => void,
): Promise<void> {
  const name = (document.getElementById('set-operator') as HTMLInputElement).value.trim();
  await new Promise<void>((resolve) =>
    chrome.storage.local.set(
      {
        operator_name: name || 'unknown',
        download_subfolder:
          (document.getElementById('set-subfolder') as HTMLInputElement).value.trim() ||
          'osint-captures',
        csv_delimiter: (document.getElementById('set-csv-delimiter') as HTMLSelectElement).value,
      },
      resolve,
    ),
  );
  (document.getElementById('operator-name-display') as HTMLElement).textContent = name || 'unknown';
  setState('INBOX'); // WHY: callback — setState owned by popup.js
  renderInbox(); // WHY: callback — renderInbox + its _currentItems/_selectedId args owned by popup.js
}

// ── Operator name inline edit ──────────────────────────────────────────────

export function setupOperatorInlineEdit(): void {
  const display = document.getElementById('operator-name-display')!;

  // WHY: keyboard accessibility — Enter/Space trigger edit (same as click) per ARIA button pattern
  display.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      display.click();
    }
  });

  display.addEventListener('click', () => {
    const current = display.textContent;
    const input = document.createElement('input');
    input.value = current;
    input.style.width = Math.max(80, current.length * 8) + 'px';
    display.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      const val = input.value.trim() || current;
      await new Promise<void>((resolve) =>
        chrome.storage.local.set({ operator_name: val }, resolve),
      );
      const newDisplay = document.createElement('span');
      newDisplay.id = 'operator-name-display';
      newDisplay.title = 'Click to edit';
      newDisplay.tabIndex = 0;
      newDisplay.setAttribute('role', 'button');
      newDisplay.setAttribute('aria-label', 'Edit operator name');
      newDisplay.textContent = val;
      input.replaceWith(newDisplay);
      setupOperatorInlineEdit(); // re-wire
    };

    const cancel = () => {
      const newDisplay = document.createElement('span');
      newDisplay.id = 'operator-name-display';
      newDisplay.title = 'Click to edit';
      newDisplay.tabIndex = 0;
      newDisplay.setAttribute('role', 'button');
      newDisplay.setAttribute('aria-label', 'Edit operator name');
      newDisplay.textContent = current;
      input.replaceWith(newDisplay);
      setupOperatorInlineEdit();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        input.removeEventListener('blur', commit);
        cancel();
      }
    });
  });
}
