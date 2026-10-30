import { WordsType } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'
import { useEffect, useMemo, useState } from 'react'
import { useI18n, useTools, useWallet } from 'src/context'
import { isMnemonicWord, validateMnemonic } from 'src/utils/qbit-utils'

export enum TabType {
  STEP1 = 'STEP1',
  STEP2 = 'STEP2',
  CHOOSE_ADDRESS_TYPE = 'CHOOSE_ADDRESS_TYPE',
}

function normalizeWhitespace(str: string) {
  str = str.replace(/[\n\r\t]+/g, ' ')
  str = str.replace(/\s+/g, ' ')
  str = str.trim()
  return str
}

export interface ContextData {
  mnemonics: string
  hdPath: string
  passphrase: string
  addressType: AddressType
  step1Completed: boolean
  tabType: TabType
  isRestore: boolean
  isCustom: boolean
  customHdPath: string
  addressTypeIndex: number
  wordsType: WordsType
  walletName?: string
}

export interface UpdateContextDataParams {
  mnemonics?: string
  hdPath?: string
  passphrase?: string
  addressType?: AddressType
  step1Completed?: boolean
  tabType?: TabType
  isCustom?: boolean
  customHdPath?: string
  addressTypeIndex?: number
  wordsType?: WordsType
  walletName?: string
}

interface WordsItem {
  key: WordsType
  label: string
  count: number
}

const getWords12Item = t => ({
  key: WordsType.WORDS_12,
  label: t('mnemonics_12_words'),
  count: 12,
})

const getWords24Item = t => ({
  key: WordsType.WORDS_24,
  label: t('mnemonics_24_words'),
  count: 24,
})

interface CreateWalletLogicParams {
  contextData: ContextData
  updateContextData: (params: UpdateContextDataParams) => void
}

function textToWordsArray(text: string) {
  return text.split(' ').filter(v => v.trim() !== '')
}

