import { beforeEach, describe, expect, it, vi } from 'vitest';

const modules = vi.hoisted(() => ({
  allowLinksWithinProceededPage: vi.fn(),
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
    vi.clearAllMocks();
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
});
