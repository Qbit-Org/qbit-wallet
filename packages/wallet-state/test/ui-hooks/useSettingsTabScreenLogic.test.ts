import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

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
})
