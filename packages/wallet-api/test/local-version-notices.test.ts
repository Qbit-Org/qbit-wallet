import { describe, expect, it } from 'vitest'

import { LOCAL_VERSION_NOTICES, getLocalVersionNotice } from '../src/config/local-version-notices'

describe('getLocalVersionNotice', () => {
  it('returns an empty notice for a version without a bundled entry', () => {
    expect(getLocalVersionNotice('0.0.0-unknown')).toEqual({
      version: '0.0.0-unknown',
      title: '',
      changelogs: [],
      notice: '',
    })
  })

  it('returns bundled entries verbatim with the requested version stamped in', () => {
    for (const [version, entry] of Object.entries(LOCAL_VERSION_NOTICES)) {
      expect(getLocalVersionNotice(version)).toEqual({ version, ...entry })
    }
  })

  it('keeps every bundled entry well-formed', () => {
    for (const [version, entry] of Object.entries(LOCAL_VERSION_NOTICES)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(typeof entry.title).toBe('string')
      expect(typeof entry.notice).toBe('string')
      expect(Array.isArray(entry.changelogs)).toBe(true)
      // An entry that shows a popover must have visible copy to show.
      if (entry.notice) {
        expect(entry.title.trim()).not.toBe('')
        expect(entry.notice.trim()).not.toBe('')
      }
    }
  })

  it('returns a fresh changelogs array so caller mutation cannot leak', () => {
    const first = getLocalVersionNotice('0.0.0-unknown')
    first.changelogs.push('caller mutation')
    expect(getLocalVersionNotice('0.0.0-unknown').changelogs).toEqual([])
  })
})
