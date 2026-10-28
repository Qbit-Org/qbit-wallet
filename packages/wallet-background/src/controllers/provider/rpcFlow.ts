import 'reflect-metadata'

import {
  BUS_EVENTS,
  BUS_METHODS,
  ErrorCodes,
  QbitExternalSigningLock,
  QbitSendBroadcastClaim,
  WalletError,
} from '@qbit/wallet-shared'
import { keyringService, permissionService } from '../../services'
import { PromiseFlow } from '../../utils'

import providerController from './controller'
import { isPublicProviderMethod } from './methodList'
import wallet from '../wallet'

import { ChainType } from '@qbit/wallet-types'
import approvalService from 'src/services/approval'
import { bgEventBus } from 'src/utils/eventBus'

class UnlockManager {
  private unlockPromise: Promise<any> | null = null
  private isUnlocking = false

  async getUnlockPromise(): Promise<any> {
    if (keyringService.memStore.getState().isUnlocked) {
      return Promise.resolve()
    }

    if (this.isUnlocking && this.unlockPromise) {
      return this.unlockPromise
    }

    this.isUnlocking = true
    this.unlockPromise = approvalService.requestApproval({ lock: true }).finally(() => {
      this.isUnlocking = false
      this.unlockPromise = null
    })

    return this.unlockPromise
  }
}

const unlockManager = new UnlockManager()

const isSignApproval = (type: string) => {
  const SIGN_APPROVALS = ['SignMessage', 'SignPsbt']
  return SIGN_APPROVALS.includes(type)
}

const QBIT_CHAINS = new Set<ChainType>([
  ChainType.QBIT_MAINNET,
  ChainType.QBIT_TESTNET4,
  ChainType.QBIT_REGTEST,
])
const QBIT_NETWORKS = new Set(['mainnet', 'testnet4', 'regtest'])
const METHODS_WITHOUT_PERMISSION = new Set([
  'getNetwork',
  'getChain',
  'verifyMessage',
  'disconnect',
])

const PARAM_KEYS: Record<string, readonly string[]> = {
  switchNetwork: ['network'],
  switchChain: ['chain'],
  signMessage: ['text'],
  verifyMessage: ['address', 'text', 'proof'],
  signPsbt: ['psbtHex', 'options'],
  signPsbts: ['psbtHexs', 'options'],
  pushPsbt: ['psbtHex'],
  pushTx: ['rawtx'],
  sendQbit: ['sendQbitParams'],
}
const SIGN_PSBT_OPTION_KEYS: readonly string[] = ['chain', 'autoFinalized']
const MAX_SIGN_PSBTS = 20

/**
 * One signPsbt options object: only the documented keys, so a dapp cannot
 * believe it restricted signing with a key the wallet ignores, and a
 * boolean `autoFinalized`. Its `chain` is checked against the active chain
 * in validateRequestBeforeApproval.
 */
function assertSignPsbtOptions(method: string, options: unknown): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new WalletError(ErrorCodes.INVALID_PARAMS, `${method} options must be an object`)
  }
  if (Object.keys(options).some(key => !SIGN_PSBT_OPTION_KEYS.includes(key))) {
    throw new WalletError(ErrorCodes.INVALID_PARAMS, `${method} received unsupported options`)
  }
  const { autoFinalized } = options as { autoFinalized?: unknown }
  if (autoFinalized !== undefined && typeof autoFinalized !== 'boolean') {
    throw new WalletError(
      ErrorCodes.INVALID_PARAMS,
      `${method} options.autoFinalized must be a boolean`
    )
  }
}

