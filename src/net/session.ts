import { applyAction, createGame, other, randomSeed, type Action, type GameState, type Side } from '../engine'
import { PROTOCOL_VERSION, type NetMessage } from './protocol'
import type { Connection, HostHandle, Transport } from './transport'

export type SessionStatus = 'connecting' | 'waiting' | 'playing' | 'error'

export interface SessionSnapshot {
  role: 'host' | 'guest'
  status: SessionStatus
  roomCode: string | null
  mySide: Side | null
  state: GameState | null
  opponentOnline: boolean
  /** 客人正在自动重连 */
  reconnecting: boolean
  rematchVotes: Side[]
  error: string | null
}

const MAX_RECONNECT = 4
const RECONNECT_DELAY = 2500

/**
 * 一局联机对战。房主是权威方：客人的操作先发给房主校验，
 * 房主按顺序编号后广播，双方按同一顺序应用，保证状态一致。
 */
export class OnlineSession {
  private listeners = new Set<() => void>()
  private snapshot: SessionSnapshot
  private seed = ''
  private actions: Action[] = []
  private conn: Connection | null = null
  private host: HostHandle | null = null
  /** 房主：已接纳的客人身份；客人：自己的身份 */
  private token: string | null = null
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private transport: Transport

  private constructor(transport: Transport, role: 'host' | 'guest') {
    this.transport = transport
    this.snapshot = {
      role,
      status: 'connecting',
      roomCode: null,
      mySide: null,
      state: null,
      opponentOnline: false,
      reconnecting: false,
      rematchVotes: [],
      error: null,
    }
  }

  // ───── 给 React useSyncExternalStore 用 ─────
  subscribe = (cb: () => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  getSnapshot = () => this.snapshot

  private patch(p: Partial<SessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...p }
    for (const cb of this.listeners) cb()
  }

  private fail(error: string) {
    this.patch({ status: 'error', error, reconnecting: false })
  }

  // ───────────── 房主 ─────────────

  static createHost(transport: Transport, sidePref: Side | 'random'): OnlineSession {
    const s = new OnlineSession(transport, 'host')
    void s.startHost(sidePref)
    return s
  }

  private async startHost(sidePref: Side | 'random') {
    let host: HostHandle
    try {
      host = await this.transport.host()
    } catch (e) {
      return this.fail((e as Error).message)
    }
    if (this.closed) return host.destroy()
    this.host = host
    this.seed = randomSeed()
    const mySide = sidePref === 'random' ? (Math.random() < 0.5 ? 'red' : 'black') : sidePref
    this.patch({ status: 'waiting', roomCode: host.roomCode, mySide, state: createGame(this.seed) })
    host.onConnection((conn) => this.acceptGuest(conn))
  }

  private acceptGuest(conn: Connection) {
    conn.onMessage((msg) => {
      if (msg.t === 'hello') {
        if (msg.version !== PROTOCOL_VERSION) return this.reject(conn, '双方游戏版本不一致，请都刷新页面后重试')
        if (this.token && msg.token !== this.token) return this.reject(conn, '房间已满')
        this.token = msg.token
        if (this.conn && this.conn !== conn) this.conn.close()
        this.conn = conn
        this.sendSync()
        this.patch({ status: 'playing', opponentOnline: true })
        return
      }
      if (conn !== this.conn) return
      if (msg.t === 'submit') this.hostApply(msg.action, other(this.snapshot.mySide!))
      else if (msg.t === 'resync') this.sendSync()
      else if (msg.t === 'rematch') this.vote(other(this.snapshot.mySide!))
    })
    conn.onClose(() => {
      if (conn !== this.conn) return
      this.conn = null
      this.patch({ opponentOnline: false })
    })
  }

  private reject(conn: Connection, reason: string) {
    conn.send({ t: 'reject', reason })
    setTimeout(() => conn.close(), 500)
  }

  private sendSync() {
    this.conn?.send({
      t: 'sync',
      seed: this.seed,
      yourSide: other(this.snapshot.mySide!),
      actions: this.actions,
      rematch: this.snapshot.rematchVotes,
    })
  }

