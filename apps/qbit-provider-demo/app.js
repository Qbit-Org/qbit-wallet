'use strict'

const TESTNET4_CHAIN = 'QBIT_TESTNET4'
const HAS_STABLE_ORIGIN = window.location.origin !== 'null'
const REQUIRED_PROVIDER_METHODS = Object.freeze([
  'on',
  'requestAccounts',
  'getAccounts',
  'getPublicKey',
  'getBalance',
  'getNetwork',
  'switchNetwork',
  'getChain',
  'switchChain',
  'signMessage',
  'verifyMessage',
  'signPsbt',
  'signPsbts',
  'pushPsbt',
  'pushTx',
  'sendQbit',
  'disconnect',
  'removeListener',
])
const FORMAT_FIXTURE = Object.freeze({
  signerPublicKey: '01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da',
  psbtHex:
    '70736274ff01005e020000000109090909090909090909090909090909090909090909090909090909090909090000000000fdffffff01905f010000000000225220afb1c56c80c30a5fab4723194d55cd51dc3671aab200356de84d4deefa3d7e38000000000001012ba086010000000000225220afb1c56c80c30a5fab4723194d55cd51dc3671aab200356de84d4deefa3d7e38021dc1232001080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dab3c007fc04716269740120afb1c56c80c30a5fab4723194d55cd51dc3671aab200356de84d4deefa3d7e380000',
})

const state = {
  provider: null,
  listenersAttached: false,
  accounts: [],
  publicKey: '',
  network: '',
  chain: '',
  proof: null,
  proofMessage: '',
  signedPsbt: '',
}

const elements = Object.fromEntries(
  [
    'origin',
    'provider-status',
    'account',
    'public-key',
    'network',
    'chain',
    'page-status',
    'detect-provider',
    'connect',
    'switch-chain',
    'message',
    'sign-message',
    'verify-message',
    'message-proof',
    'verification-result',
    'psbt',
    'load-fixture',
    'clear-psbt',
    'fixture-warning',
    'fixture-public-key',
    'sign-psbt',
    'signed-psbt',
    'confirm-broadcast',
    'broadcast',
    'transaction-id',
    'disconnect',
    'event-log',
    'clear-log',
  ].map(id => [id, document.getElementById(id)])
)

function stringify(value) {
  if (typeof value === 'string') return value
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item), 2)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function contextSnapshot() {
  return {
    origin: window.location.origin,
    account: state.accounts[0] ?? null,
    network: state.network || null,
    chain: state.chain || null,
  }
}

function appendLog(kind, detail, tone = 'call') {
  const item = document.createElement('li')
  item.className = 'event-entry'
  item.dataset.tone = tone

  const time = document.createElement('time')
  time.dateTime = new Date().toISOString()
  time.textContent = new Date().toLocaleTimeString()

  const label = document.createElement('span')
  label.className = 'event-entry__kind'
  label.textContent = kind

  const value = document.createElement('pre')
  value.className = 'event-entry__detail mono'
  value.textContent = stringify(detail)

  item.append(time, label, value)
  elements['event-log'].prepend(item)
}

function setStatus(message, tone = 'neutral') {
  elements['page-status'].textContent = message
  elements['page-status'].dataset.tone = tone
}

function setBusy(button, busy, busyLabel) {
  if (busy) {
    button.dataset.label = button.textContent
    button.textContent = busyLabel
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    return
  }

  button.textContent = button.dataset.label || button.textContent
  button.removeAttribute('aria-busy')
  delete button.dataset.label
  render()
}

async function perform(button, busyLabel, actionName, action) {
  setBusy(button, true, busyLabel)
  setStatus(`${actionName} is awaiting the wallet…`)
  try {
    const result = await action()
    setStatus(`${actionName} completed.`, 'success')
    appendLog(actionName, { context: contextSnapshot(), result })
    return result
  } catch (error) {
    const message = errorMessage(error)
    setStatus(`${actionName} failed: ${message}`, 'error')
    appendLog(actionName, { context: contextSnapshot(), error: message }, 'error')
    return undefined
  } finally {
    setBusy(button, false, busyLabel)
  }
}

function clearProof() {
  state.proof = null
  state.proofMessage = ''
  elements['message-proof'].textContent = 'No proof yet.'
  elements['verification-result'].textContent = ''
  delete elements['verification-result'].dataset.tone
}

function clearSignedPsbt() {
  state.signedPsbt = ''
  elements['signed-psbt'].textContent = 'No signed PSBT yet.'
  elements['transaction-id'].textContent = 'Not broadcast.'
  elements['confirm-broadcast'].checked = false
}

function clearConnectedState() {
  state.accounts = []
  state.publicKey = ''
  state.network = ''
  state.chain = ''
  clearProof()
  clearSignedPsbt()
}

