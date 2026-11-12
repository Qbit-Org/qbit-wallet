import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate as useRouterNavigate,
  useNavigationType
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, render, screen } from '@testing-library/react';

import { routes, useNavigate, type RouteTypes } from './MainRoute';

// Only the hook is under test: every screen and provider MainRoute imports is
// a stub, so loading it does not load the whole wallet app.
vi.mock('../components', () => ({ Content: () => null, Icon: () => null }));
vi.mock('../components/ErrorBoundary', () => ({ ErrorBoundary: () => null }));
vi.mock('../components/PageStartup', () => ({ PageStartup: () => null }));
vi.mock('../providers/ApprovalProvider', () => ({ ApprovalProvider: () => null }));
vi.mock('../providers/NavigationProvider', () => ({ NavigationProvider: () => null }));
vi.mock('@qbit/wallet-state', () => ({}));
vi.mock('./Account/AddKeyringScreen', () => ({ default: () => null }));
vi.mock('./Account/CreateAccountScreen', () => ({ default: () => null }));
vi.mock('./Account/CreateHDWalletScreen', () => ({ default: () => null }));
vi.mock('./Account/CreatePasswordScreen', () => ({ default: () => null }));
vi.mock('./Account/CreateReadonlyWalletScreen', () => ({ default: () => null }));
vi.mock('./Account/CreateWatchWalletScreen', () => ({ default: () => null }));
vi.mock('./Account/UnlockScreen', () => ({ default: () => null }));
vi.mock('./Approval/ApprovalScreen', () => ({ default: () => null }));
vi.mock('./Approval/ConnectedSitesScreen', () => ({ default: () => null }));
vi.mock('./Main/BoostScreen', () => ({ default: () => null }));
vi.mock('./Main/DiscoverTabScreen', () => ({ default: () => null }));
vi.mock('./Main/MineTabScreen', () => ({ default: () => null }));
vi.mock('./Main/SettingsTabScreen', () => ({ default: () => null }));
vi.mock('./Main/WalletTabScreen', () => ({ default: () => null }));
vi.mock('./Main/WelcomeScreen', () => ({ default: () => null }));
vi.mock('./Phishing/PhishingScreen', () => ({ default: () => null }));
vi.mock('./Settings/AboutUsScreen', () => ({ default: () => null }));
vi.mock('./Settings/AddressTypeScreen', () => ({ default: () => null }));
vi.mock('./Settings/AdvancedScreen', () => ({ default: () => null }));
vi.mock('./Settings/AdvancedScreen/LockTimePage', () => ({ LockTimePage: () => null }));
vi.mock('./Settings/AdvancedScreen/RegtestAccessScreen', () => ({ RegtestAccessScreen: () => null }));
vi.mock('./Settings/ChangePasswordScreen', () => ({ default: () => null }));
vi.mock('./Settings/SecurityScreen', () => ({ default: () => null }));
vi.mock('./Settings/ContactsScreen', () => ({ default: () => null }));
vi.mock('./Settings/EditContactScreen', () => ({ default: () => null }));
vi.mock('./Settings/ExportMnemonicsScreen', () => ({ default: () => null }));
vi.mock('./Settings/ExportPrivateKeyScreen', () => ({ default: () => null }));
vi.mock('./Settings/AppearanceScreen', () => ({ default: () => null }));
vi.mock('./Settings/BiometricUnlockScreen', () => ({ default: () => null }));
vi.mock('./Settings/LanguageScreen', () => ({ default: () => null }));
vi.mock('./Settings/NetworkTypeScreen', () => ({ default: () => null }));
vi.mock('./Settings/UpgradeNoticeScreen', () => ({ default: () => null }));
vi.mock('./Test/TestScreen', () => ({ default: () => null }));
vi.mock('./Wallet/HistoryScreen', () => ({ default: () => null }));
vi.mock('./Wallet/QbitConsolidationScreen', () => ({ default: () => null }));
vi.mock('./Wallet/QbitRecoveryMigrationScreen', () => ({ default: () => null }));
vi.mock('./Wallet/ReceiveScreen', () => ({ default: () => null }));
vi.mock('./Wallet/TxConfirmScreen', () => ({ default: () => null }));
vi.mock('./Wallet/TxCreateScreen', () => ({ default: () => null }));
vi.mock('./Wallet/TxFailScreen', () => ({ default: () => null }));
vi.mock('./Wallet/TxSuccessScreen', () => ({ default: () => null }));