function assertCanonicalParams(method: string, params: unknown): void {
  const allowedKeys = PARAM_KEYS[method]
  if (!allowedKeys) {
    if (params !== undefined) {
      throw new WalletError(ErrorCodes.INVALID_PARAMS, `${method} does not accept parameters`)
    }
    return
  }

  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new WalletError(ErrorCodes.INVALID_PARAMS, `${method} requires an object parameter`)
  }
  const keys = Object.keys(params)
  if (keys.some(key => !allowedKeys.includes(key))) {
    throw new WalletError(ErrorCodes.INVALID_PARAMS, `${method} received unsupported parameters`)
  }

  if (method === 'sendQbit') {
    const send = (params as { sendQbitParams?: unknown }).sendQbitParams
    const sendKeys = ['toAddress', 'satoshis', 'feeRate', 'memo', 'memos']
    if (!send || typeof send !== 'object' || Array.isArray(send)) {
      throw new WalletError(ErrorCodes.INVALID_PARAMS, 'sendQbitParams must be an object')
    }
    if (Object.keys(send).some(key => !sendKeys.includes(key))) {
      throw new WalletError(ErrorCodes.INVALID_PARAMS, 'sendQbit received unsupported parameters')
    }
  }

  if (method === 'signPsbt') {
    assertSignPsbtOptions(method, (params as { options?: unknown }).options)
  }
  if (method === 'signPsbts') {
    const { psbtHexs, options } = params as { psbtHexs?: unknown; options?: unknown }
    if (
      !Array.isArray(psbtHexs) ||
      !Array.isArray(options) ||
      psbtHexs.length === 0 ||
      psbtHexs.length > MAX_SIGN_PSBTS ||
      options.length !== psbtHexs.length
    ) {
      throw new WalletError(
        ErrorCodes.INVALID_PARAMS,
        `signPsbts requires one options entry for each of 1-${MAX_SIGN_PSBTS} PSBTs`
      )
    }
    // Indexed, so a hole in a sparse array is checked like any other entry.
    for (let index = 0; index < options.length; index += 1) {
      assertSignPsbtOptions(method, options[index])
    }
  }
}

function activeQbitChain(): ChainType {
  const chain = wallet.getChainType()
  if (!QBIT_CHAINS.has(chain)) {
    throw new WalletError(
      ErrorCodes.UNSUPPORTED_NETWORK,
      'Active chain is not supported by Qbit provider V1'
    )
  }
  return chain
}

function activeQbitNetwork(chain: ChainType): 'mainnet' | 'testnet4' | 'regtest' {
  if (chain === ChainType.QBIT_MAINNET) return 'mainnet'
  if (chain === ChainType.QBIT_REGTEST) return 'regtest'
  return 'testnet4'
}

function validateRequestBeforeApproval(request: any, chain: ChainType) {
  const { method, params } = request.data
  if (method === 'switchChain' && !QBIT_CHAINS.has(params?.chain)) {
    throw new WalletError(ErrorCodes.UNSUPPORTED_NETWORK, 'Unsupported Qbit chain')
  }
  if (method === 'switchNetwork' && !QBIT_NETWORKS.has(params?.network)) {
    throw new WalletError(ErrorCodes.UNSUPPORTED_NETWORK, 'Unsupported Qbit network')
  }
  if (method === 'signPsbt') {
    if (!QBIT_CHAINS.has(params?.options?.chain) || params.options.chain !== chain) {
      throw new WalletError(
        ErrorCodes.UNSUPPORTED_NETWORK,
        'PSBT signing chain does not match the active Qbit chain'
      )
    }
  }
  if (method === 'signPsbts') {
    // assertCanonicalParams rejects a malformed batch first, with -32602.
    if (
      !Array.isArray(params?.options) ||
      params.options.some(option => !QBIT_CHAINS.has(option?.chain) || option.chain !== chain)
    ) {
      throw new WalletError(
        ErrorCodes.UNSUPPORTED_NETWORK,
        'Every PSBT signing option must match the active Qbit chain'
      )
    }
  }
}

async function captureRequestContext(origin: string) {
  const chain = activeQbitChain()
  const account = keyringService.hasVault() ? await wallet.getCurrentAccount() : undefined
  return {
    origin,
    chain,
    network: activeQbitNetwork(chain),
    account: account?.address || '',
  }
}

async function assertRequestContext(
  snapshot: Awaited<ReturnType<typeof captureRequestContext>>,
  requirePermission = false
) {
  const current = await captureRequestContext(snapshot.origin)
  if (
    current.chain !== snapshot.chain ||
    current.network !== snapshot.network ||
    current.account !== snapshot.account
  ) {
    throw new Error('Qbit provider context changed during approval')
  }
  if (requirePermission && !permissionService.hasPermission(snapshot.origin, snapshot.chain)) {
    throw new WalletError(
      ErrorCodes.UNAUTHORIZED,
      'Qbit provider permission was revoked or changed during approval'
    )
  }
}

function canonicalApprovalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value
  }
  if (value === undefined) return { $undefined: true }
  if (typeof value === 'bigint') return { $bigint: value.toString() }
  if (Array.isArray(value)) return value.map(canonicalApprovalValue)
  if (value instanceof Uint8Array) {
    return { $bytes: Array.from(value) }
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map(key => [key, canonicalApprovalValue((value as Record<string, unknown>)[key])])
    )
  }
  throw new Error('Unsupported approval payload value')
}

