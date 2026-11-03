import { afterEach, describe, expect, it, vi } from 'vitest';

import { ANNOUNCE_PROVIDER_EVENT, PROVIDER_INITIALIZED_EVENT } from './providerAnnouncement';

vi.mock('./qbitProvider', () => ({
  // The real provider connects its transport, which a test page has none of.
  QbitProvider: class QbitProvider {}
}));

type PageWindow = Window & { qbit?: unknown };

/** A fresh page, since window.qbit cannot be removed once it is installed. */
function createPage(): PageWindow {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  return frame.contentWindow as PageWindow;
}

async function runPageProvider(page: PageWindow) {
  const seen: Array<{ type: string; installed: unknown }> = [];
  for (const type of [PROVIDER_INITIALIZED_EVENT, ANNOUNCE_PROVIDER_EVENT]) {
    page.addEventListener(type, () => seen.push({ type, installed: page.qbit }));
  }
  vi.stubGlobal('window', page);
  vi.resetModules();
  await import('./index');
  return seen;
}

describe('page provider entry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('dispatches qbit#initialized once, after window.qbit is installed', async () => {
    const page = createPage();

    const seen = await runPageProvider(page);

    expect(page.qbit).toBeDefined();
    expect(seen).toEqual([
      { type: PROVIDER_INITIALIZED_EVENT, installed: page.qbit },
      { type: ANNOUNCE_PROVIDER_EVENT, installed: page.qbit }
    ]);
  });

  it('dispatches nothing when a page has locked window.qbit', async () => {
    const page = createPage();
    const spoof = { requestAccounts: () => ['spoofed'] };
    Object.defineProperty(page, 'qbit', { value: spoof, configurable: false });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const seen = await runPageProvider(page);

    expect(seen).toEqual([]);
    expect(page.qbit).toBe(spoof);
    expect(error).toHaveBeenCalledWith('Qbit provider injection failed.', expect.any(Error));
  });

  it.each([
    [
      'dispatchEvent',
      (page: PageWindow) => {
        page.dispatchEvent = () => {
          throw new Error('replaced');
        };
      }
    ],
    [
      'CustomEvent',
      () =>
        vi.stubGlobal(
          'CustomEvent',
          class {
            constructor() {
              throw new Error('replaced');
            }
          }
        )
    ],
    ['crypto', () => vi.stubGlobal('crypto', {})]
  ])('keeps window.qbit and says only the announcement failed when a page replaced %s', async (_name, replace) => {
    const page = createPage();
    replace(page);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runPageProvider(page);

    expect(page.qbit).toBeDefined();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('Qbit provider is installed, but announcing it failed.', expect.any(Error));
  });
});