function isHexPsbt(value) {
  const normalized = value.trim()
  return (
    normalized.length > 10 &&
    normalized.length % 2 === 0 &&
    /^70736274ff[0-9a-f]+$/i.test(normalized)
  )
}

function render() {
  const hasProvider = Boolean(state.provider)
  const connected = state.accounts.length > 0
  const onTestnet4 = state.chain === TESTNET4_CHAIN
  const hasPsbt = isHexPsbt(elements.psbt.value)

  elements['provider-status'].textContent = hasProvider ? 'window.qbit detected' : 'Not detected'
  elements['provider-status'].classList.toggle('muted', !hasProvider)
  elements.account.textContent = state.accounts[0] || 'Not connected'
  elements.account.classList.toggle('muted', !connected)
  elements['public-key'].textContent = state.publicKey || 'Not available'
  elements['public-key'].classList.toggle('muted', !state.publicKey)
  elements.network.textContent = state.network || 'Unknown'
  elements.network.classList.toggle('muted', !state.network)
  elements.chain.textContent = state.chain || 'Unknown'
  elements.chain.classList.toggle('muted', !state.chain)

  elements.connect.disabled = !hasProvider || !HAS_STABLE_ORIGIN || connected
  elements['switch-chain'].disabled = !connected || onTestnet4
  elements['sign-message'].disabled = !connected || !onTestnet4 || !elements.message.value
  elements['verify-message'].disabled = !connected || !state.proof
  elements['sign-psbt'].disabled = !connected || !onTestnet4 || !hasPsbt
  elements.broadcast.disabled =
    !connected || !onTestnet4 || !state.signedPsbt || !elements['confirm-broadcast'].checked
  elements.disconnect.disabled = !connected
}

async function refreshProviderContext() {
  if (!state.provider) return
  const [accounts, publicKey, network, chain] = await Promise.all([
    state.provider.getAccounts(),
    state.provider.getPublicKey(),
    state.provider.getNetwork(),
    state.provider.getChain(),
  ])

  state.accounts = accounts
  state.publicKey = publicKey
  state.network = network
  state.chain = chain
  render()
}

function handleContextChange(kind, payload) {
  clearProof()
  clearSignedPsbt()
  render()
  appendLog(kind, { origin: window.location.origin, payload }, 'event')
}

function attachEventListeners() {
  if (!state.provider || state.listenersAttached) return

  state.provider.on('accountsChanged', accounts => {
    state.accounts = accounts
    state.publicKey = ''
    handleContextChange('accountsChanged', accounts)
  })
  state.provider.on('networkChanged', network => {
    state.network = network
    handleContextChange('networkChanged', network)
  })
  state.provider.on('chainChanged', chain => {
    state.chain = chain
    handleContextChange('chainChanged', chain)
  })
  state.provider.on('disconnect', () => {
    clearConnectedState()
    render()
    appendLog('disconnect', { origin: window.location.origin }, 'event')
  })

  state.listenersAttached = true
}

async function detectProvider() {
  const candidate = window.qbit
  const descriptor = Object.getOwnPropertyDescriptor(window, 'qbit')
  const hasImmutableBoundary = Boolean(
    descriptor?.value === candidate &&
      descriptor.configurable === false &&
      descriptor.writable === false &&
      candidate &&
      Object.isFrozen(candidate)
  )
  const missingMethods = candidate
    ? REQUIRED_PROVIDER_METHODS.filter(method => typeof candidate[method] !== 'function')
    : REQUIRED_PROVIDER_METHODS
  if (!candidate || missingMethods.length > 0 || !hasImmutableBoundary) {
    state.provider = null
    setStatus(
      missingMethods.length > 0 && candidate
        ? `The detected provider is missing canonical methods: ${missingMethods.join(', ')}.`
        : candidate && !hasImmutableBoundary
          ? 'A mutable or replaceable window.qbit value was detected. Refusing to use it.'
          : 'The canonical Qbit provider is not available. Load the development extension and retry.',
      'error'
    )
    render()
    return
  }

  if (state.provider !== candidate) state.listenersAttached = false
  state.provider = candidate
  attachEventListeners()
  if (!HAS_STABLE_ORIGIN) {
    setStatus(
      'This page has an opaque origin. Serve it over local HTTP before connecting.',
      'error'
    )
  } else {
    setStatus('Canonical provider detected. Connect to begin.', 'success')
  }
  appendLog('providerDetected', { origin: window.location.origin }, 'event')
  render()
}

elements['detect-provider'].addEventListener('click', detectProvider)

elements.connect.addEventListener('click', async () => {
  await perform(elements.connect, 'Connecting…', 'requestAccounts', async () => {
    const accounts = await state.provider.requestAccounts()
    state.accounts = accounts
    await refreshProviderContext()
    return contextSnapshot()
  })
})