function approvalPayloadSnapshot(value: unknown): string {
  return JSON.stringify(canonicalApprovalValue(value))
}

function sameQbitExternalSigningLock(
  left: QbitExternalSigningLock | undefined,
  right: QbitExternalSigningLock | undefined
): left is QbitExternalSigningLock {
  return Boolean(
    left &&
      right &&
      left.id === right.id &&
      left.purpose === right.purpose &&
      left.chain === right.chain &&
      left.address === right.address &&
      left.origin === right.origin &&
      left.entries.length === right.entries.length &&
      left.entries.every((entry, entryIndex) => {
        const other = right.entries[entryIndex]
        return Boolean(
          other &&
            entry.txid === other.txid &&
            entry.outpoints.length === other.outpoints.length &&
            entry.outpoints.every(
              (outpoint, outpointIndex) =>
                outpoint.txid === other.outpoints[outpointIndex]?.txid &&
                outpoint.vout === other.outpoints[outpointIndex]?.vout
            )
        )
      })
  )
}

function externalQbitSigningLockForCleanup(ctx: any): QbitExternalSigningLock | undefined {
  const purposes = {
    sendQbit: 'send',
    signPsbt: 'sign',
    signPsbts: 'sign',
  } as const
  const purpose = purposes[ctx.mapMethod as keyof typeof purposes]
  if (!purpose) return
  const toSignDatas = ctx.request.data.params?.toSignDatas
  if (!Array.isArray(toSignDatas) || toSignDatas.length === 0) return
  const lock = toSignDatas[0]?.qbitExternalSigningLock as QbitExternalSigningLock | undefined
  const context = ctx.requestContext
  if (
    !lock ||
    lock.purpose !== purpose ||
    lock.chain !== context?.chain ||
    lock.origin !== context?.origin ||
    lock.origin !== ctx.request.session.origin ||
    toSignDatas.some(
      toSignData => !sameQbitExternalSigningLock(lock, toSignData?.qbitExternalSigningLock)
    )
  ) {
    return
  }
  return lock
}

/**
 * The claim a sendQbit approval carries, as its approval condition minted
 * it: the background builds the request's single entry, and the dapp's own
 * parameters cannot name one. It must be for this request's origin and
 * chain.
 */
function requestedQbitSendBroadcastClaim(ctx: any): QbitSendBroadcastClaim {
  const toSignDatas = ctx.request.data.params?.toSignDatas
  const claim =
    Array.isArray(toSignDatas) && toSignDatas.length === 1
      ? (toSignDatas[0]?.qbitSendBroadcastClaim as QbitSendBroadcastClaim | undefined)
      : undefined
  const context = ctx.requestContext
  if (
    !claim ||
    claim.chain !== context?.chain ||
    claim.origin !== context?.origin ||
    claim.origin !== ctx.request.session.origin
  ) {
    throw new Error('invalid Qbit send broadcast claim')
  }
  return claim
}

/**
 * The sendQbit broadcast of `claim`'s own transaction ended without a
 * verdict (see `broadcastQbitProviderSend`): the node may hold it, so its
 * inputs must stay reserved.
 */
function isQbitBroadcastOutcomeUnknownFor(error: unknown, claim: QbitSendBroadcastClaim): boolean {
  const { code, data } = (error ?? {}) as {
    code?: unknown
    data?: { chain?: unknown; txid?: unknown }
  }
  return (
    code === ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN &&
    data?.chain === claim.chain &&
    data?.txid === claim.txid
  )
}

/**
 * Settle the sendQbit request `ctx` opened, and with it the send claim its
 * approval registered, whether the approval was answered or not: the user
 * can reject it, or its window close, after the signature registered the
 * claim. Every failure before the broadcast, and a broadcast proven not
 * sent, release the claim: the inputs are free for another send. When the
 * broadcast may have reached the node, and after a successful one, the
 * claim goes but its inputs stay reserved as recently spent, until a
 * lifecycle probe finds the transaction confirmed or gone.
 */
async function settleQbitSendRequest(ctx: any, failure?: { error: unknown }): Promise<void> {
  const request = ctx.qbitProviderSendRequest
  if (!request) return
  const spent =
    !failure || isQbitBroadcastOutcomeUnknownFor(failure.error, ctx.qbitSendBroadcastClaim)
  await wallet.settleQbitProviderSendRequest(request, spent)
}

