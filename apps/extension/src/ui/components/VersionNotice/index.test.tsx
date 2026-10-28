import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { VersionNotice } from './index';

const notice = {
  version: '1.0.1',
  title: 'New in 1.0.1',
  changelogs: [],
  notice: 'Unlock with Touch ID\nFaster balance refresh\n'
};

describe('VersionNotice', () => {
  afterEach(cleanup);

  it('renders the version header and one bullet row per notice line', () => {
    render(<VersionNotice notice={notice} onClose={() => undefined} />);

    expect(screen.getByText('Version 1.0.1 Updates')).toBeTruthy();
    expect(screen.getByText('Unlock with Touch ID')).toBeTruthy();
    expect(screen.getByText('Faster balance refresh')).toBeTruthy();
  });

  it('dismisses through the Continue button', () => {
    const onClose = vi.fn();
    render(<VersionNotice notice={notice} onClose={onClose} />);

    fireEvent.click(screen.getByText('Continue'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
