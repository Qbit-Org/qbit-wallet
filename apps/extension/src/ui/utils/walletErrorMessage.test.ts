import { describe, expect, it } from 'vitest';

import { walletErrorMessage as sharedWalletErrorMessage } from '../../../../../packages/wallet-state/src/utils/wallet-error-message';
import { walletErrorMessage } from './index';

// The extension keeps its own copy of the wallet-state helper (see the
// comment on it); the two must say the same for every rejection.
describe('walletErrorMessage', () => {
  it.each([
    ['a rejection as it crosses the UI port', { code: -32603, message: 'Password is incorrect' }],
    ['an Error', new Error('Signing failed')],
    ['a string rejection', 'Request rejected'],
    ['an object without a message', { code: -32603, data: { reasons: [] } }],
    ['an empty message', { message: '' }],
    ['a message that is not a string', { message: { code: 4 } }],
    ['an Error without a message', new Error('')],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7]
  ])('says what the wallet-state helper says for %s', (_name, error) => {
    expect(walletErrorMessage(error, 'unknown_error')).toBe(sharedWalletErrorMessage(error, 'unknown_error'));
  });

  it('shows a message and falls back as the wallet-state helper does', () => {
    expect(walletErrorMessage({ code: -1, message: 'Refused' }, 'unknown_error')).toBe('Refused');
    expect(walletErrorMessage({ code: -1 }, 'unknown_error')).toBe('unknown_error');
  });
});