async function cleanupFailedExternalQbitSigningLock(ctx: any): Promise<void> {
  const lock = externalQbitSigningLockForCleanup(ctx)
  if (lock) {
    await wallet.releaseExternalQbitSigningLock(lock)
  }
}

function qbitRestoredFloorChallengeIdsForCleanup(ctx: any): string[] {
  const params = ctx.request?.data?.params
  const toSignEntries = [
    ...(Array.isArray(params?.toSignDatas) ? params.toSignDatas : []),
    ...(Array.isArray(params?.toSignMessages) ? params.toSignMessages : []),
  ]
  const challengeIds = new Set<string>()
  for (const entry of toSignEntries) {
    const challengeId = entry?.signatureBudget?.restoredFloorRisk?.challengeId
    if (typeof challengeId === 'string' && challengeId.length > 0) {
      challengeIds.add(challengeId)
    }
  }
  return [...challengeIds]
}

async function cleanupFailedQbitRestoredFloorChallenges(ctx: any): Promise<void> {
  const challengeIds = qbitRestoredFloorChallengeIdsForCleanup(ctx)
  if (challengeIds.length > 0) {
    await wallet.releaseQbitRestoredFloorSigningChallenges(challengeIds)
  }
}
const windowHeight = 600
const flow = new PromiseFlow()
const flowContext = flow
  .use(async (ctx, next) => {
    // check method
    const {
      data: { method },
    } = ctx.request
    if (!isPublicProviderMethod(method)) {
      throw new WalletError(ErrorCodes.METHOD_NOT_FOUND, `Method [${String(method)}] not found`)
    }
    ctx.mapMethod = method
    assertCanonicalParams(method, ctx.request.data.params)

    if (typeof providerController[ctx.mapMethod] !== 'function') {
      throw new WalletError(ErrorCodes.METHOD_NOT_FOUND, `Method [${method}] not found`)
    }

    const chain = activeQbitChain()
    validateRequestBeforeApproval(ctx.request, chain)

    return next()
  })
  .use(async (ctx, next) => {
    const { mapMethod } = ctx
    if (!Reflect.getMetadata('SAFE', providerController, mapMethod)) {
      // check lock
      const isUnlock = keyringService.memStore.getState().isUnlocked

      if (!isUnlock) {
        ctx.request.requestedApproval = true
        await unlockManager.getUnlockPromise()
      }
    }

    return next()
  })
  .use(async (ctx, next) => {
    // check connect
    const {
      request: {
        session: { origin, name, icon },
      },
      mapMethod,
    } = ctx
    const chain = activeQbitChain()
    if (!METHODS_WITHOUT_PERMISSION.has(mapMethod)) {
      if (!permissionService.hasPermission(origin, chain)) {
        if (mapMethod === 'getAccounts') {
          return []
        }
        if (mapMethod !== 'requestAccounts') {
          throw new WalletError(
            ErrorCodes.UNAUTHORIZED,
            'Origin is not connected to the active Qbit chain'
          )
        }
        const context = await captureRequestContext(origin)
        ctx.request.requestedApproval = true
        await approvalService.requestApproval(
          {
            params: {
              method: 'connect',
              data: {
                context,
                permissions: ['account', 'chain', 'network'],
              },
              session: { origin, name, icon },
            },
            approvalComponent: 'Connect',
          },
          { height: windowHeight }
        )
        await assertRequestContext(context)
        await permissionService.addConnectedSite(origin, name, icon, chain)
      }
    }
    ctx.requirePermission = !METHODS_WITHOUT_PERMISSION.has(mapMethod)

    return next()
  })
  .use(async (ctx, next) => {
    // check need approval
    const {
      request: {
        data: { params, method },
        session: { origin, name, icon },
      },
      mapMethod,
    } = ctx
    ctx.requestContext = await captureRequestContext(origin)
    ctx.request.providerContext = ctx.requestContext
    const [approvalType, condition] =
      Reflect.getMetadata('APPROVAL', providerController, mapMethod) || []

    let skipApproval = false
    if (condition) {
      skipApproval = await condition(ctx.request)
    }
    if (mapMethod === 'sendQbit') {
      // Before the approval is shown: signing it registers the claim under
      // this request, which settles it however the request ends.
      ctx.qbitSendBroadcastClaim = requestedQbitSendBroadcastClaim(ctx)
      ctx.qbitProviderSendRequest = await wallet.openQbitProviderSendRequest(
        ctx.qbitSendBroadcastClaim
      )
    }

    await assertRequestContext(ctx.requestContext, ctx.requirePermission)

    if (approvalType && skipApproval != true) {
      ctx.approvalPayloadSnapshot = approvalPayloadSnapshot({
        method,
        params,
        context: ctx.requestContext,
      })
      ctx.request.requestedApproval = true
      ctx.approvalRes = await approvalService.requestApproval(
        {
          approvalComponent: approvalType,
          params: {
            method,
            data: params,
            context: ctx.requestContext,
            session: { origin, name, icon },
          },
          origin,
        },
        { height: windowHeight }
      )
      await assertRequestContext(ctx.requestContext, ctx.requirePermission)
      if (
        ctx.approvalPayloadSnapshot !==
        approvalPayloadSnapshot({ method, params, context: ctx.requestContext })
      ) {
        throw new Error('Qbit approval payload changed while awaiting approval')
      }
      if (isSignApproval(approvalType)) {
        await permissionService.updateConnectSite(origin, { isSigned: true }, true)
      } else {
        await permissionService.touchConnectedSite(origin)
      }
    }

    return next()
  })
  .use(async ctx => {
    const { approvalRes, mapMethod, request } = ctx
    // process request
    const [approvalType] = Reflect.getMetadata('APPROVAL', providerController, mapMethod) || []

    const { uiRequestComponent, ...rest } = approvalRes || {}
    const {
      session: { origin },
    } = request
    const requestDefer = assertRequestContext(ctx.requestContext, ctx.requirePermission).then(
      () => {
        if (
          ctx.approvalPayloadSnapshot &&
          ctx.approvalPayloadSnapshot !==
            approvalPayloadSnapshot({
              method: request.data.method,
              params: request.data.params,
              context: ctx.requestContext,
            })
        ) {
          throw new Error('Qbit approval payload changed before execution')
        }
        return providerController[mapMethod]({
          ...request,
          approvalRes,
        })
      }
    )

    requestDefer
      .then(result => {
        if (isSignApproval(approvalType)) {
          bgEventBus.emit(BUS_EVENTS.broadcastToUI, {
            method: BUS_METHODS.SIGN_FINISHED,
            params: {
              success: true,
              data: result,
            },
          })
        }
        return result
      })
      .catch((e: any) => {
        if (isSignApproval(approvalType)) {
          bgEventBus.emit(BUS_EVENTS.broadcastToUI, {
            method: BUS_METHODS.SIGN_FINISHED,
            params: {
              success: false,
              errorMsg: JSON.stringify(e),
            },
          })
        }
      })

    async function requestApprovalLoop({ uiRequestComponent, ...rest }) {
      ctx.request.requestedApproval = true
      const res = await approvalService.requestApproval({
        approvalComponent: uiRequestComponent,
        params: rest,
        origin,
        approvalType,
      })
      if (res.uiRequestComponent) {
        return await requestApprovalLoop(res)
      } else {
        return res
      }
    }

    if (uiRequestComponent) {
      ctx.request.requestedApproval = true
      return await requestApprovalLoop({ uiRequestComponent, ...rest })
    }

    return requestDefer
  })
  .callback()

