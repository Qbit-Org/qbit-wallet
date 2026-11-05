import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  ANNOUNCE_PROVIDER_EVENT,
  announceProvider,
  createProviderUuid,
  PROVIDER_ICON,
  PROVIDER_INITIALIZED_EVENT,
  REQUEST_PROVIDER_EVENT,
  type QbitProviderDetail
} from './providerAnnouncement';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function recordEvents(target: EventTarget) {
  const events: Array<{ type: string; detail?: QbitProviderDetail }> = [];
  for (const type of [PROVIDER_INITIALIZED_EVENT, ANNOUNCE_PROVIDER_EVENT]) {
    target.addEventListener(type, (event) => {
      events.push({ type, detail: (event as CustomEvent<QbitProviderDetail>).detail ?? undefined });
    });
  }
  return events;
}

describe('Qbit provider announcement', () => {
  it('dispatches qbit#initialized once, then announces a frozen detail', () => {
    const target = new EventTarget() as Window;
    const events = recordEvents(target);
    const provider = {};

    announceProvider(provider, target);

    expect(events.map(({ type }) => type)).toEqual([PROVIDER_INITIALIZED_EVENT, ANNOUNCE_PROVIDER_EVENT]);
    const detail = events[1].detail as QbitProviderDetail;
    expect(detail.provider).toBe(provider);
    expect(detail.info).toEqual({
      uuid: expect.stringMatching(UUID_V4),
      name: 'Qbit Wallet',
      icon: PROVIDER_ICON,
      rdns: 'org.qbit.wallet'
    });
    expect(Object.isFrozen(detail)).toBe(true);
    expect(Object.isFrozen(detail.info)).toBe(true);
    expect(Reflect.set(detail, 'provider', { spoofed: true })).toBe(false);
    expect(Reflect.set(detail.info, 'name', 'Spoofed')).toBe(false);
  });

  it('answers a request from a page that starts listening late with the same announcement', () => {
    const target = new EventTarget() as Window;
    const early = recordEvents(target);
    announceProvider({}, target);

    const late = recordEvents(target);
    target.dispatchEvent(new Event(REQUEST_PROVIDER_EVENT));
    target.dispatchEvent(new Event(REQUEST_PROVIDER_EVENT));

    expect(late.map(({ type }) => type)).toEqual([ANNOUNCE_PROVIDER_EVENT, ANNOUNCE_PROVIDER_EVENT]);
    expect(late[0].detail).toBe(early[1].detail);
    expect(late[1].detail).toBe(early[1].detail);
    expect(early.filter(({ type }) => type === PROVIDER_INITIALIZED_EVENT)).toHaveLength(1);
  });

  it('answers a page that asks from its qbit#initialized handler', () => {
    const target = new EventTarget() as Window;
    const announced = vi.fn();
    target.addEventListener(PROVIDER_INITIALIZED_EVENT, () => {
      target.addEventListener(ANNOUNCE_PROVIDER_EVENT, announced);
      target.dispatchEvent(new Event(REQUEST_PROVIDER_EVENT));
    });

    announceProvider({}, target);

    // Once for the request, once for the announcement that follows the event.
    expect(announced).toHaveBeenCalledTimes(2);
  });

  it('gives each page load its own uuid', () => {
    const uuids = [new EventTarget(), new EventTarget()].map((target) => {
      const events = recordEvents(target);
      announceProvider({}, target as Window);
      return (events[1].detail as QbitProviderDetail).info.uuid;
    });

    expect(uuids[0]).not.toBe(uuids[1]);
  });

  it('makes a version 4 uuid from getRandomValues alone, as on an http: page', () => {
    const random = {
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
        (array as unknown as Uint8Array).fill(0xff);
        return array;
      }
    };

    expect(createProviderUuid(random)).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });

  it('uses the extension icon as its data URI', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const icon = readFileSync(resolve(here, '../../../build/_raw/images/logo/logo@128x.png'));

    expect(PROVIDER_ICON).toBe(`data:image/png;base64,${icon.toString('base64')}`);
  });
});
