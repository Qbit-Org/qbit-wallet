import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  approvalService: {
    approvalWindowId: 0,
    handleWindowRemoved: vi.fn(),
    platformOpenWindow: undefined as unknown as (winProps?: unknown) => Promise<number>
  },
  winMgr: {
    event: { on: vi.fn() },
    openNotification: vi.fn(),
    remove: vi.fn(),
    focus: vi.fn()
  }
}));

vi.mock('@qbit/wallet-background', () => ({ approvalService: harness.approvalService }));
vi.mock('../webapi', () => ({ winMgr: harness.winMgr }));

import { initWindow } from './window';

describe('approval window adapter', () => {
  beforeEach(() => {
    initWindow();
  });

  it('returns the id of the window it opened', async () => {
    harness.winMgr.openNotification.mockResolvedValue(7);
    await expect(harness.approvalService.platformOpenWindow({ height: 600 })).resolves.toBe(7);
    expect(harness.winMgr.openNotification).toHaveBeenCalledWith({ height: 600 });
  });

  it('fails instead of naming another window when the browser reports no id', async () => {
    harness.winMgr.openNotification.mockResolvedValue(undefined);
    await expect(harness.approvalService.platformOpenWindow()).rejects.toThrow('Approval window has no id');
  });
});
