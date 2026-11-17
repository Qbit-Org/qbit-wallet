import type { CSSProperties, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AddressTypeSettingCard } from './AddressTypeSetting';

const harness = vi.hoisted(() => ({}) as { setting: { label: string; value: string; onClick: Mock } });

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    onClick,
    style,
    'data-testid': testId
  }: {
    children?: ReactNode;
    onClick?: () => void;
    style?: CSSProperties;
    'data-testid'?: string;
  }) => React.createElement('div', { onClick, style, 'data-testid': testId }, children);
  return {
    Card: Container,
    Row: Container,
    Icon: ({ icon }: { icon?: string }) => React.createElement('i', { 'data-icon': icon }),
    Text: ({
      text,
      preset,
      color,
      wrap,
      'data-testid': testId
    }: {
      text?: string;
      preset?: string;
      color?: string;
      wrap?: boolean;
      'data-testid'?: string;
    }) =>
      React.createElement(
        'span',
        { 'data-preset': preset, 'data-color': color, 'data-wrap': String(!!wrap), 'data-testid': testId },
        text
      )
  };
});

vi.mock('@qbit/wallet-state', () => ({ useAddressTypeSettingLogic: () => harness.setting }));

const ROW = 'advanced-address-type-row';
const VALUE = 'advanced-address-type-value';

describe('AddressTypeSettingCard', () => {
  beforeEach(() => {
    harness.setting = { label: 'address_type', value: 'Post-Quantum P2MR', onClick: vi.fn() };
  });

  afterEach(cleanup);

  it('shows the label, then the value its logic gives, then the chevron, as the Language row does', () => {
    render(<AddressTypeSettingCard />);

    const row = screen.getByTestId(ROW);
    // In document order: label, value, chevron, and nothing else.
    expect(Array.from(row.querySelectorAll('span, i')).map((part) => part.tagName)).toEqual(['SPAN', 'SPAN', 'I']);
    const [label, value, chevron] = Array.from(row.querySelectorAll<HTMLElement>('span, i'));
    expect(label?.textContent).toBe('address_type');
    expect(label?.getAttribute('data-preset')).toBe('bold');
    expect(value).toBe(screen.getByTestId(VALUE));
    expect(value?.textContent).toBe('Post-Quantum P2MR');
    expect(value?.getAttribute('data-color')).toBe('textDim');
    expect(chevron?.getAttribute('data-icon')).toBe('right');
  });

  it.each([
    // An HD wallet: the name, the HD path and the account index. (String.raw
    // only so that its apostrophes need neither escapes nor double quotes.)
    String.raw`Taproot (P2TR) (m/86'/0'/0'/0/3)`,
    // A private-key wallet, a read-only one, one that cannot change type: the name.
    'Native Segwit (P2WPKH)',
    'Post-Quantum P2MR'
  ])('shows %s as given, whole, wrapping when the line is too short for it', (value) => {
    harness.setting.value = value;
    render(<AddressTypeSettingCard />);

    expect(screen.getByTestId(VALUE).textContent).toBe(value);
    expect(screen.getByTestId(VALUE).getAttribute('data-wrap')).toBe('true');
  });

  it('does what its logic says on a tap anywhere on the row, and nothing by itself', () => {
    render(<AddressTypeSettingCard />);
    expect(harness.setting.onClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(ROW));
    expect(harness.setting.onClick).toHaveBeenCalledTimes(1);

    // The value and the chevron are part of the row.
    fireEvent.click(screen.getByTestId(VALUE));
    expect(harness.setting.onClick).toHaveBeenCalledTimes(2);
  });
});