export function useCreateWalletLogicImportWordsStep(params: CreateWalletLogicParams) {
  const { contextData, updateContextData } = params
  const { t } = useI18n()

  const wordsItems: Array<WordsItem> = useMemo(() => {
    return [getWords12Item(t), getWords24Item(t)]
  }, [t])

  const wallet = useWallet()

  const [disabled, setDisabled] = useState(true)

  const [inputWords, setInputWords] = useState<Array<string>>(
    new Array(wordsItems[contextData.wordsType].count).fill('')
  )
  const [inputWordsText, setInputWordsText] = useState('')
  const [inputWordsError, setInputWordsError] = useState(false)
  // True after a paste whose extra words did not fit and were dropped.
  const [pastedTooManyWords, setPastedTooManyWords] = useState(false)
  // One flag per input: true when it holds a word that is not in the word list.
  const inputWordsInvalid = useMemo(
    () => inputWords.map(word => word !== '' && !isMnemonicWord(word)),
    [inputWords]
  )
  const tools = useTools()

  const [loading, setLoading] = useState(false)

  const [enteredWordsCount, setEnteredWordsCount] = useState(0)

  const enablePhrase = true

  const maxWordsCount = wordsItems[contextData.wordsType].count

  const initKey = async () => {
    let totalKeyringCount = 0
    try {
      totalKeyringCount = await wallet.getTotalKeyringCount()
    } catch (e) {
      const error = e as Error
      tools.toastError(error.message)
    }
    updateContextData({ walletName: `HD Wallet #${totalKeyringCount + 1}` })
  }

  useEffect(() => {
    initKey()
  }, [])

  useEffect(() => {
    setDisabled(true)

    const words = textToWordsArray(inputWordsText)
    if (words.length !== maxWordsCount) {
      return
    }

    const mnemonic = words.join(' ')
    if (!validateMnemonic(mnemonic)) {
      return
    }

    setDisabled(false)
  }, [inputWordsText])

  const updateWords = (words: Array<string>, isEndedWithSpace?: boolean) => {
    setInputWords(words)
    let text = words.join(' ')
    setInputWordsText(isEndedWithSpace ? text + ' ' : text)

    const enteredWordsCount = words.filter(key => {
      return key.trim() != ''
    }).length

    setEnteredWordsCount(enteredWordsCount)

    // A word outside the list is already flagged on its own input, so this
    // error covers only a phrase whose words are all valid (checksum or order).
    if (
      enteredWordsCount >= maxWordsCount &&
      words.every(isMnemonicWord) &&
      !validateMnemonic(text)
    ) {
      setInputWordsError(true)
    } else {
      setInputWordsError(false)
    }
  }

  const onInputWordsTextChange = (e: { target: { value: string } } | string) => {
    let value = typeof e === 'string' ? e : e.target.value
    let isEndedWithSpace = /\s$/.test(value)
    value = normalizeWhitespace(value)

    const wordsArr = textToWordsArray(value)
    setPastedTooManyWords(false)
    updateWords(wordsArr, isEndedWithSpace)
  }

  const onInputWordsChange = (e: { target: { value: string } } | string, index: number) => {
    let value = typeof e === 'string' ? e : e.target.value
    value = normalizeWhitespace(value)

    const newKeys = [...inputWords]
    newKeys.splice(index, 1, value)
    setPastedTooManyWords(false)
    updateWords(newKeys)
  }

  // extension
  const onHandleEventPaste = (event, index: number) => {
    const copyText = event.clipboardData?.getData('text/plain')
    const textArr = normalizeWhitespace(copyText).split(' ')
    const newKeys = [...inputWords]
    if (textArr) {
      for (let i = 0; i < inputWords.length - index; i++) {
        if (textArr.length == i) {
          break
        }
        newKeys[index + i] = textArr[i]
      }
      setPastedTooManyWords(textArr.length > inputWords.length - index)
      updateWords(newKeys)
    }

    event.preventDefault()
  }

  const onInputWalletNameChange = (e: { target: { value: string } } | string) => {
    const value = typeof e === 'string' ? e : e.target.value
    updateContextData({ walletName: value })
  }

  const onClickNext = async () => {
    try {
      const mnemonics = inputWords.join(' ')

      if (contextData.wordsType === WordsType.WORDS_12) {
        if (inputWords.length !== 12) {
          tools.toastError(t('ErrorPrompt_CreateHDwallet_StepImport_Not_12_words'))
          return
        }
      }

      if (contextData.wordsType === WordsType.WORDS_24) {
        if (inputWords.length !== 24) {
          tools.toastError(t('ErrorPrompt_CreateHDwallet_StepImport_Not_24_words'))
          return
        }
      }

      if (!validateMnemonic(mnemonics)) {
        tools.toastError(t('ErrorPrompt_CreateHDwallet_StepImport_InvalidMnemonic'))
        return
      }

      setLoading(true)

      updateContextData({
        walletName: contextData.walletName,
        mnemonics,
        tabType: TabType.CHOOSE_ADDRESS_TYPE,
      })
    } catch (e) {
      tools.toastError((e as any).message)
    } finally {
      setLoading(false)
    }
  }

  const onClickWordsItem = (wordsItem: WordsItem) => {
    updateContextData({ wordsType: wordsItem.key })
    setInputWordsText('')
    setInputWords(new Array(wordsItem.count).fill(''))
    setInputWordsError(false)
    setPastedTooManyWords(false)
  }

  const shouldEnteredWordsCount = wordsItems[contextData.wordsType].count

  return {
    wordsItems,
    t,
    disabled,
    inputWords,
    inputWordsText,
    onHandleEventPaste,
    onClickNext,
    onClickWordsItem,
    inputWordsError,
    inputWordsInvalid,
    pastedTooManyWords,
    onInputWordsTextChange,
    onInputWordsChange,
    loading,
    enablePhrase,
    walletName: contextData.walletName,
    onInputWalletNameChange,
    enteredWordsCount,
    shouldEnteredWordsCount,
  }
}