type Navigate = ReturnType<typeof useNavigate>;

// No route in the table builds its path yet; one is added for these tests.
const DYNAMIC_ROUTE = 'DynamicPathTestScreen' as RouteTypes;
const routeTable = routes as unknown as Record<string, unknown>;

/** Shows where the router is, how it got there, and exposes the hook. */
function Probe({ onNavigate }: { onNavigate: (navigate: Navigate, back: () => void) => void }) {
  const navigate = useNavigate();
  const routerNavigate = useRouterNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  onNavigate(navigate, () => routerNavigate(-1));
  return (
    <div>
      <span data-testid="pathname">{location.pathname}</span>
      <span data-testid="navigation-type">{navigationType}</span>
      <span data-testid="state">{JSON.stringify(location.state ?? null)}</span>
    </div>
  );
}

/**
 * Starts on `/current` with `/before` behind it. A push keeps `/current` one
 * step back; a replace takes its place, so one step back is `/before`.
 */
function renderAtCurrent() {
  let navigate!: Navigate;
  let back!: () => void;
  render(
    <MemoryRouter initialEntries={['/before', '/current']} initialIndex={1}>
      <Routes>
        <Route
          path="*"
          element={
            <Probe
              onNavigate={(hookNavigate, routerBack) => {
                navigate = hookNavigate;
                back = routerBack;
              }}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
  return {
    navigate: (...args: Parameters<Navigate>) => act(() => navigate(...args)),
    back: () => act(() => back())
  };
}

const shown = () => ({
  pathname: screen.getByTestId('pathname').textContent,
  navigationType: screen.getByTestId('navigation-type').textContent,
  state: JSON.parse(screen.getByTestId('state').textContent ?? 'null')
});

describe('useNavigate from MainRoute', () => {
  beforeEach(() => {
    routeTable[DYNAMIC_ROUTE] = {
      path: '/dynamic/:id',
      getDynamicPath: ({ id }: { id: string }) => `/dynamic/${id}`,
      element: null
    };
  });

  afterEach(() => {
    delete routeTable[DYNAMIC_ROUTE];
    vi.restoreAllMocks();
    cleanup();
  });

  it.each([
    ['no options', undefined],
    ['empty options', {}],
    ['replace: false', { replace: false }]
  ])('still pushes a static route with %s', (_label, options) => {
    const { navigate, back } = renderAtCurrent();

    navigate('SettingsTabScreen', { from: 'test' }, undefined, options);

    expect(shown()).toEqual({ pathname: '/settings', navigationType: 'PUSH', state: { from: 'test' } });
    back();
    expect(shown().pathname).toBe('/current');
  });

  it('replaces the current entry with a static route when asked', () => {
    const { navigate, back } = renderAtCurrent();

    navigate('SettingsTabScreen', { from: 'test' }, undefined, { replace: true });

    expect(shown()).toEqual({ pathname: '/settings', navigationType: 'REPLACE', state: { from: 'test' } });
    back();
    expect(shown().pathname).toBe('/before');
  });

  it('still pushes a dynamic-path route by default', () => {
    const { navigate, back } = renderAtCurrent();

    navigate(DYNAMIC_ROUTE, { from: 'test' }, { id: '7' });

    expect(shown()).toEqual({ pathname: '/dynamic/7', navigationType: 'PUSH', state: { from: 'test' } });
    back();
    expect(shown().pathname).toBe('/current');
  });

  it('replaces the current entry with a dynamic-path route when asked', () => {
    const { navigate, back } = renderAtCurrent();

    navigate(DYNAMIC_ROUTE, { from: 'test' }, { id: '7' }, { replace: true });

    expect(shown()).toEqual({ pathname: '/dynamic/7', navigationType: 'REPLACE', state: { from: 'test' } });
    back();
    expect(shown().pathname).toBe('/before');
  });

  it.each([
    ['no options', undefined],
    ['replace: true', { replace: true }]
  ])('steps back through the window history for #back with %s', (_label, options) => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const { navigate } = renderAtCurrent();

    navigate('#back', undefined, undefined, options);

    expect(historyBack).toHaveBeenCalledOnce();
    expect(shown()).toEqual({ pathname: '/current', navigationType: 'POP', state: null });
  });
});
