import React, { useContext } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { QbitBroadcastFailure, ToSignData } from '@qbit/wallet-shared';
import { NavigationContext, NavigationContextType } from '@qbit/wallet-state';
import { NavigationProvider } from './NavigationProvider';

vi.mock('@qbit/wallet-state', async () => {
  const React = await import('react');

  return {
    NavigationContext: React.createContext(null),
    useChain: () => ({ websiteUrl: 'https://example.org' })
  };
});

vi.mock('../pages/MainRoute', () => ({
  routes: {
    UnlockScreen: { path: '/account/unlock' },
    MainScreen: { path: '/main' },
    TxConfirmScreen: { path: '/wallet/tx/confirm' },
    TxFailScreen: { path: '/wallet/tx/fail' }
  }
}));

vi.mock('../web/tabs', () => ({
  openExtensionInTab: vi.fn()
}));

vi.mock('@qbit/wallet-shared', () => ({
  getExplorerUrl: vi.fn()
}));

function LockTrigger() {
  const nav = useContext(NavigationContext) as unknown as NavigationContextType;
  return (
    <button
      data-testid="trigger-lock"
      onClick={() =>
        nav.navToLock({
          autoUnlockByFace: false
        })
      }
    />
  );
}

const toSignData = { psbtHex: '70736274ff00', toSignInputs: [] } as unknown as ToSignData;
const failure: QbitBroadcastFailure = { success: false, outcome: 'unknown', reason: 'network' };

function SendFlowProbe() {
  const nav = useContext(NavigationContext) as unknown as NavigationContextType;
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <div>
      <span data-testid="pathname">{location.pathname}</span>
      <span data-testid="navigation-type">{navigationType}</span>
      <span data-testid="state">{JSON.stringify(location.state ?? null)}</span>
      <button data-testid="push-confirm" onClick={() => nav.navigate('TxConfirmScreen', { toSignData })} />
      <button data-testid="replace-fail" onClick={() => nav.replace('TxFailScreen', { result: failure })} />
      <button data-testid="replace-main" onClick={() => nav.replace('MainScreen')} />
      <button data-testid="back" onClick={() => nav.goBack()} />
    </div>
  );
}

describe('NavigationProvider', () => {
  afterEach(() => {
    cleanup();
  });

  it('replace swaps the current history entry instead of pushing a new one', () => {
    render(
      <MemoryRouter initialEntries={['/main']}>
        <NavigationProvider>
          <Routes>
            <Route path="*" element={<SendFlowProbe />} />
          </Routes>
        </NavigationProvider>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTestId('push-confirm'));
    expect(screen.getByTestId('pathname').textContent).toBe('/wallet/tx/confirm');
    expect(screen.getByTestId('navigation-type').textContent).toBe('PUSH');

    fireEvent.click(screen.getByTestId('replace-fail'));
    expect(screen.getByTestId('pathname').textContent).toBe('/wallet/tx/fail');
    expect(screen.getByTestId('navigation-type').textContent).toBe('REPLACE');
    expect(screen.getByTestId('state').textContent).toBe(JSON.stringify({ result: failure }));

    fireEvent.click(screen.getByTestId('replace-main'));
    expect(screen.getByTestId('pathname').textContent).toBe('/main');
    expect(screen.getByTestId('navigation-type').textContent).toBe('REPLACE');
    expect(screen.getByTestId('state').textContent).toBe('null');
  });

  it('navigate still pushes by default', () => {
    render(
      <MemoryRouter initialEntries={['/main']}>
        <NavigationProvider>
          <Routes>
            <Route path="*" element={<SendFlowProbe />} />
          </Routes>
        </NavigationProvider>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTestId('push-confirm'));
    fireEvent.click(screen.getByTestId('push-confirm'));
    expect(screen.getByTestId('navigation-type').textContent).toBe('PUSH');
  });

  it('navToLock routes to the unlock screen', () => {
    render(
      <MemoryRouter initialEntries={['/main']}>
        <NavigationProvider>
          <Routes>
            <Route path="/main" element={<LockTrigger />} />
            <Route path="/account/unlock" element={<div data-testid="unlock-screen" />} />
          </Routes>
        </NavigationProvider>
      </MemoryRouter>
    );

    expect(screen.queryByTestId('unlock-screen')).toBeNull();

    fireEvent.click(screen.getByTestId('trigger-lock'));

    expect(screen.getByTestId('unlock-screen')).toBeTruthy();
  });
});
