interface PlatformEnvType {
  VERSION: string
  CHANNEL: string
  MANIFEST_VERSION: string
  PLATFORM: 'extension' | 'ios' | 'android' | 'unknown'
  REVIEW_URL: string
  READY_TO_RENDER?: boolean
  /** Signed qbit Core runtime release tag the wallet is conformance-pinned to. */
  CORE_RELEASE_TAG: string
  /** Commit of the signed qbit Core runtime/source baseline. */
  CORE_RELEASE_COMMIT: string
}

export const PlatformEnv: PlatformEnvType = {
  VERSION: '1.0.0',
  CHANNEL: 'unknown',
  MANIFEST_VERSION: 'mv3',
  PLATFORM: 'unknown',
  REVIEW_URL: '',
  READY_TO_RENDER: false,
  CORE_RELEASE_TAG: '',
  CORE_RELEASE_COMMIT: '',
}
