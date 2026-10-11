import { applyAction, createGame, other, randomSeed, type Action, type GameState, type Side } from '../engine'
import { PROTOCOL_VERSION, type NetMessage } from './protocol'
import type { Connection, HostHandle, Route, Transport } from './transport'

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
  /** 与对方的连接方式：直连或经中转（查询不到时为 null） */
  route: Route | null
  /** 进行中的悔棋申请 */
  undoRequester: Side | null
  /** 最近一次悔棋申请的结果，界面显示一下提示 */
  undoResult: { result: 'accepted' | 'declined'; requester: Side; at: number } | null
  /** 客人：已经重连了几次 */
  reconnectAttempt: number
}

/** 房主刷新页面后恢复房间需要的数据（由界面层存进 sessionStorage） */
export interface HostSave {
  roomCode: string
  seed: string
  actions: Action[]
  mySide: Side
  /** 已加入的客人身份；还没有客人时为 null */
  token: string | null
  rematchVotes: Side[]
}

/** 客人断线后持续重连这么久，之后改为手动重试 */
const RECONNECT_WINDOW = 120_000
const RECONNECT_DELAYS = [1500, 3000, 5000, 8000, 10000]

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
  /** 这一轮断线开始重连的时间 */
  private reconnectSince = 0
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
      route: null,
      undoRequester: null,
      undoResult: null,
      reconnectAttempt: 0,
    }
  }

  /** 连接建立后查一下走的是直连还是中转（统计信息要稍等才准确） */
  private detectRoute(conn: Connection) {
    if (!conn.route) return
    setTimeout(() => {
      void conn.route!().then((route) => {
        if (conn === this.conn) this.patch({ route })
      })
    }, 1500)
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

  /** 房主刷新页面后恢复房间：沿用原来的房间号，客人会自动重连回来 */
  static resumeHost(transport: Transport, save: HostSave): OnlineSession {
    const s = new OnlineSession(transport, 'host')
    s.seed = save.seed
    s.actions = [...save.actions]
    s.token = save.token
    let state = createGame(save.seed)
    for (const a of save.actions) state = applyAction(state, a)
    s.patch({ roomCode: save.roomCode, mySide: save.mySide, state, rematchVotes: save.rematchVotes })
    void s.reopenHost(save.roomCode)
    return s
  }

  private async reopenHost(roomCode: string) {
    let host: HostHandle
    try {
      host = await this.transport.host(roomCode)
    } catch (e) {
      return this.fail(`没能恢复房间：${(e as Error).message}`)
    }
    if (this.closed) return host.destroy()
    this.host = host
    // 已经有客人：进入对局界面，等客人自动重连；还没有客人：回到等待界面
    this.patch({ status: this.token ? 'playing' : 'waiting', opponentOnline: false })
    host.onConnection((conn) => this.acceptGuest(conn))
  }

  /** 房主：恢复房间需要的数据；不是房主或房间还没建好时为 null */
  hostSave(): HostSave | null {
    const { role, roomCode, mySide } = this.snapshot
    if (role !== 'host' || !roomCode || !mySide || this.closed) return null
    return {
      roomCode,
      seed: this.seed,
      actions: [...this.actions],
      mySide,
      token: this.token,
      rematchVotes: this.snapshot.rematchVotes,
    }
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
        this.patch({ status: 'playing', opponentOnline: true, route: null })
        this.detectRoute(conn)
        return
      }
      if (conn !== this.conn) return
      const guestSide = other(this.snapshot.mySide!)
      if (msg.t === 'submit') this.hostApply(msg.action, guestSide)
      else if (msg.t === 'resync') this.sendSync()
      else if (msg.t === 'rematch') this.vote(guestSide)
      else if (msg.t === 'undo-request') this.hostUndoRequest(guestSide)
      else if (msg.t === 'undo-answer') this.hostUndoAnswer(msg.accept, guestSide)
    })
    conn.onClose(() => {
      if (conn !== this.conn) return
      this.conn = null
      // 对方断线，进行中的悔棋申请作废
      this.patch({ opponentOnline: false, undoRequester: null })
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
    if (this.snapshot.undoRequester) this.conn?.send({ t: 'undo-status', requester: this.snapshot.undoRequester })
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
    // 申请悔棋的一方自己又走了棋，申请作废
    if (this.snapshot.undoRequester === from) this.setUndo(null)
  }

  // ───── 悔棋（房主执行） ─────

  /**
   * 悔棋回到 side 最近一次走棋之前（对方已经应了一步的话，那步也一起撤回），
   * 返回保留的操作数；side 还没走过棋时返回 null
   */
  private undoTarget(side: Side): number | null {
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const a = this.actions[i]
      if (a.side === side && (a.type === 'move' || a.type === 'skip')) return i
    }
    return null
  }

  private setUndo(requester: Side | null, result?: 'accepted' | 'declined') {
    const prev = this.snapshot.undoRequester
    this.patch({
      undoRequester: requester,
      undoResult: result && prev ? { result, requester: prev, at: Date.now() } : this.snapshot.undoResult,
    })
    this.conn?.send({ t: 'undo-status', requester, result })
  }

  private hostUndoRequest(side: Side) {
    const { state, undoRequester } = this.snapshot
    if (!state || state.phase === 'over' || undoRequester || this.undoTarget(side) === null) return
    this.setUndo(side)
  }

  private hostUndoAnswer(accept: boolean, answerer: Side) {
    const requester = this.snapshot.undoRequester
    if (!requester || answerer === requester) return
    if (!accept) return this.setUndo(null, 'declined')
    const keep = this.undoTarget(requester)
    if (keep === null) return this.setUndo(null)
    this.actions = this.actions.slice(0, keep)
    let state = createGame(this.seed)
    for (const a of this.actions) state = applyAction(state, a)
    this.patch({ state })
    this.sendSync()
    this.setUndo(null, 'accepted')
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
    this.patch({ mySide: other(this.snapshot.mySide!), state: createGame(this.seed), rematchVotes: [], undoRequester: null })
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
    this.patch({ route: null, reconnectAttempt: 0 })
    this.detectRoute(conn)
    conn.onMessage((msg) => this.onHostMessage(msg))
    conn.onClose(() => {
      if (conn !== this.conn) return
      this.conn = null
      this.patch({ opponentOnline: false })
      if (!this.closed && this.snapshot.status !== 'error') this.scheduleReconnect('与对方的连接已断开')
    })
    conn.send({ t: 'hello', version: PROTOCOL_VERSION, token: this.token! })
  }

  /** 断线后持续重连（间隔逐渐变长）；房主刷新页面、切到后台再回来都能连回去 */
  private scheduleReconnect(reason: string) {
    if (this.reconnectAttempts === 0) this.reconnectSince = Date.now()
    if (Date.now() - this.reconnectSince > RECONNECT_WINDOW) {
      this.patch({ reconnecting: false, error: `${reason}。对方可能已离开房间` })
      return
    }
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS.length - 1)]
    this.reconnectAttempts++
    this.patch({ reconnecting: true, reconnectAttempt: this.reconnectAttempts })
    this.reconnectTimer = setTimeout(() => void this.connectGuest(), delay)
  }

  /** 手动重试，或者页面从后台回到前台时立即重连 */
  retry() {
    if (this.snapshot.role !== 'guest' || this.conn || this.closed) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
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
          reconnectAttempt: 0,
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
      case 'undo-status': {
        const prev = this.snapshot.undoRequester
        this.patch({
          undoRequester: msg.requester,
          undoResult:
            msg.result && prev ? { result: msg.result, requester: prev, at: Date.now() } : this.snapshot.undoResult,
        })
        break
      }
      case 'reject':
        this.fail(msg.reason)
        break
    }
  }

  // ───────────── 双方共用 ─────────────

  /** 当前这局的种子和操作序列，用于生成回放 */
  replayData(): { seed: string; actions: Action[] } {
    return { seed: this.seed, actions: [...this.actions] }
  }

  submit(action: Action) {
    if (this.snapshot.role === 'host') this.hostApply(action, this.snapshot.mySide!)
    else this.conn?.send({ t: 'submit', action })
  }

  /** 申请悔棋：对方同意后，撤回自己最近一次走棋（以及对方之后的应着） */
  requestUndo() {
    if (this.snapshot.role === 'host') this.hostUndoRequest(this.snapshot.mySide!)
    else this.conn?.send({ t: 'undo-request' })
  }

  /** 回应对方的悔棋申请 */
  answerUndo(accept: boolean) {
    if (this.snapshot.role === 'host') this.hostUndoAnswer(accept, this.snapshot.mySide!)
    else this.conn?.send({ t: 'undo-answer', accept })
  }

  /** 现在能不能申请悔棋：自己走过棋、对方在线、没有进行中的申请 */
  canRequestUndo(): boolean {
    const { mySide, state, undoRequester, opponentOnline } = this.snapshot
    if (!mySide || !state || state.phase === 'over' || undoRequester || !opponentOnline) return false
    return this.actions.some((a) => a.side === mySide && (a.type === 'move' || a.type === 'skip'))
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
