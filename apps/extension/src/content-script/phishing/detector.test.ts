import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkPhishing, initializePhishingDetection } from './detector';

type Reply = (response?: unknown) => void;

function stubRuntime(
  respond: (message: { type: string }) => unknown,
  lastError?: { message: string } | (() => { message: string } | undefined)
) {
  const sendMessage = vi.fn((message: { type: string }, callback?: Reply) => {
    runtime.lastError = typeof lastError === 'function' ? lastError() : lastError;
    callback?.(respond(message));
    runtime.lastError = undefined;
  });
  const runtime: { id: string; lastError?: { message: string }; sendMessage: typeof sendMessage } = {
    id: 'qbit',
    sendMessage
  };
  vi.stubGlobal('chrome', { runtime });
  return sendMessage;
}

describe('content-script phishing check', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/claim?ref=1');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a clear page without asking for the warning page', async () => {
    const sendMessage = stubRuntime(() => ({ isPhishing: false, isDenylisted: false }));

    await expect(checkPhishing()).resolves.toBe('clear');
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      type: 'CHECK_PHISHING',
      hostname: window.location.hostname
    });
  });

  it('asks for the warning page with the full URL of a denylisted page', async () => {
    const sendMessage = stubRuntime((message) =>
      message.type === 'CHECK_PHISHING' ? { isPhishing: true, isDenylisted: true } : { success: true }
    );

    await expect(checkPhishing()).resolves.toBe('phishing');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[0]).toEqual({
      type: 'REDIRECT_TO_PHISHING_PAGE',
      hostname: window.location.hostname,
      url: window.location.href
    });
    expect(window.location.href).toMatch(/\/claim\?ref=1$/);
  });

  it('keeps a page the user proceeded to apart from a clear page', async () => {
    const sendMessage = stubRuntime(() => ({ isPhishing: false, isDenylisted: true }));

    await expect(checkPhishing()).resolves.toBe('proceeded');
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ['a messaging error', () => ({ isPhishing: false, isDenylisted: false }), { message: 'Receiving end does not exist.' }],
    ['a reply without the denylist field', () => ({ isPhishing: false }), undefined],
    ['no response', () => undefined, undefined],
    ['an error response', () => ({ error: 'Internal error processing request' }), undefined]
  ])('reports an unknown verdict on %s', async (_label, respond, lastError) => {
    const sendMessage = stubRuntime(respond, lastError);

    await expect(checkPhishing()).resolves.toBe('unknown');
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('retries an unknown verdict once at page start', async () => {
    let failures = 1;
    const sendMessage = stubRuntime(
      () => ({ isPhishing: false, isDenylisted: false }),
      () => (failures-- > 0 ? { message: 'Receiving end does not exist.' } : undefined)
    );

    await expect(initializePhishingDetection()).resolves.toBe('clear');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('stops after one retry', async () => {
    const sendMessage = stubRuntime(() => undefined);

    await expect(initializePhishingDetection()).resolves.toBe('unknown');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('reports an unknown verdict once the extension context is gone', async () => {
    vi.stubGlobal('chrome', { runtime: { id: undefined, sendMessage: vi.fn() } });

    await expect(checkPhishing()).resolves.toBe('unknown');
  });
});
