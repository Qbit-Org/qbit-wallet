// Network and Chain types
export enum NetworkType {
  MAINNET,
  TESTNET,
  REGTEST,
}

export enum ChainType {
  QBIT_TESTNET4 = 'QBIT_TESTNET4',
  QBIT_REGTEST = 'QBIT_REGTEST',
  QBIT_MAINNET = 'QBIT_MAINNET',
}

// Address types
export enum AddressType {
  P2PKH,
  P2WPKH,
  P2TR,
  P2SH_P2WPKH,
  BIP44_P2WPKH,
  BIP44_P2TR,
  P2WSH,
  P2SH,
  UNKNOWN,
  P2MR,
}
