import { error as logError, log } from '../logger'
import {
  storeAppendEvent,
  storeGetLastEventSeq,
  storeGetSession,
  storeListEvents,
} from '../store'

export interface SessionEvent {
  id: string
  sessionId: string
  type: string
  payload: unknown
  direction: 'inbound' | 'outbound'
  seqNum: number
  createdAt: number
}

type Subscriber = (event: SessionEvent) => void
const MAX_LOCAL_EVENTS = 5000

export class EventBus {
  private subscribers = new Set<Subscriber>()
  private localEvents: SessionEvent[] = []
  private localSeqNum = 0
  private closed = false

  constructor(private readonly persistedSessionId?: string) {}

  subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  subscriberCount(): number {
    return this.subscribers.size
  }

  publish(event: Omit<SessionEvent, 'seqNum' | 'createdAt'>): SessionEvent {
    if (this.closed) throw new Error('EventBus is closed')
    const persisted =
      this.persistedSessionId && storeGetSession(this.persistedSessionId)
        ? storeAppendEvent(event)
        : undefined
    const full: SessionEvent = persisted
      ? {
          id: persisted.id,
          sessionId: persisted.sessionId,
          type: persisted.type,
          payload: persisted.payload,
          direction: persisted.direction,
          seqNum: persisted.seqNum,
          createdAt: persisted.createdAt,
        }
      : {
          ...event,
          seqNum: ++this.localSeqNum,
          createdAt: Date.now(),
        }
    if (!persisted) {
      this.localEvents.push(full)
      if (this.localEvents.length > MAX_LOCAL_EVENTS) {
        this.localEvents.splice(0, this.localEvents.length - MAX_LOCAL_EVENTS)
      }
    }
    log(
      `[RC-DEBUG] bus publish: sessionId=${event.sessionId} type=${event.type} dir=${event.direction} seq=${full.seqNum} subscribers=${this.subscribers.size}`,
    )
    for (const callback of this.subscribers) {
      try {
        callback(full)
      } catch (error) {
        logError('[RC-DEBUG] bus subscriber error:', error)
      }
    }
    return full
  }

  getLastSeqNum(): number {
    return this.persistedSessionId && storeGetSession(this.persistedSessionId)
      ? storeGetLastEventSeq(this.persistedSessionId)
      : this.localSeqNum
  }

  getEventsSince(seqNum: number): SessionEvent[] {
    if (this.persistedSessionId && storeGetSession(this.persistedSessionId)) {
      return storeListEvents(this.persistedSessionId, seqNum).map(event => ({
        id: event.id,
        sessionId: event.sessionId,
        type: event.type,
        payload: event.payload,
        direction: event.direction,
        seqNum: event.seqNum,
        createdAt: event.createdAt,
      }))
    }
    const index = this.localEvents.findIndex(event => event.seqNum > seqNum)
    return index === -1 ? [] : this.localEvents.slice(index)
  }

  close() {
    this.closed = true
    this.subscribers.clear()
    this.localEvents = []
  }
}

const buses = new Map<string, EventBus>()

export function getEventBus(sessionId: string): EventBus {
  let bus = buses.get(sessionId)
  if (!bus) {
    bus = new EventBus(sessionId)
    buses.set(sessionId, bus)
  }
  return bus
}

export function removeEventBus(sessionId: string) {
  const bus = buses.get(sessionId)
  if (!bus) return
  bus.close()
  buses.delete(sessionId)
}

export function getAllEventBuses(): Map<string, EventBus> {
  return buses
}

const acpBuses = new Map<string, EventBus>()

export function getAcpEventBus(
  accountId: string,
  channelGroupId: string,
): EventBus {
  const key = `${accountId}\0${channelGroupId}`
  let bus = acpBuses.get(key)
  if (!bus) {
    bus = new EventBus()
    acpBuses.set(key, bus)
  }
  return bus
}
