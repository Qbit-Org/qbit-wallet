import { formatP2mrImportDescriptors } from '@qbit-oss/protocol'
import { ADDRESS_TYPES, KeyringType } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'
import { useEffect, useState } from 'react'
import type { QbitP2mrDescriptorExport } from 'src/context/WalletContext'
import { useI18n, useNavigation, useTools, useWallet } from 'src/context'
import { isEnterPressedInField } from './isEnterPressedInField'
type Status = '' | 'error' | 'warning' | undefined

function buildImportDescriptorsJson(descriptorExport: QbitP2mrDescriptorExport): string {
  return JSON.stringify(
    formatP2mrImportDescriptors({
      external: descriptorExport.external.descriptor,
      internal: descriptorExport.internal.descriptor,
    }),
    null,
    2
  )
}

export function useExportMnemonicsScreenLogic() {
  const nav = useNavigation()
  const { keyring } = nav.getRouteState<'ExportMnemonicsScreen'>()

  const { t } = useI18n()

  const [password, setPassword] = useState('')
  const [disabled, setDisabled] = useState(true)

  const [mnemonic, setMnemonic] = useState('')
  // The path the background returns with the phrase. The listed keyring is no
  // substitute: a corrupted wallet is listed with an empty hdPath.
  const [hdPath, setHdPath] = useState('')
  const [status, setStatus] = useState<Status>('')
  const [error, setError] = useState('')
  const wallet = useWallet()
  const tools = useTools()

  const [passphrase, setPassphrase] = useState('')
  const [p2mrDescriptors, setP2mrDescriptors] = useState<QbitP2mrDescriptorExport | undefined>()
  const [importDescriptorsJson, setImportDescriptorsJson] = useState('')

  const isP2mrKeyring =
    keyring.type === KeyringType.QbitHdKeyring && keyring.addressType === AddressType.P2MR

  const btnClick = async () => {
    try {
      const { mnemonic, hdPath, passphrase } = await wallet.getMnemonics(password, keyring)
      // An answer without a phrase fails like a refusal, on the password step:
      // the phrase step splits the phrase into words while it renders.
      if (typeof mnemonic !== 'string' || !mnemonic) {
        throw new Error(t('not_supported'))
      }
      setMnemonic(mnemonic)
      // The answer crosses the UI port as JSON: a missing path arrives as no
      // key or null, and is shown as no path rather than a made-up one.
      setHdPath(typeof hdPath === 'string' ? hdPath : '')
      setPassphrase(passphrase)
      if (isP2mrKeyring) {
        const descriptorExport = await wallet.exportP2mrDescriptors(password, keyring)
        setP2mrDescriptors(descriptorExport)
        setImportDescriptorsJson(buildImportDescriptorsJson(descriptorExport))
      }
    } catch (e) {
      setStatus('error')
      setError((e as any).message)
    }
  }

  // Enter in the password field submits it, on its keydown: the account
  // switcher's wallet menu opens this screen on an Enter's keydown.
  const handleOnKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isEnterPressedInField(e)) {
      btnClick()
    }
  }

  useEffect(() => {
    setDisabled(true)
    if (password) {
      setDisabled(false)
      setStatus('')
      setError('')
      setP2mrDescriptors(undefined)
      setImportDescriptorsJson('')
    }
  }, [password])

  function copy(str: string) {
    tools.copyToClipboard(str)
  }
  const words = mnemonic.split(' ')

  const pathName = ADDRESS_TYPES.find(v => v.hdPath === hdPath)?.name || 'custom'

  const onClickBack = () => {
    nav.goBack()
  }

  return {
    words,
    pathName,
    t,
    setPassword,
    disabled,
    btnClick,
    handleOnKeyDown,
    mnemonic,
    hdPath,
    passphrase,
    p2mrDescriptors,
    importDescriptorsJson,
    isP2mrKeyring,
    error,
    copy,
    keyring,
    onClickBack,
  }
}
