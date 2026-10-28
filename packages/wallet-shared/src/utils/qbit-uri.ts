export const QBIT_URI_SCHEME = 'qbit'

export type QbitUriParseErrorCode = 'UNSUPPORTED_SCHEME' | 'INVALID_URI' | 'INVALID_AMOUNT'

export class QbitUriParseError extends Error {
  constructor(public readonly code: QbitUriParseErrorCode, message: string) {
    super(message)
    this.name = 'QbitUriParseError'
  }
}

export type QbitUri = {
  address: string
  amount?: string
  label?: string
}

const QBIT_AMOUNT_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/

function getScheme(value: string) {
  return value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
}

export function isQbitUri(value: string) {
  return getScheme(value.trim()) === QBIT_URI_SCHEME
}

export function assertValidQbitAmount(amount: string) {
  if (!QBIT_AMOUNT_PATTERN.test(amount)) {
    throw new QbitUriParseError('INVALID_AMOUNT', 'Invalid qbit: URI amount')
  }
}

export function parseQbitUri(value: string): QbitUri | null {
  const input = value.trim()
  const scheme = getScheme(input)

  if (!scheme) {
    return null
  }

  if (scheme !== QBIT_URI_SCHEME) {
    throw new QbitUriParseError('UNSUPPORTED_SCHEME', 'Payment URI must use the qbit: scheme')
  }

  if (input.slice(0, `${QBIT_URI_SCHEME}://`.length).toLowerCase() === `${QBIT_URI_SCHEME}://`) {
    throw new QbitUriParseError('INVALID_URI', 'Invalid qbit: URI')
  }

  const payload = input.slice(`${QBIT_URI_SCHEME}:`.length)
  const queryIndex = payload.indexOf('?')
  const encodedAddress = queryIndex === -1 ? payload : payload.slice(0, queryIndex)
  let address = ''

  try {
    address = decodeURIComponent(encodedAddress).trim()
  } catch {
    throw new QbitUriParseError('INVALID_URI', 'Invalid qbit: URI')
  }

  if (!address) {
    throw new QbitUriParseError('INVALID_URI', 'Invalid qbit: URI')
  }

  const parsed: QbitUri = { address }

  if (queryIndex !== -1) {
    const query = payload.slice(queryIndex + 1)
    const params = new URLSearchParams(query)
    const rawAmount = params.get('amount')
    const amount = rawAmount?.trim()

    if (rawAmount !== null) {
      if (!amount) {
        throw new QbitUriParseError('INVALID_AMOUNT', 'Invalid qbit: URI amount')
      }
      assertValidQbitAmount(amount)
      parsed.amount = amount
    }
    const label = params.get('label')
    if (label !== null) parsed.label = label
  }

  return parsed
}

function formatQbitAmount(amount: string | number) {
  if (typeof amount === 'string') {
    return amount.trim()
  }

  const amountText = String(amount)
  if (!amountText.toLowerCase().includes('e')) {
    return amountText.trim()
  }

  const [coefficient = '', exponentText = ''] = amountText.toLowerCase().split('e')
  const exponent = Number(exponentText)
  if (!coefficient || !Number.isInteger(exponent)) {
    return amountText.trim()
  }

  const negative = coefficient.startsWith('-')
  const unsignedCoefficient = negative ? coefficient.slice(1) : coefficient
  const [integerPart = '', fractionalPart = ''] = unsignedCoefficient.split('.')
  const digits = `${integerPart}${fractionalPart}`
  const decimalIndex = integerPart.length + exponent

  if (decimalIndex <= 0) {
    return `${negative ? '-' : ''}0.${'0'.repeat(Math.abs(decimalIndex))}${digits}`
  }

  if (decimalIndex >= digits.length) {
    return `${negative ? '-' : ''}${digits}${'0'.repeat(decimalIndex - digits.length)}`
  }

  return `${negative ? '-' : ''}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`
}

export function formatQbitUri(
  address: string,
  options: { amount?: string | number; label?: string } = {}
) {
  const trimmedAddress = address.trim()
  if (!trimmedAddress) {
    return ''
  }

  const amount = options.amount === undefined ? undefined : formatQbitAmount(options.amount)
  const hasAmount = amount !== undefined && amount !== ''
  const hasLabel = options.label !== undefined
  if (options.amount !== undefined && !hasAmount) {
    throw new QbitUriParseError('INVALID_AMOUNT', 'Invalid qbit: URI amount')
  }
  if (!hasAmount && !hasLabel) {
    return `${QBIT_URI_SCHEME}:${trimmedAddress}`
  }

  const params = new URLSearchParams()
  if (hasAmount) {
    assertValidQbitAmount(amount)
    params.set('amount', amount)
  }
  if (hasLabel) params.set('label', options.label!)
  return `${QBIT_URI_SCHEME}:${trimmedAddress}?${params.toString()}`
}
