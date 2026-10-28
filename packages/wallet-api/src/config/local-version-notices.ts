import type { VersionDetail } from '../types'

/**
 * Release-owned "what's new" notices, keyed by the extension version that
 * introduces them.
 *
 * The home screen shows the matching notice once after the browser installs
 * that version. Content ships inside the release bundle so the wallet never
 * fetches changelog copy from a remote endpoint (see the privacy stance in
 * local-wallet-config.ts); a version without an entry, or with an empty
 * `notice`, shows nothing. Separate `notice` bullet lines with '\n'.
 *
 * Example entry:
 *   '1.0.2': {
 *     title: "What's new in 1.0.2",
 *     changelogs: [],
 *     notice: 'Unlock with Touch ID\nFaster balance refresh',
 *   },
 */
export const LOCAL_VERSION_NOTICES: Readonly<Record<string, Omit<VersionDetail, 'version'>>> = Object.freeze({})

export function getLocalVersionNotice(version: string): VersionDetail {
  const entry = LOCAL_VERSION_NOTICES[version]
  if (!entry) {
    return { version, title: '', changelogs: [], notice: '' }
  }
  return { version, title: entry.title, changelogs: [...entry.changelogs], notice: entry.notice }
}
