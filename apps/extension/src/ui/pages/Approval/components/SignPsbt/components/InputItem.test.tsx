import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DecodedPsbtInput, DecodedPsbtOutput } from '@qbit/wallet-shared';
import { useCurrentAddress, useI18n, useQbitUnit } from '@qbit/wallet-state';

import { InputItem } from './InputItem';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    style,
    onClick,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    style?: CSSProperties;
    onClick?: (event: unknown) => void;
    'data-testid'?: string;
  }) => React.createElement('div', { style, onClick, 'data-testid': dataTestId }, children);
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string | number; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
  const Icon = ({ icon }: { icon: string }) => React.createElement('span', { 'data-icon': icon });

  return {
    Column: Container,
    Icon,
    Row: Container,
    Text
  };
});

vi.mock('@/ui/components/AddressText', () => ({
  AddressText: ({ address }: { address: string }) => <span data-testid="address-text">{address}</span>
}));

vi.mock('@qbit/base-utils', () => ({
  numUtils: {
    satoshisToAmount: (value: number) => String(value)
  }
}));

vi.mock('@qbit/wallet-state', () => ({
  useCurrentAddress: vi.fn(),
  useI18n: vi.fn(),
  useQbitUnit: vi.fn()
}));

vi.mock('./ContractSection', () => ({ default: () => null }));

const decodedPsbt = {} as any;

function renderOutput(outputInfo: DecodedPsbtOutput) {
  return render(
    <InputItem index={0} outputInfo={outputInfo} decodedPsbt={decodedPsbt} setContractPopoverData={vi.fn()} />
  );
}

function renderInput(inputInfo: DecodedPsbtInput, signingKeyCount: number) {
  return render(
    <InputItem
      index={0}
      inputInfo={inputInfo}
      decodedPsbt={decodedPsbt}
      toSignData={
        {
          psbtHex: '00',
          toSignInputs: [{ index: 0 }],
          qbitP2mrSigningKeys: Array.from({ length: signingKeyCount }, () => ({ inputIndex: 0 }))
        } as any
      }
      setContractPopoverData={vi.fn()}
    />
  );
}

describe('InputItem OP_RETURN confirmation output', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(useCurrentAddress).mockReturnValue('qbrt1zcurrent');
    vi.mocked(useQbitUnit).mockReturnValue('QBT' as any);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
  });

  it('renders canonical script hex before supplemental chunk and UTF-8 details', () => {
    renderOutput({
      type: 'op_return',
      address: '',
      value: 0,
      alkanes: [],
      opReturn: {
        scriptPubKeyHex: '6a0568656c6c6f',
        chunks: [
          {
            pushHeaderHex: '05',
            dataHex: '68656c6c6f',
            dataByteLength: 5,
            dataStartByte: 2,
            dataEndByte: 7,
            utf8Preview: 'hello'
          }
        ]
      }
    });

    expect(screen.getByText('OP_RETURN / Public data')).toBeTruthy();
    expect(screen.getByTestId('op-return-script-hex').textContent).toBe('6a0568656c6c6f');
    expect(screen.getByText('Chunk 1: push header 05; data bytes [2, 7); 5 bytes')).toBeTruthy();
    expect(screen.getByTestId('op-return-chunk-0-hex').textContent).toBe('68656c6c6f');
    expect(screen.getByTestId('op-return-chunk-0-preview').textContent).toBe('UTF-8 preview (supplemental): "hello"');
    expect(screen.getByTestId('op-return-public-warning').textContent).toContain('public and permanently recorded');
    expect(document.querySelector('[data-icon="psbt_opreturn"]')).toBeTruthy();
    expect(screen.queryByTestId('op-return-decode-warning')).toBeNull();
  });

  it('renders hex-looking ABCD as the actual abcd bytes without a text preview', () => {
    renderOutput({
      type: 'op_return',
      address: '',
      value: 0,
      alkanes: [],
      opReturn: {
        scriptPubKeyHex: '6a02abcd',
        chunks: [
          {
            pushHeaderHex: '02',
            dataHex: 'abcd',
            dataByteLength: 2,
            dataStartByte: 2,
            dataEndByte: 4
          }
        ]
      }
    });

    expect(screen.getByTestId('op-return-script-hex').textContent).toBe('6a02abcd');
    expect(screen.getByTestId('op-return-chunk-0-hex').textContent).toBe('abcd');
    expect(screen.queryByTestId('op-return-chunk-0-preview')).toBeNull();
    expect(screen.queryByText('ABCD')).toBeNull();
  });

  it('shows unusual OP_RETURN raw bytes and a decode warning without crashing', () => {
    renderOutput({
      type: 'op_return',
      address: '',
      value: 0,
      alkanes: [],
      opReturn: {
        scriptPubKeyHex: '6a51',
        chunks: [],
        decodeWarning: 'non-pushdata-opcode'
      }
    });

    expect(screen.getByTestId('op-return-script-hex').textContent).toBe('6a51');
    expect(screen.getByTestId('op-return-decode-warning').textContent).toContain('unable to fully decode');
    expect(screen.queryByTestId('op-return-chunk-0')).toBeNull();
  });

  it('keeps a normal P2MR output on the existing address presentation', () => {
    const address = 'qbrt1znormalp2mroutput';
    renderOutput({
      address,
      value: 10_000,
      scriptPubKeyHex: '5220abcd',
      alkanes: []
    });

    expect(screen.getByTestId('address-text').textContent).toBe(address);
    expect(document.querySelector('[data-icon="psbt_output"]')).toBeTruthy();
    expect(screen.queryByTestId('psbt-output-script-0')).toBeNull();
    fireEvent.click(screen.getByTestId('psbt-output-details-toggle-0'));
    expect(screen.getByText('OUTPUT SCRIPT')).toBeTruthy();
    expect(screen.getByTestId('psbt-output-script-0').textContent).toBe('5220abcd');
    expect(screen.queryByText('OP_RETURN / Public data')).toBeNull();
    expect(screen.queryByTestId('op-return-public-warning')).toBeNull();
  });

  it('shows the exact number of P2MR signing keys affecting an input', () => {
    renderInput(
      {
        txid: 'ab'.repeat(32),
        vout: 7,
        sequence: 4294967293,
        address: 'qbrt1zsigninginput',
        value: 20_000,
        witnessUtxoScriptHex: '5220cafe',
        alkanes: []
      } as any,
      2
    );

    expect(screen.getByTestId('address-text').textContent).toBe('qbrt1zsigninginput');
    expect(screen.queryByTestId('psbt-input-outpoint-0')).toBeNull();
    fireEvent.click(screen.getByTestId('psbt-input-details-toggle-0'));
    expect(screen.getByText('PREVOUT')).toBeTruthy();
    expect(screen.getByText('WITNESS SCRIPT')).toBeTruthy();
    expect(screen.getByText('SEQUENCE')).toBeTruthy();
    expect(screen.getByTestId('psbt-input-outpoint-0').textContent).toBe(`${'ab'.repeat(32)}:7`);
    expect(screen.getByTestId('psbt-input-script-0').textContent).toBe('5220cafe');
    expect(screen.getByTestId('psbt-input-sequence-0').textContent).toBe('4294967293');
    expect(screen.getByText('Signs with 2 P2MR keys')).toBeTruthy();
  });
});

