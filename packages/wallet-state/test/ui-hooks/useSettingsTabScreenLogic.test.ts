import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useSettingsTabScreenLogic } from '../../src/ui-hooks/useSettingsTabScreenLogic'
import { createHookTestHarness } from './testHelpers'

describe('useSettingsTabScreenLogic', () => {
  it('offers Security, which opens the Security screen', () => {
    const harness = createHookTestHarness()
    const { result } = renderHook(() => useSettingsTabScreenLogic(), { wrapper: harness.wrapper })

    const security = result.current.settings_security
    expect(security).toMatchObject({
      key: 'settings_security',
      label: 'security',
      icon: 'security',
      right: true,
    })
    security.onClick?.()

    expect(harness.navigation.navigate).toHaveBeenCalledWith('SecurityScreen')
  })

  it('lists Security right before Appearance', () => {
    const harness = createHookTestHarness()
    const { result } = renderHook(() => useSettingsTabScreenLogic(), { wrapper: harness.wrapper })

    const keys = Object.keys(result.current)
    expect(keys.indexOf('settings_security')).toBe(keys.indexOf('settings_appearance') - 1)
  })

  // Address Type is an entry of Advanced Settings (useAddressTypeSettingLogic).
  it('gives the rows of the Settings tab, and no Address Type row among them', () => {
    const harness = createHookTestHarness()
    const { result } = renderHook(() => useSettingsTabScreenLogic(), { wrapper: harness.wrapper })

    expect(Object.keys(result.current).sort()).toEqual([
      'settings_aboutus',
      'settings_addressBook',
      'settings_advanced',
      'settings_appearance',
      'settings_connectedSites',
      'settings_lockwallet',
      'settings_security',
      'settings_switchNetwork',
    ])
    const rows = Object.values(result.current)
    expect(rows.map(row => row.key).sort()).toEqual(Object.keys(result.current).sort())
    expect(rows.map(row => row.label)).not.toContain('address_type')
    // Every row but Lock, which opens no screen: it locks.
    for (const row of rows) {
      if (row.key !== 'settings_lockwallet') row.onClick?.()
    }
    const opened = vi.mocked(harness.navigation.navigate).mock.calls.map(([screen]) => screen)
    expect(opened).not.toContain('AddressTypeScreen')
    expect(opened).toContain('AdvancedScreen')
  })
})
