import { formatP2mrImportDescriptors } from '@qbit-oss/protocol'
import { ADDRESS_TYPES, KeyringType } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'
import { useEffect, useState } from 'react'
import type { QbitP2mrDescriptorExport } from 'src/context/WalletContext'
import { useI18n, useNavigation, useTools, useWallet } from 'src/context'
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
      const { mnemonic, passphrase } = await wallet.getMnemonics(password, keyring)
      setMnemonic(mnemonic)
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

  const handleOnKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ('Enter' == e.key) {
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

  const pathName = ADDRESS_TYPES.find(v => v.hdPath === keyring.hdPath)?.name || 'custom'

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
    handleOnKeyUp,
    mnemonic,
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
