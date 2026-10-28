import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import PhishingScreen from './PhishingScreen';

vi.mock('@qbit/wallet-state', () => ({
  useI18n: () => ({ t: (key: string) => key })
}));

function renderWarning(
  reply: unknown,
  route = `/phishing?hostname=phish.example&href=${encodeURIComponent('https://phish.example/claim')}`
) {
  const sendMessage = vi.fn((_message: unknown, callback: (response?: unknown) => void) => callback(reply));
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://qbit${path}`, lastError: undefined, sendMessage }
  });
  render(
    <MemoryRouter initialEntries={[route]}>
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

  it('offers no Proceed when the warning names no site', () => {
    const sendMessage = renderWarning({ success: true }, '/phishing');

    expect(screen.getByText('danger_potential_phishing_website_detected')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(['a_b.phish.example', '-x.phish.example', 'x-.phish.example', 'phish.example:8443', 'phïsh.example'])(
    'offers no Proceed for %s, which the background cannot lift, and says why',
    (hostname) => {
      const sendMessage = renderWarning(
        { error: 'Invalid hostname parameter' },
        `/phishing?hostname=${encodeURIComponent(hostname)}&href=${encodeURIComponent(`https://${hostname}/claim`)}`
      );

      expect(screen.getByText(hostname)).toBeTruthy();
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.getByText('continue_to_unavailable_hostname')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(sendMessage).not.toHaveBeenCalled();
    }
  );

  it.each(['phish.example', 'WWW.Phish.Example.'])(
    'offers Proceed for %s, which the background can lift',
    (hostname) => {
      renderWarning({ success: true }, `/phishing?hostname=${encodeURIComponent(hostname)}`);

      expect(screen.getByRole('button', { name: new RegExp(hostname.replace(/\./g, '\\.')) })).toBeTruthy();
      expect(screen.queryByText('continue_to_unavailable_hostname')).toBeNull();
    }
  );

  it('does not say a site cannot be opened when the warning names none', () => {
    renderWarning({ success: true }, '/phishing');

    expect(screen.queryByText('continue_to_unavailable_hostname')).toBeNull();
  });

  it('does not report a failure once the block is lifted', async () => {
    const sendMessage = renderWarning({ success: true });

    fireEvent.click(screen.getByRole('button', { name: /phish\.example/ }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
