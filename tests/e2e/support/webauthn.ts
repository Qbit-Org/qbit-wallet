import type { CDPSession, Page } from '@playwright/test'

/**
 * Attach a CDP virtual authenticator that behaves like TouchID: platform
 * (internal) transport, user verification, PRF/hmac-secret support, and
 * automatic presence so ceremonies complete without a human. Scoped to the
 * given page's target; a restarted browser context needs a fresh one (and
 * loses the credentials of the old one).
 */
export async function attachVirtualTouchId(
  page: Page
): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  })) as { authenticatorId: string }
  return { cdp, authenticatorId }
}