elements['switch-chain'].addEventListener('click', async () => {
  await perform(elements['switch-chain'], 'Switching…', 'switchChain', async () => {
    const chain = await state.provider.switchChain(TESTNET4_CHAIN)
    await refreshProviderContext()
    return chain
  })
})

elements.message.addEventListener('input', () => {
  if (elements.message.value !== state.proofMessage) clearProof()
  render()
})

elements['sign-message'].addEventListener('click', async () => {
  await perform(elements['sign-message'], 'Signing…', 'signMessage', async () => {
    if (state.chain !== TESTNET4_CHAIN) throw new Error('Active chain is not QBIT_TESTNET4')
    const message = elements.message.value
    if (!message) throw new Error('Message is empty')

    const accountAtApproval = state.accounts[0]
    const proof = await state.provider.signMessage(message)
    if (message !== elements.message.value || accountAtApproval !== state.accounts[0]) {
      throw new Error('Message or account changed while approval was open; proof discarded')
    }

    state.proof = proof
    state.proofMessage = message
    elements['message-proof'].textContent = stringify(proof)
    render()
    return proof
  })
})

elements['verify-message'].addEventListener('click', async () => {
  await perform(elements['verify-message'], 'Verifying…', 'verifyMessage', async () => {
    if (!state.proof || elements.message.value !== state.proofMessage) {
      throw new Error('The message changed after signing')
    }

    const verified = await state.provider.verifyMessage(
      state.accounts[0],
      state.proofMessage,
      state.proof
    )
    elements['verification-result'].textContent = verified
      ? 'Proof valid for the connected account and exact message.'
      : 'Proof rejected.'
    elements['verification-result'].dataset.tone = verified ? 'success' : 'error'
    return verified
  })
})

elements['load-fixture'].addEventListener('click', () => {
  elements.psbt.value = FORMAT_FIXTURE.psbtHex
  elements['fixture-warning'].hidden = false
  clearSignedPsbt()
  render()
  appendLog('fixtureLoaded', {
    origin: window.location.origin,
    signerPublicKey: FORMAT_FIXTURE.signerPublicKey,
    limitation: 'Fictional prevout; format validation only',
  })
})

elements['clear-psbt'].addEventListener('click', () => {
  elements.psbt.value = ''
  elements['fixture-warning'].hidden = true
  clearSignedPsbt()
  render()
})

elements.psbt.addEventListener('input', () => {
  elements['fixture-warning'].hidden = elements.psbt.value.trim() !== FORMAT_FIXTURE.psbtHex
  clearSignedPsbt()
  render()
})

elements['sign-psbt'].addEventListener('click', async () => {
  await perform(elements['sign-psbt'], 'Signing…', 'signPsbt', async () => {
    if (state.chain !== TESTNET4_CHAIN) throw new Error('Active chain is not QBIT_TESTNET4')
    const psbtHex = elements.psbt.value.trim()
    if (!isHexPsbt(psbtHex)) {
      throw new Error('PSBT must be canonical hex beginning with 70736274ff')
    }

    const approvalContext = contextSnapshot()
    const signedPsbt = await state.provider.signPsbt(psbtHex, {
      chain: state.chain,
      autoFinalized: true,
    })
    if (
      psbtHex !== elements.psbt.value.trim() ||
      approvalContext.account !== state.accounts[0] ||
      approvalContext.chain !== state.chain
    ) {
      throw new Error('PSBT, account, or chain changed while approval was open; result discarded')
    }

    state.signedPsbt = signedPsbt
    elements['signed-psbt'].textContent = signedPsbt
    render()
    return { signedPsbtLength: signedPsbt.length, chain: state.chain }
  })
})

elements['confirm-broadcast'].addEventListener('change', render)

elements.broadcast.addEventListener('click', async () => {
  await perform(elements.broadcast, 'Broadcasting…', 'pushPsbt', async () => {
    if (!elements['confirm-broadcast'].checked) {
      throw new Error('Broadcast confirmation is required')
    }

    const activeChain = await state.provider.getChain()
    if (activeChain !== TESTNET4_CHAIN || state.chain !== TESTNET4_CHAIN) {
      throw new Error('Active chain changed; refusing to broadcast outside QBIT_TESTNET4')
    }

    const transactionId = await state.provider.pushPsbt(state.signedPsbt)
    elements['transaction-id'].textContent = transactionId
    return { transactionId, chain: activeChain }
  })
})

elements.disconnect.addEventListener('click', async () => {
  await perform(elements.disconnect, 'Revoking…', 'disconnect', async () => {
    await state.provider.disconnect()
    clearConnectedState()
    render()
    return { origin: window.location.origin, revoked: true }
  })
})

elements['clear-log'].addEventListener('click', () => {
  elements['event-log'].replaceChildren()
})

elements.origin.textContent = window.location.origin
elements['fixture-public-key'].textContent = FORMAT_FIXTURE.signerPublicKey
render()
detectProvider()
