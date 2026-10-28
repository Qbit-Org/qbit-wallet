import permissionService from './permission'
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

const broadcastEvent = (
  ev: string,
  data?: any,
  origin?: string,
  requiredChain?: ChainType,
  includeRevokedOrigin = false
): void => {
  let sessions: any[] = []
  sessionMap.forEach((session, key) => {
    const isExplicitRevokedTarget = includeRevokedOrigin && origin === session.origin
    if (isExplicitRevokedTarget || permissionService.hasPermission(session.origin, requiredChain)) {
      sessions.push({
        key,
        ...session,
      })
    }
  })

  // same origin
  if (origin) {
    sessions = sessions.filter(session => session.origin === origin)
  }

  sessions.forEach(session => {
    try {
      session.pushMessage?.(ev, data)
    } catch (e) {
      if (sessionMap.has(session.key)) {
        deleteSession(session.key)
      }
    }
  })
}

class SessionService {
  getSession = getSession
  getOrCreateSession = getOrCreateSession
  deleteSession = deleteSession
  broadcastEvent = broadcastEvent

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
}
