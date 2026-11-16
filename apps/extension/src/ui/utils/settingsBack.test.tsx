import { HashRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { type SettingsParentPath, useBackToSettingsParent } from './settingsBack';

// A real router over the window's history, as the wallet's pages have: the
// helper reads the history index react-router keeps there.
function Opened({ parent }: { parent: SettingsParentPath }) {
  const back = useBackToSettingsParent(parent);
  return <button onClick={back}>back</button>;
}

function Parent({ opens }: { opens: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(opens)}>open</button>;
}

function Where() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderAt(route: string) {
  // No router state yet, as in a window that loads this route first.
  window.history.replaceState(null, '', `#${route}`);
  return render(
    <HashRouter>
      <Where />
      <Routes>
        <Route path="/settings" element={<span>settings</span>} />
        <Route path="/settings/security" element={<Parent opens="/settings/lock-time" />} />
        <Route path="/settings/advanced" element={<Parent opens="/settings/address-type" />} />
        <Route path="/settings/biometric" element={<Opened parent="/settings/security" />} />
        <Route path="/settings/lock-time" element={<Opened parent="/settings/security" />} />
        <Route path="/settings/address-type" element={<Opened parent="/settings/advanced" />} />
      </Routes>
    </HashRouter>
  );
}

const path = () => screen.getByTestId('path').textContent;
const historyIndex = () => (window.history.state as { idx?: number } | null)?.idx;

async function historyBack() {
  await act(async () => {
    const stepped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    window.history.back();
    await stepped;
  });
}

describe('useBackToSettingsParent', () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '#/');
  });

  it.each([
    ['/settings/biometric', '/settings/security'],
    ['/settings/lock-time', '/settings/security'],
    ['/settings/address-type', '/settings/advanced']
  ])('rebuilds Settings and the parent behind %s when nothing is behind it', async (route, parent) => {
    renderAt(route);
    expect(path()).toBe(route);
    expect(historyIndex()).toBe(0);

    fireEvent.click(screen.getByText('back'));

    // On the parent, with one entry behind it.
    await waitFor(() => expect(path()).toBe(parent));
    expect(historyIndex()).toBe(1);

    // That entry is Settings, in the place of the screen that was opened:
    // the parent's Back lands there, not on the screen again.
    await historyBack();
    await waitFor(() => expect(path()).toBe('/settings'));
    expect(historyIndex()).toBe(0);
  });

  it.each([
    ['/settings/security', '/settings/lock-time'],
    ['/settings/advanced', '/settings/address-type']
  ])('goes one step back in history when %s is behind %s', async (parent, route) => {
    renderAt(parent);
    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(path()).toBe(route));
    expect(historyIndex()).toBe(1);

    fireEvent.click(screen.getByText('back'));

    // Back on the entry it came from: nothing was rebuilt or pushed.
    await waitFor(() => expect(path()).toBe(parent));
    expect(historyIndex()).toBe(0);
  });
});