export default request => {
  const ctx: any = { request: { ...request, requestedApproval: false } }
  return flowContext(ctx)
    .then(
      result => {
        // Not awaited, so a sent transaction's answer never waits on the send
        // guard; the settle is queued before the answer goes out, so the
        // dapp's next request is decided after it.
        settleQbitSendRequest(ctx).catch(cleanupError => {
          console.error(
            'Failed to settle Qbit send broadcast claim after request success',
            cleanupError
          )
        })
        return result
      },
      async error => {
        try {
          await cleanupFailedExternalQbitSigningLock(ctx)
        } catch (cleanupError) {
          console.error(
            'Failed to clean up external Qbit signing lock after request failure',
            cleanupError
          )
        }
        try {
          await settleQbitSendRequest(ctx, { error })
        } catch (cleanupError) {
          console.error(
            'Failed to clean up Qbit send broadcast claim after request failure',
            cleanupError
          )
        }
        try {
          await cleanupFailedQbitRestoredFloorChallenges(ctx)
        } catch (cleanupError) {
          console.error(
            'Failed to release Qbit restored-floor signing challenges after request failure',
            cleanupError
          )
        }
        throw error
      }
    )
    .finally(() => {
      if (ctx.request.requestedApproval) {
        flow.requestedApproval = false
        // only unlock notification if current flow is an approval flow
        approvalService.unLock()
      }
    })
}
