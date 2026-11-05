import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useApproval } from '@qbit/wallet-state';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import SwitchChain from './SwitchChain';
import SwitchNetwork from './SwitchNetwork';

// Each approval screen settles the approval ApprovalScreen read with its data,
// by that approval's id (#311).

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  const Button = ({ text, onClick, disabled }: { text?: string; onClick?: () => void; disabled?: boolean }) =>
    React.createElement('button', { onClick: disabled ? undefined : onClick, disabled }, text);
  const Text = ({ text }: { text?: string }) => React.createElement('span', null, text);
  return {
    Button,
    Card: Container,
    Column: Container,
    Content: Container,
    Footer: Container,
    Header: Container,
    Icon: Container,
    Image: () => null,
    Layout: Container,
    Row: Container,
    Text
  };
});
vi.mock('@/ui/components/WebsiteBar', () => ({ default: () => null }));
vi.mock('@/shared/constant', () => ({ IMAGE_SOURCE_MAP: {} }));
vi.mock('@qbit/wallet-shared', () => {
  const entry = { icon: 'icon', label: 'label', name: 'name' };
  const anyKey = new Proxy({}, { get: () => entry });
  return { CHAINS_MAP: anyKey, chainForNetwork: () => 'QBIT_TESTNET4' };
});
vi.mock('@qbit/wallet-state', () => ({
  useApproval: vi.fn(),
  useChainType: () => 'QBIT_MAINNET',
  useI18n: () => ({ t: (key: string) => key })
}));

const APPROVAL_ID = 'rendered-approval-id';
const session = { origin: 'https://dapp.test', icon: '', name: 'Dapp' };

describe('approval screens settle the approval they render', () => {
  const approval = {
    getApproval: vi.fn(),
    resolveApproval: vi.fn().mockResolvedValue(true),
    rejectApproval: vi.fn().mockResolvedValue(true)
  };

  beforeEach(() => {
    vi.mocked(useApproval).mockReturnValue(approval);
  });

  afterEach(() => {
    cleanup();
  });

  it.each([
    [
      'SwitchChain',
      () => <SwitchChain approvalId={APPROVAL_ID} params={{ data: { chain: 'QBIT_TESTNET4' as any }, session }} />,
      'switch_chain',
      'cancel',
      ['user_rejected_the_request']
    ],
    [
      'SwitchNetwork',
      () => <SwitchNetwork approvalId={APPROVAL_ID} params={{ data: { network: 'testnet4' }, session }} />,
      'switch_network',
      'cancel',
      ['user_rejected_the_request']
    ]
  ])('%s resolves and rejects by the rendered id', (_, renderScreen, confirmText, cancelText, reason) => {
    render(renderScreen());

    fireEvent.click(screen.getByText(confirmText));
    expect(approval.resolveApproval).toHaveBeenCalledWith(APPROVAL_ID);

    fireEvent.click(screen.getByText(cancelText));
    expect(approval.rejectApproval).toHaveBeenCalledWith(APPROVAL_ID, ...reason);
  });
});
