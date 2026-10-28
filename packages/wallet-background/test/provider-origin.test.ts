import { describe, expect, it, vi } from 'vitest'

import internalMethod from '../src/controllers/provider/internalMethod'

function checkIn(senderUrl?: string, tabUrl?: string, senderOrigin?: string) {
  const setProp = vi.fn()
  const request = {
    data: {
      params: {
        name: 'Fixture dapp',
        icon: 'https://cdn.example/icon.png',
        origin: 'https://spoofed.example',
      },
    },
    session: { setProp },
    port:
      senderUrl || tabUrl || senderOrigin !== undefined
        ? {
            sender: {
              ...(senderUrl ? { url: senderUrl } : {}),
              ...(senderOrigin !== undefined ? { origin: senderOrigin } : {}),
              tab: { ...(tabUrl ? { url: tabUrl } : {}) },
            },
          }
        : {},
  }
  return { request, setProp }
}

function expectRejected({ request, setProp }: ReturnType<typeof checkIn>) {
  expect(() => internalMethod.tabCheckin(request as any)).toThrow('Cannot verify request origin')
  expect(setProp).not.toHaveBeenCalled()
}

describe('Qbit provider trusted origin check-in', () => {
  it('derives the exact origin from the extension port and ignores page metadata claims', () => {
    const { request, setProp } = checkIn(
      'https://dapp.example:8443/path?origin=spoofed',
      undefined,
      'https://dapp.example:8443'
    )

    expect(internalMethod.tabCheckin(request as any)).toBe('ACK_QBIT_PROVIDER_SESSION')
    expect(setProp).toHaveBeenCalledWith({
      origin: 'https://dapp.example:8443',
      name: 'Fixture dapp',
      icon: 'https://cdn.example/icon.png',
    })
  })

  it('accepts a sender whose browser origin matches its document URL', () => {
    const { request, setProp } = checkIn(
      'http://127.0.0.1:33735/connect',
      undefined,
      'http://127.0.0.1:33735'
    )

    expect(internalMethod.tabCheckin(request as any)).toBe('ACK_QBIT_PROVIDER_SESSION')
    expect(setProp.mock.calls[0][0].origin).toBe('http://127.0.0.1:33735')
  })

  it('binds the origin to the sender document instead of the tab current URL', () => {
    const { request, setProp } = checkIn(
      'https://requesting-document.example/path',
      'https://new-tab-document.example/',
      'https://requesting-document.example'
    )

    expect(internalMethod.tabCheckin(request as any)).toBe('ACK_QBIT_PROVIDER_SESSION')
    expect(setProp).toHaveBeenCalledWith({
      origin: 'https://requesting-document.example',
      name: 'Fixture dapp',
      icon: 'https://cdn.example/icon.png',
    })
  })

  it('does not fall back to a mutable tab URL when the sender document URL is absent', () => {
    expectRejected(checkIn(undefined, 'https://current-tab.example/', 'https://current-tab.example'))
  })

  it.each([
    [undefined, undefined],
    ['file:///tmp/index.html', 'file://'],
    ['ftp://dapp.example/index.html', 'ftp://dapp.example'],
    ['about:blank', 'https://dapp.example'],
    ['not a url', 'https://dapp.example'],
  ])('rejects an unverifiable sender URL %s', (url, origin) => {
    expectRejected(checkIn(url, undefined, origin))
  })

  it('rejects a CSP-sandboxed document whose https URL carries an opaque origin', () => {
    expectRejected(checkIn('https://dapp.example/uploads/sandboxed.html', undefined, 'null'))
  })

  it.each([undefined, ''])('rejects a sender without a browser origin (%j)', origin => {
    expectRejected(checkIn('https://dapp.example/', 'https://dapp.example/', origin))
  })

  it.each([
    'https://other.example',
    'https://dapp.example:8443',
    'http://dapp.example',
    'https://sub.dapp.example',
    'dapp.example',
    'https://dapp.example/',
  ])('rejects a sender origin %s that disagrees with the document URL', origin => {
    expectRejected(checkIn('https://dapp.example/path', undefined, origin))
  })

  it('bounds untrusted display metadata without changing the trusted origin', () => {
    const { request, setProp } = checkIn('https://dapp.example/', undefined, 'https://dapp.example')
    request.data.params.name = 'n'.repeat(300)
    request.data.params.icon = 'i'.repeat(2200)

    internalMethod.tabCheckin(request as any)

    expect(setProp.mock.calls[0][0].origin).toBe('https://dapp.example')
    expect(setProp.mock.calls[0][0].name).toHaveLength(256)
    expect(setProp.mock.calls[0][0].icon).toHaveLength(2048)
  })
})
