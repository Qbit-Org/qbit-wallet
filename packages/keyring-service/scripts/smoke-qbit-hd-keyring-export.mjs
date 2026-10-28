const qbitHdKeyring = await import('@qbit/keyring-service/qbit-hd-keyring')

if (typeof qbitHdKeyring.QbitHdKeyring !== 'function') {
  throw new Error('Qbit HD keyring ESM subpath does not export QbitHdKeyring')
}
