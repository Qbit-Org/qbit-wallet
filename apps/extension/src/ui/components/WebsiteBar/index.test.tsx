import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render, screen } from '@testing-library/react';

import WebsiteBar from '.';

vi.mock('@qbit/wallet-state', () => ({
  useI18n: () => ({ t: (key: string) => key })
}));

const session = { origin: 'https://qbit.org', icon: '', name: 'Qbit' };

describe('WebsiteBar', () => {
  afterEach(cleanup);

  it('marks the official Qbit website', () => {
    render(<WebsiteBar session={session} trusted />);

    expect(screen.getByText('https://qbit.org')).not.toBeNull();
    expect(screen.getByTestId('website-bar-trusted').textContent).toContain('official_qbit_website');
  });

  it('shows no mark for any other site', () => {
    render(<WebsiteBar session={{ ...session, origin: 'https://example.com' }} />);

    expect(screen.getByText('https://example.com')).not.toBeNull();
    expect(screen.queryByTestId('website-bar-trusted')).toBeNull();
  });
});
