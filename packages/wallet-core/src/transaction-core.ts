import * as transactionCore from 'bitcoinjs-lib'
import ECPairModule, { ECPairAPI } from 'ecpair'
import * as tinysecp256k1 from 'tiny-secp256k1'
import * as nativeSecp256k1 from '@bitcoinerlab/secp256k1'

export type { ECPairInterface } from 'ecpair'
export { transactionCore }

export enum EccType {
  tiny = 'tiny',
  native = 'native',
}

let isReactNative = false
try {
  const { Platform } = require('react-native')
  isReactNative = Platform.OS === 'android' || Platform.OS === 'ios'
} catch {
  isReactNative = false
}

class ECCManager {
  eccType: EccType = isReactNative ? EccType.native : EccType.tiny

  private tinyEcc: any = tinysecp256k1
  // @ts-ignore
  private tinyEccPair: ECPairAPI
  private nativeEcc: any = nativeSecp256k1
  private nativeEccPair: ECPairAPI

  constructor() {
    if (typeof tinysecp256k1.isPoint == 'function') {
      // @ts-ignore
      this.tinyEccPair = (ECPairModule.default ? ECPairModule.default : ECPairModule)(this.tinyEcc)
    }
    // @ts-ignore
    this.nativeEccPair = (ECPairModule.default ? ECPairModule.default : ECPairModule)(
      this.nativeEcc
    )

    this.setEccType(this.eccType)
  }

  setEccType(eccType: EccType) {
    this.eccType = eccType
    if (this.eccType === EccType.tiny) {
      transactionCore.initEccLib(this.tinyEcc)
    } else {
      transactionCore.initEccLib(this.nativeEcc)
    }
  }

  get ecc() {
    if (this.eccType === EccType.tiny) {
      return this.tinyEcc
    } else {
      return this.nativeEcc
    }
  }

  get eccPair() {
    if (this.eccType === EccType.tiny) {
      return this.tinyEccPair
    } else {
      return this.nativeEccPair
    }
  }
}

export const eccManager = new ECCManager()
