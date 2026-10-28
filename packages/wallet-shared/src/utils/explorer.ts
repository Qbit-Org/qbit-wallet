import type { TypeChain } from '../constants/common'

export type ExplorerResource = 'address' | 'block' | 'tx'

type ExplorerChainConfig = Pick<TypeChain, 'mempoolSpaceUrl'>

export function getExplorerBaseUrl(chain?: ExplorerChainConfig): string | undefined {
  if (!chain) {
    return undefined
  }

  const candidate = chain.mempoolSpaceUrl.trim()
  if (!candidate) {
    return undefined
  }

  try {
    const url = new URL(candidate)
    const isLoopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      (url.protocol === 'http:' && !isLoopback) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined
    }

    return url.href.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

export function getExplorerUrl(
  chain: ExplorerChainConfig | undefined,
  resource: ExplorerResource,
  identifier?: string
): string | undefined {
  if (typeof identifier !== 'string') {
    return undefined
  }

  const baseUrl = getExplorerBaseUrl(chain)
  const trimmedIdentifier = identifier.trim()
  if (
    !baseUrl ||
    !trimmedIdentifier ||
    trimmedIdentifier !== identifier ||
    trimmedIdentifier === '.' ||
    trimmedIdentifier === '..' ||
    // Deliberately reject ASCII control bytes before URL encoding.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(identifier)
  ) {
    return undefined
  }

  try {
    return `${baseUrl}/${resource}/${encodeURIComponent(identifier)}`
  } catch {
    return undefined
  }
}
