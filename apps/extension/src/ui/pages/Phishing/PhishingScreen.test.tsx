import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import PhishingScreen from './PhishingScreen';

vi.mock('@qbit/wallet-state', () => ({
  useI18n: () => ({ t: (key: string) => key })
}));

function renderWarning(reply: unknown) {
  const sendMessage = vi.fn((_message: unknown, callback: (response?: unknown) => void) => callback(reply));
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://qbit${path}`, lastError: undefined, sendMessage }
  });
  render(
    <MemoryRouter
      initialEntries={[`/phishing?hostname=phish.example&href=${encodeURIComponent('https://phish.example/claim')}`]}
    >
      <PhishingScreen />
    </MemoryRouter>
  );
  return sendMessage;
}

describe('PhishingScreen', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('stays on the warning and reports the failure when the block cannot be lifted', async () => {
    const sendMessage = renderWarning({ error: 'quota' });

    fireEvent.click(screen.getByRole('button', { name: /phish\.example/ }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(sendMessage).toHaveBeenCalledWith(
      { type: 'SKIP_PHISHING_PROTECTION', hostname: 'phish.example' },
      expect.any(Function)
    );
  });

  it('does not report a failure once the block is lifted', async () => {
    const sendMessage = renderWarning({ success: true });

    fireEvent.click(screen.getByRole('button', { name: /phish\.example/ }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