describe('InputItem output the wallet does not recognise (#271)', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(useCurrentAddress).mockReturnValue('qbrt1zcurrent');
    vi.mocked(useQbitUnit).mockReturnValue('QBT' as any);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
  });

  function renderRole(role: string) {
    return render(
      <InputItem
        index={0}
        outputInfo={{ address: 'qbrt1zpayee', value: 10_000, scriptPubKeyHex: '5220beef' }}
        decodedPsbt={{ spendSummary: { outputRoles: [role] } } as any}
      />
    );
  }

  it('flags an output the background classified as unrecognised', () => {
    renderRole('unrecognised');
    expect(screen.getByTestId('psbt-output-unrecognised-0').textContent).toBe('unrecognised_output');
  });

  it('does not flag the named recipient or the wallet’s own outputs', () => {
    renderRole('recipient');
    expect(screen.queryByTestId('psbt-output-unrecognised-0')).toBeNull();
    cleanup();
    renderRole('wallet');
    expect(screen.queryByTestId('psbt-output-unrecognised-0')).toBeNull();
  });
});

describe('InputItem output with no address', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(useCurrentAddress).mockReturnValue('qbrt1zcurrent');
    vi.mocked(useQbitUnit).mockReturnValue('QBT' as any);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
  });

  function renderScriptOutput(outputInfo: DecodedPsbtOutput) {
    return render(
      <InputItem
        index={0}
        outputInfo={outputInfo}
        decodedPsbt={{ spendSummary: { outputRoles: ['unrecognised'] } } as any}
      />
    );
  }

  it('names a pay-to-anchor output as one anyone can spend, in place of a recipient', () => {
    renderScriptOutput({ type: 'p2a', address: '', value: 99_999, scriptPubKeyHex: '51024e73' });

    expect(screen.getByTestId('psbt-output-script-label-0').textContent).toBe('P2A anchor (anyone can spend)');
    expect(screen.getByTestId('psbt-output-script-warning-0').textContent).toContain('Anyone can spend');
    expect(screen.getByTestId('psbt-output-unrecognised-0').textContent).toBe('unrecognised_output');
    expect(screen.queryByTestId('address-text')).toBeNull();
    fireEvent.click(screen.getByTestId('psbt-output-details-toggle-0'));
    expect(screen.getByTestId('psbt-output-script-0').textContent).toBe('51024e73');
  });

  it('names any other script with no address as an unknown script', () => {
    renderScriptOutput({ type: 'unknown_script', address: '', value: 5_000, scriptPubKeyHex: '00' });

    expect(screen.getByTestId('psbt-output-script-label-0').textContent).toBe('Unknown script');
    expect(screen.getByTestId('psbt-output-script-warning-0').textContent).toContain('cannot decode');
    expect(screen.queryByTestId('address-text')).toBeNull();
  });

  it('shows an output with an address as before', () => {
    renderScriptOutput({ address: 'qbrt1zpayee', value: 10_000, scriptPubKeyHex: '5220beef' });

    expect(screen.getByTestId('address-text').textContent).toBe('qbrt1zpayee');
    expect(screen.queryByTestId('psbt-output-script-label-0')).toBeNull();
    expect(screen.queryByTestId('psbt-output-script-warning-0')).toBeNull();
  });
});
