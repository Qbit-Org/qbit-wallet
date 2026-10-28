import { describe, expect, it } from 'vitest';

import { formatSessionIcon } from './index';

describe('formatSessionIcon', () => {
  it('uses a bundled icon instead of loading dapp-controlled image URLs', () => {
    expect(
      formatSessionIcon({
        icon: 'https://tracker.example/pixel.gif',
        name: 'Untrusted dapp',
        origin: 'https://dapp.example'
      })
    ).toBe('./images/logo/logo@128x.png');

    expect(
      formatSessionIcon({
        icon: '/favicon.ico',
        name: 'Untrusted dapp',
        origin: 'https://dapp.example'
      })
    ).toBe('./images/logo/logo@128x.png');
  });
});
