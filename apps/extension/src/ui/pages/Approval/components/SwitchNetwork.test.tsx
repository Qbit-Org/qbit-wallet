import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useApproval } from '@qbit/wallet-state';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import SwitchNetwork from './SwitchNetwork';

// The screen renders the approval rpcFlow opens for a website switchNetwork:
// `data` is the dapp's `{ network }` and `context` the request's context.
// @qbit/wallet-shared is not mocked, so the real chain labels are rendered.

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  const Button = ({ text, onClick }: { text?: string; onClick?: () => void }) =>
    React.createElement('button', { onClick }, text);
  const Text = ({ text }: { text?: string }) => React.createElement('span', { 'data-testid': 'text' }, text);
  return {
    Button,
    Card: Container,
    Column: Container,
    Content: Container,
    Footer: Container,
    Header: Container,
    Layout: Container,
    Row: Container,
    Text
  };
});
vi.mock('@/ui/components/WebsiteBar', () => ({ default: () => null }));
vi.mock('@qbit/wallet-state', () => ({
  useApproval: vi.fn(),
  useChainType: () => 'QBIT_TESTNET4',
  useI18n: () => ({ t: (key: string) => key }),
  useNetworkType: () => 1
}));

const APPROVAL_ID = 'switch-network-approval';
const session = { origin: 'https://dapp.test', icon: '', name: 'Dapp' };

type Params = ComponentProps<typeof SwitchNetwork>['params'];

function requestParams(network: string, chain = 'QBIT_TESTNET4', activeNetwork = 'testnet4') {
  return {
    method: 'switchNetwork',
    data: { network },
    context: { origin: session.origin, account: 'tq1zaccount', chain, network: activeNetwork },
    session
  } as Params;
}

function chainLabels() {
  return screen
    .getAllByTestId('text')
    .map((node) => node.textContent)
    .filter((text) => text?.startsWith('Qbit '));
}

describe('SwitchNetwork approval', () => {
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
    ['mainnet', 'Qbit Mainnet'],
    ['testnet4', 'Qbit Testnet4'],
    ['regtest', 'Qbit Regtest']
  ])('renders a request for %s with the chain it switches to', (network, label) => {
    render(<SwitchNetwork approvalId={APPROVAL_ID} params={requestParams(network)} />);

    expect(chainLabels()).toEqual(['Qbit Testnet4', label]);
  });

  it('shows the chain the request was made on, from its context', () => {
    render(<SwitchNetwork approvalId={APPROVAL_ID} params={requestParams('testnet4', 'QBIT_MAINNET', 'mainnet')} />);

    expect(chainLabels()).toEqual(['Qbit Mainnet', 'Qbit Testnet4']);
  });

  it('settles the approval it renders', () => {
    render(<SwitchNetwork approvalId={APPROVAL_ID} params={requestParams('mainnet')} />);

    fireEvent.click(screen.getByText('switch_network'));
    expect(approval.resolveApproval).toHaveBeenCalledWith(APPROVAL_ID);

    fireEvent.click(screen.getByText('cancel'));
    expect(approval.rejectApproval).toHaveBeenCalledWith(APPROVAL_ID, 'user_rejected_the_request');
  });
});
