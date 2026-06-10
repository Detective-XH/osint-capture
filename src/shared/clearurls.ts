/**
 * @module shared/clearurls
 * Shared ClearURLs tracking-parameter stripping — single source of truth for the loader +
 * cleaner that was previously copied (with cosmetic drift) into background.ts and content.ts.
 * Operates on src/lib/data.min.json (LGPL-3.0 ClearURLs data, loaded at runtime).
 */

export interface ClearUrlsProvider {
  urlPattern: string;
  rules?: string[];
  exceptions?: string[];
  rawRules?: string[];
}

export async function loadCleanRules(): Promise<Record<string, ClearUrlsProvider>> {
  const url = chrome.runtime.getURL('lib/data.min.json');
  const res = await fetch(url);
  const data = await res.json();
  return data.providers; // { amazon: { urlPattern, rules, exceptions, ... }, ... }
}

export function cleanUrl(rawUrl: string, providers: Record<string, ClearUrlsProvider>): string {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return rawUrl; }

  for (const provider of Object.values(providers)) {
    // Check urlPattern match
    try {
      if (!new RegExp(provider.urlPattern, 'i').test(rawUrl)) continue;
    } catch { continue; }

    // Check exceptions — skip provider if any match
    const exceptions = provider.exceptions ?? [];
    if (exceptions.some((ex: string) => { try { return new RegExp(ex, 'i').test(rawUrl); } catch { return false; } })) continue;

    // Strip tracking query params matching any rule pattern
    const rules = provider.rules ?? [];
    for (const rule of rules) {
      let ruleRe;
      try { ruleRe = new RegExp('^(?:' + rule + ')$', 'i'); } catch { continue; }
      for (const key of [...parsed.searchParams.keys()]) {
        if (ruleRe.test(key)) parsed.searchParams.delete(key);
      }
    }

    // Apply rawRules (path-level stripping)
    for (const raw of (provider.rawRules ?? [])) {
      try {
        parsed.pathname = parsed.pathname.replace(new RegExp(raw, 'i'), '');
      } catch { /* skip */ }
    }
  }

  return parsed.toString();
}
