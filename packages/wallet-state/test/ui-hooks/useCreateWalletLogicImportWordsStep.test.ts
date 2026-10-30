import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { WordsType } from '@qbit/wallet-shared'

import {
  type ContextData,
  useCreateWalletLogicImportWordsStep,
} from '../../src/ui-hooks/useCreateWalletLogicImportWordsStep'
import { isMnemonicWord, validateMnemonic } from '../../src/utils/qbit-utils'
import { createHookTestHarness, createWalletMock } from './testHelpers'

// Public test vectors, not anyone's wallet.
const VALID_WORDS = [...new Array(11).fill('abandon'), 'about']
// Twelve words from the list whose checksum does not match.
const BAD_CHECKSUM_WORDS = new Array(12).fill('abandon')

function renderImportStep() {
  const updateContextData = vi.fn()
  const wallet = { ...createWalletMock(), getTotalKeyringCount: vi.fn().mockResolvedValue(0) }
  const { wrapper, tools } = createHookTestHarness({ wallet })
  const contextData = { wordsType: WordsType.WORDS_12 } as ContextData
  const hook = renderHook(
    () => useCreateWalletLogicImportWordsStep({ contextData, updateContextData }),
    { wrapper }
  )
  return { ...hook, updateContextData, tools }
}

function typeWords(
  result: { current: ReturnType<typeof useCreateWalletLogicImportWordsStep> },
  words: string[]
) {
  words.forEach((word, index) => {
    act(() => {
      result.current.onInputWordsChange(word, index)
    })
  })
}

function paste(
  result: { current: ReturnType<typeof useCreateWalletLogicImportWordsStep> },
  text: string,
  index = 0
) {
  const preventDefault = vi.fn()
  act(() => {
    result.current.onHandleEventPaste(
      { clipboardData: { getData: () => text }, preventDefault },
      index
    )
  })
  expect(preventDefault).toHaveBeenCalled()
}

describe('isMnemonicWord', () => {
  it('accepts exactly the words the restore check accepts', () => {
    expect(isMnemonicWord('abandon')).toBe(true)
    expect(isMnemonicWord('')).toBe(false)
    expect(isMnemonicWord('abandn')).toBe(false)
    expect(isMnemonicWord(' abandon ')).toBe(false)
    expect(isMnemonicWord('abandon about')).toBe(false)
  })

  it('treats a capitalized word as the restore check does', () => {
    const capitalized = ['Abandon', ...VALID_WORDS.slice(1)].join(' ')
    expect(validateMnemonic(capitalized)).toBe(false)
    expect(isMnemonicWord('Abandon')).toBe(false)
  })

  it('applies the same Unicode normalization as the restore check', () => {
    // Fullwidth "ａ" normalizes (NFKD) to "a", so the phrase still restores.
    const fullwidth = [...VALID_WORDS.slice(0, 11), 'ａbout'].join(' ')
    expect(validateMnemonic(fullwidth)).toBe(true)
    expect(isMnemonicWord('ａbout')).toBe(true)
  })
})

describe('useCreateWalletLogicImportWordsStep word checks', () => {
  it('flags nothing while the inputs are empty', async () => {
    const { result, updateContextData } = renderImportStep()
    await waitFor(() =>
      expect(updateContextData).toHaveBeenCalledWith({ walletName: 'HD Wallet #1' })
    )

    expect(result.current.inputWordsInvalid).toEqual(new Array(12).fill(false))
    expect(result.current.inputWordsError).toBe(false)
    expect(result.current.disabled).toBe(true)
  })

  it('flags a misspelled word and clears the flag once it is corrected', () => {
    const { result } = renderImportStep()

    typeWords(result, ['abandn'])
    expect(result.current.inputWordsInvalid[0]).toBe(true)
    expect(result.current.inputWordsInvalid.slice(1)).toEqual(new Array(11).fill(false))

    typeWords(result, ['abandon'])
    expect(result.current.inputWordsInvalid[0]).toBe(false)
  })

  it('flags a capitalized word', () => {
    const { result } = renderImportStep()

    typeWords(result, ['Abandon'])

    expect(result.current.inputWordsInvalid[0]).toBe(true)
  })

  it('does not flag a valid word typed with surrounding whitespace', () => {
    const { result } = renderImportStep()

    typeWords(result, [' \tabandon\n '])

    expect(result.current.inputWords[0]).toBe('abandon')
    expect(result.current.inputWordsInvalid[0]).toBe(false)
  })

  it('flags only the mistyped word of a pasted phrase', () => {
    const { result } = renderImportStep()
    const words = [...VALID_WORDS]
    words[5] = 'abandom'

    paste(result, `  ${words.join('  ')}\n`)

    expect(result.current.inputWordsInvalid).toEqual(words.map((_, index) => index === 5))
    // The flagged word explains the problem, so the phrase message stays hidden.
    expect(result.current.inputWordsError).toBe(false)
    expect(result.current.disabled).toBe(true)
  })

  it('reports a complete phrase of listed words whose checksum fails', () => {
    const { result } = renderImportStep()

    paste(result, BAD_CHECKSUM_WORDS.join(' '))

    expect(result.current.inputWordsInvalid).toEqual(new Array(12).fill(false))
    expect(result.current.inputWordsError).toBe(true)
    expect(result.current.disabled).toBe(true)
  })

  it('clears the phrase error when the word count changes', () => {
    const { result } = renderImportStep()
    paste(result, BAD_CHECKSUM_WORDS.join(' '))
    expect(result.current.inputWordsError).toBe(true)

    act(() => {
      result.current.onClickWordsItem(result.current.wordsItems[WordsType.WORDS_24])
    })

    expect(result.current.inputWordsError).toBe(false)
  })

  it('accepts a valid phrase without flags and passes it on unchanged', async () => {
    const { result, updateContextData, tools } = renderImportStep()

    typeWords(result, VALID_WORDS)

    expect(result.current.inputWordsInvalid).toEqual(new Array(12).fill(false))
    expect(result.current.inputWordsError).toBe(false)
    expect(result.current.disabled).toBe(false)

    await act(async () => {
      await result.current.onClickNext()
    })

    expect(tools.toastError).not.toHaveBeenCalled()
    expect(updateContextData).toHaveBeenCalledWith(
      expect.objectContaining({ mnemonics: VALID_WORDS.join(' ') })
    )
  })
})
