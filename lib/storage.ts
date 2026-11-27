import { DEFAULT_MAPPINGS, normalizeOrigin, sameMapping } from './origin';
import type { IssuerMapping } from './types';

export const MAPPINGS_KEY = 'issuer-mappings.v1';

export async function getCustomMappings(): Promise<IssuerMapping[]> {
  const data = await chrome.storage.local.get<{ [MAPPINGS_KEY]?: IssuerMapping[] }>(MAPPINGS_KEY);
  return data[MAPPINGS_KEY] ?? [];
}

export async function getMappings(): Promise<IssuerMapping[]> {
  return [...DEFAULT_MAPPINGS, ...await getCustomMappings()];
}

let writes: Promise<unknown> = Promise.resolve();

export function changeMapping(mapping?: IssuerMapping, previous?: IssuerMapping): Promise<IssuerMapping[]> {
  const write = writes.then(async () => {
    const current = await getCustomMappings();
    const next = previous ? current.filter((item) => !sameMapping(item, previous)) : current;
    if (mapping) {
      const issuer = mapping.issuer.trim();
      if (!issuer || issuer.length > 64) throw new Error('Enter an issuer of up to 64 characters.');
      const entry = { issuer, origin: normalizeOrigin(mapping.origin.trim()) };
      if (![...DEFAULT_MAPPINGS, ...next].some((item) => sameMapping(item, entry))) next.push(entry);
    }
    await chrome.storage.local.set({ [MAPPINGS_KEY]: next });
    return next;
  });
  writes = write.catch(() => undefined);
  return write;
}

export async function canShowHelper(origin: string): Promise<boolean> {
  return (await getMappings()).some((mapping) => mapping.origin === origin);
}
