import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import SettingsTabScreen from './index';

interface Row {
  key: string;
  label: string;
  value: string;
  right: boolean;
  icon: string;
  onClick: Mock;
}

const harness = vi.hoisted(() => ({}) as { rows: Record<string, Row> });

// The screen and its row are real; what they draw with and read are stand-ins.
vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    onClick,
    'data-testid': testId
  }: {
    children?: ReactNode;
    onClick?: () => void;
    'data-testid'?: string;
  }) => React.createElement('div', { onClick, 'data-testid': testId }, children);
  return {
    Card: Container,
    Column: Container,
    Content: Container,
    Footer: Container,
    Header: () => null,
    Icon: ({ icon }: { icon?: string }) => React.createElement('i', { 'data-icon': icon }),
    Layout: Container,
    Row: Container,
    Text: ({ text }: { text?: string }) => React.createElement('span', null, text)
  };
});
vi.mock('@/ui/components/BaseView', () => ({ BaseView: () => null }));
vi.mock('@/ui/components/NavTabBar', () => ({ NavTabBar: () => null }));
vi.mock('@/ui/components/SwitchNetworkBar', () => ({ SwitchNetworkBar: () => null }));

vi.mock('@qbit/wallet-state', () => ({
  useChain: () => ({ websiteUrl: 'https://example.invalid' }),
  useI18n: () => ({ t: (key: string) => key }),
  useNavigation: () => ({ navigate: vi.fn(), navToUrl: vi.fn() }),
  useSettingsTabScreenLogic: () => harness.rows,
  useVersionInfo: () => ({ currentVesion: '0.0.0' })
}));

const row = (name: string, label: string, right = true): Row => ({
  key: `settings_${name}`,
  label,
  // A row's value is not shown on this screen.
  value: `value of ${name}`,
  right,
  icon: name,
  onClick: vi.fn()
});

const ORDER = [
  'settings_connectedSites',
  'settings_switchNetwork',
  'settings_addressBook',
  'settings_security',
  'settings_appearance',
  'settings_advanced',
  'settings_lockwallet',
  'settings_aboutus'
];

const listed = () =>
  Array.from(document.querySelectorAll('[data-testid^="settings_"]')).map((element) =>
    element.getAttribute('data-testid')
  );

describe('SettingsTabScreen', () => {
  beforeEach(() => {
    harness.rows = {
      settings_connectedSites: row('connectedSites', 'connected_sites'),
      settings_switchNetwork: row('switchNetwork', 'switch_network'),
      settings_addressBook: row('addressBook', 'address_book'),
      settings_security: row('security', 'security'),
      settings_appearance: row('appearance', 'appearance'),
      settings_advanced: row('advanced', 'advanced_settings'),
      settings_aboutus: row('aboutus', 'about_qbit_wallet'),
      settings_lockwallet: row('lockwallet', 'lock_wallet', false)
    };
  });

  afterEach(cleanup);

  it('lists Connected Sites, Network, Address Book, Security, Appearance, Advanced Settings, Lock and About, in that order', () => {
    render(<SettingsTabScreen />);

    expect(listed()).toEqual(ORDER);
    expect(ORDER.map((id) => screen.getByTestId(id).textContent)).toEqual([
      'connected_sites',
      'switch_network',
      'address_book',
      'security',
      'appearance',
      'advanced_settings',
      'lock_wallet',
      'about_qbit_wallet'
    ]);
  });

  // Address Type is an entry of Advanced Settings.
  it('lists no Address Type row, not even one its logic would hand it', () => {
    harness.rows = { ...harness.rows, settings_addressType: row('addressType', 'address_type') };
    render(<SettingsTabScreen />);

    expect(listed()).toEqual(ORDER);
    expect(screen.queryByTestId('settings_addressType')).toBeNull();
    expect(screen.queryByText('address_type')).toBeNull();
  });

  it('does what each row says on a tap', () => {
    render(<SettingsTabScreen />);

    for (const id of ORDER) {
      fireEvent.click(screen.getByTestId(id));
      expect(harness.rows[id]?.onClick, id).toHaveBeenCalledTimes(1);
    }
  });

  it('ends every row that opens a screen with the chevron, and Lock without one', () => {
    render(<SettingsTabScreen />);

    for (const id of ORDER) {
      const chevron = screen.getByTestId(id).querySelector('[data-icon="right"]');
      if (id === 'settings_lockwallet') expect(chevron, id).toBeNull();
      else expect(chevron, id).not.toBeNull();
    }
  });
});
