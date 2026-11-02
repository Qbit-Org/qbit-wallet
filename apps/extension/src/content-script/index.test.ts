import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const modules = vi.hoisted(() => ({
  allowLinksWithinProceededPage: vi.fn(),
  holdDenylistedPage: vi.fn(),
  initializePhishingDetection: vi.fn(),
  initializeScriptInjection: vi.fn(),
  setupNavigationListeners: vi.fn(),
  setupPhishingListeners: vi.fn()
}));

vi.mock('./injection/scriptInjector', () => ({
  initializeScriptInjection: modules.initializeScriptInjection
}));
vi.mock('./phishing/detector', () => ({
  initializePhishingDetection: modules.initializePhishingDetection,
  setupPhishingListeners: modules.setupPhishingListeners
}));
vi.mock('./phishing/hold', () => ({
  holdDenylistedPage: modules.holdDenylistedPage
}));
vi.mock('./phishing/navigation', () => ({
  allowLinksWithinProceededPage: modules.allowLinksWithinProceededPage,
  setupNavigationListeners: modules.setupNavigationListeners
}));

async function runContentScript(verdict: string) {
  modules.initializePhishingDetection.mockResolvedValue(verdict);
  vi.resetModules();
  await import('./index');
  await vi.waitFor(() => expect(modules.setupPhishingListeners).toHaveBeenCalled());
}

describe('content-script entry', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('injects the provider after a clear verdict', async () => {
    await runContentScript('clear');

    expect(modules.initializeScriptInjection).toHaveBeenCalledOnce();
    expect(modules.setupPhishingListeners).toHaveBeenCalledOnce();
  });

  it('watches link clicks before the first check answers', async () => {
    modules.initializePhishingDetection.mockReturnValue(new Promise(() => undefined));
    vi.resetModules();
    await import('./index');

    expect(modules.setupNavigationListeners).toHaveBeenCalledOnce();
    expect(modules.initializeScriptInjection).not.toHaveBeenCalled();
  });

  it.each(['phishing', 'proceeded', 'unknown'])('does not inject the provider after a %s verdict', async (verdict) => {
    await runContentScript(verdict);

    expect(modules.initializeScriptInjection).not.toHaveBeenCalled();
    expect(modules.setupPhishingListeners).toHaveBeenCalledOnce();
  });

  it.each([
    ['proceeded', true],
    ['clear', false],
    ['phishing', false],
    ['unknown', false]
  ])('after a %s verdict, allows links within the page: %s', async (verdict, allowed) => {
    await runContentScript(verdict);

    expect(modules.allowLinksWithinProceededPage).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it('holds a denylisted page before anything else and leaves the verdict to it', async () => {
    const order: string[] = [];
    const settle = vi.fn();
    modules.holdDenylistedPage.mockImplementation(() => {
      order.push('hold');
      return { settle };
    });
    modules.setupNavigationListeners.mockImplementation(() => order.push('navigation'));
    await runContentScript('clear');

    expect(order).toEqual(['hold', 'navigation']);
    expect(settle).toHaveBeenCalledWith('clear');
    // The page reloads to run, so it gets the provider then.
    expect(modules.initializeScriptInjection).not.toHaveBeenCalled();
  });

  describe('frames', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it('in MV3, guards navigation from the top frame', async () => {
      vi.stubEnv('manifest', 'mv3');
      await runContentScript('clear');

      expect(modules.initializePhishingDetection).toHaveBeenCalledWith(true);
      expect(modules.setupNavigationListeners).toHaveBeenCalledOnce();
    });

    it.each([
      ['a child frame, such as an embedded widget', 'top'],
      ['a fenced frame, which is its own top', 'fence']
    ])('in MV3, only checks the host of %s and gives it the provider when clear', async (_label, global) => {
      vi.stubEnv('manifest', 'mv3');
      vi.stubGlobal(global, {});
      modules.initializePhishingDetection.mockResolvedValue('clear');
      vi.resetModules();
      await import('./index');
      await vi.waitFor(() => expect(modules.initializeScriptInjection).toHaveBeenCalledOnce());

      expect(modules.initializePhishingDetection).toHaveBeenCalledWith(false);
      expect(modules.setupNavigationListeners).not.toHaveBeenCalled();
      expect(modules.setupPhishingListeners).not.toHaveBeenCalled();
    });

    it('in MV2, which has no network rules, guards navigation from a child frame too', async () => {
      vi.stubEnv('manifest', 'mv2');
      vi.stubGlobal('top', {});
      await runContentScript('clear');

      expect(modules.initializePhishingDetection).toHaveBeenCalledWith(true);
      expect(modules.setupNavigationListeners).toHaveBeenCalledOnce();
      expect(modules.initializeScriptInjection).toHaveBeenCalledOnce();
    });
  });
});