  private hostApply(action: Action, from: Side) {
    const { state } = this.snapshot
    if (!state || action.side !== from) return
    let next: GameState
    try {
      next = applyAction(state, action)
    } catch {
      return
    }
    this.actions.push(action)
    this.conn?.send({ t: 'action', seq: this.actions.length - 1, action })
    this.patch({ state: next })
  }

  private vote(side: Side) {
    if (this.snapshot.state?.phase !== 'over' || this.snapshot.rematchVotes.includes(side)) return
    const votes = [...this.snapshot.rematchVotes, side]
    if (votes.length < 2) {
      this.patch({ rematchVotes: votes })
      this.conn?.send({ t: 'rematch-status', votes })
      return
    }
    // 双方同意：交换先后手，重新开局
    this.seed = randomSeed()
    this.actions = []
    this.patch({ mySide: other(this.snapshot.mySide!), state: createGame(this.seed), rematchVotes: [] })
    this.sendSync()
  }

  // ───────────── 客人 ─────────────

  static join(transport: Transport, roomCode: string, token: string): OnlineSession {
    const s = new OnlineSession(transport, 'guest')
    s.token = token
    s.patch({ roomCode })
    void s.connectGuest()
    return s
  }

  private async connectGuest() {
    let conn: Connection
    try {
      conn = await this.transport.join(this.snapshot.roomCode!)
    } catch (e) {
      if (this.snapshot.state && !this.closed) return this.scheduleReconnect((e as Error).message)
      return this.fail((e as Error).message)
    }
    if (this.closed) return conn.close()
    this.conn = conn
    conn.onMessage((msg) => this.onHostMessage(msg))
    conn.onClose(() => {
      if (conn !== this.conn) return
      this.conn = null
      this.patch({ opponentOnline: false })
      if (!this.closed && this.snapshot.status !== 'error') this.scheduleReconnect('与对方的连接已断开')
    })
    conn.send({ t: 'hello', version: PROTOCOL_VERSION, token: this.token! })
  }

  private scheduleReconnect(reason: string) {
    if (this.reconnectAttempts >= MAX_RECONNECT) {
      this.patch({ reconnecting: false, error: `${reason}。对方可能已离开房间` })
      return
    }
    this.reconnectAttempts++
    this.patch({ reconnecting: true })
    this.reconnectTimer = setTimeout(() => void this.connectGuest(), RECONNECT_DELAY)
  }

  /** 自动重连放弃后，由玩家手动重试 */
  retry() {
    if (this.snapshot.role !== 'guest' || this.conn || this.closed) return
    this.reconnectAttempts = 0
    this.patch({ error: null, status: this.snapshot.state ? 'playing' : 'connecting' })
    void this.connectGuest()
  }

  private onHostMessage(msg: NetMessage) {
    switch (msg.t) {
      case 'sync': {
        this.seed = msg.seed
        this.actions = msg.actions
        let state = createGame(msg.seed)
        for (const a of msg.actions) state = applyAction(state, a)
        this.reconnectAttempts = 0
        this.patch({
          status: 'playing',
          mySide: msg.yourSide,
          state,
          rematchVotes: msg.rematch,
          opponentOnline: true,
          reconnecting: false,
          error: null,
        })
        break
      }
      case 'action': {
        if (msg.seq < this.actions.length) return
        if (msg.seq > this.actions.length || !this.snapshot.state) {
          this.conn?.send({ t: 'resync' })
          return
        }
        try {
          const state = applyAction(this.snapshot.state, msg.action)
          this.actions.push(msg.action)
          this.patch({ state })
        } catch {
          this.conn?.send({ t: 'resync' })
        }
        break
      }
      case 'rematch-status':
        this.patch({ rematchVotes: msg.votes })
        break
      case 'reject':
        this.fail(msg.reason)
        break
    }
  }

  // ───────────── 双方共用 ─────────────

  submit(action: Action) {
    if (this.snapshot.role === 'host') this.hostApply(action, this.snapshot.mySide!)
    else this.conn?.send({ t: 'submit', action })
  }

  requestRematch() {
    if (this.snapshot.role === 'host') this.vote(this.snapshot.mySide!)
    else this.conn?.send({ t: 'rematch' })
  }

  leave() {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const conn = this.conn
    this.conn = null
    conn?.close()
    this.host?.destroy()
    this.listeners.clear()
  }
}
