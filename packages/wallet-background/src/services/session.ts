import permissionService from './permission'
import { SESSION_EVENTS } from '@qbit/wallet-shared'
import type { ChainType } from '@qbit/wallet-types'

export interface SessionData {
  origin: string
  icon: string
  name: string
}

export class Session {
  origin = ''
  icon = ''
  name = ''

  constructor(data?: SessionData) {
    if (data) {
      this.setProp(data)
    }
  }

  setProp({ origin, icon, name }: SessionData) {
    this.origin = origin
    this.icon = icon
    this.name = name
  }
}

export type SessionKey = string | number | object

// Provider transports use their Port object as the key so two documents in the
// same tab cannot share mutable origin or push-message state.
const sessionMap = new Map<SessionKey, Session>()
const tabSessionMap = new Map<number, SessionKey[]>()

const getSession = (id: SessionKey): Session | undefined => {
  const tabSessionKeys = typeof id === 'number' ? tabSessionMap.get(id) : undefined
  const sessionKey = tabSessionKeys?.length ? tabSessionKeys[tabSessionKeys.length - 1]! : id
  return sessionMap.get(sessionKey)
}

const getOrCreateSession = (id: SessionKey, tabId?: number): Session => {
  let session: Session
  if (sessionMap.has(id)) {
    session = sessionMap.get(id)!
  } else {
    session = createSession(id, undefined)
  }

  if (tabId !== undefined) {
    const tabSessionKeys = tabSessionMap.get(tabId)?.filter(sessionKey => sessionKey !== id) ?? []
    tabSessionKeys.push(id)
    tabSessionMap.set(tabId, tabSessionKeys)
  }

  return session
}

const createSession = (id: SessionKey, data?: SessionData): Session => {
  const session = new Session(data)
  sessionMap.set(id, session)

  return session
}

const deleteSession = (id: SessionKey): void => {
  sessionMap.delete(id)
  tabSessionMap.forEach((sessionKeys, tabId) => {
    const remainingSessionKeys = sessionKeys.filter(sessionKey => sessionKey !== id)
    if (remainingSessionKeys.length === 0) {
      tabSessionMap.delete(tabId)
    } else if (remainingSessionKeys.length !== sessionKeys.length) {
      tabSessionMap.set(tabId, remainingSessionKeys)
    }
  })
}

const pushToSession = (key: SessionKey, session: Session, ev: string, data?: any): boolean => {
  try {
    ;(session as any).pushMessage?.(ev, data)
    return true
  } catch (e) {
    if (sessionMap.has(key)) {
      deleteSession(key)
    }
    return false
  }
}

const broadcastEvent = (
  ev: string,
  data?: any,
  origin?: string,
  requiredChain?: ChainType,
  includeRevokedOrigin = false
): void => {
  const sessions: Array<[SessionKey, Session]> = []
  sessionMap.forEach((session, key) => {
    if (origin && session.origin !== origin) {
      return
    }
    const isExplicitRevokedTarget = includeRevokedOrigin && origin === session.origin
    if (isExplicitRevokedTarget || permissionService.hasPermission(session.origin, requiredChain)) {
      sessions.push([key, session])
    }
  })

  sessions.forEach(([key, session]) => pushToSession(key, session, ev, data))
}

export interface ChainChange {
  previousChain: ChainType
  chain: ChainType
  network: string
  /** What an origin with a grant for `chain` reads from getAccounts(). */
  accounts: string[]
}

/**
 * Announce a change of the active chain. Every connected origin receives
 * chainChanged and networkChanged. accountsChanged reaches only an origin
 * whose readable accounts changed, and carries only what that origin may
 * read: [] first when its grant matched the previous chain but not the new
 * one, or the new accounts last when its grant matches the new chain. An
 * origin whose grant belongs to neither chain gets no account event.
 */
const broadcastChainChange = ({ previousChain, chain, network, accounts }: ChainChange): void => {
  const deliveries: Array<[SessionKey, Session, Array<[string, any]>]> = []
  sessionMap.forEach((session, key) => {
    if (!permissionService.hasPermission(session.origin)) {
      return
    }
    const canRead = permissionService.hasPermission(session.origin, chain)
    const couldRead = permissionService.hasPermission(session.origin, previousChain)
    const events: Array<[string, any]> = []
    if (couldRead && !canRead) {
      events.push([SESSION_EVENTS.accountsChanged, []])
    }
    events.push([SESSION_EVENTS.chainChanged, chain], [SESSION_EVENTS.networkChanged, network])
    if (canRead && accounts.length > 0) {
      events.push([SESSION_EVENTS.accountsChanged, [...accounts]])
    }
    deliveries.push([key, session, events])
  })

  deliveries.forEach(([key, session, events]) => {
    events.every(([ev, data]) => pushToSession(key, session, ev, data))
  })
}

class SessionService {
  getSession = getSession
  getOrCreateSession = getOrCreateSession
  deleteSession = deleteSession
  broadcastEvent = broadcastEvent
  broadcastChainChange = broadcastChainChange

  async init(): Promise<void> {
    console.log('[SessionService] Initialized')
  }

  async cleanup(): Promise<void> {
    sessionMap.clear()
    tabSessionMap.clear()
  }
}

export const sessionService = new SessionService()

export default {
  getSession,
  getOrCreateSession,
  deleteSession,
  broadcastEvent,
  broadcastChainChange,
}
