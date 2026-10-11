import type { DataConnection, Peer, PeerError, PeerOptions } from 'peerjs'
import { ICE_SERVERS } from './iceServers'
import type { NetMessage } from './protocol'
import type { Connection, HostHandle, Route, Transport } from './transport'

const ID_PREFIX = 'xqmayhem-'

/**
 * 房间号对应的信令 ID。房主每次刷新页面恢复房间都换一"代"：
 * 旧页面如果没能正常注销（崩溃、被系统杀掉），信令服务器要好几分钟才释放旧 ID，不能等它。
 * 客人连接时同时尝试几代 ID，谁在线就连谁。玩家看到的房间号不变。
 */
const peerId = (code: string, gen: number) => (gen === 0 ? ID_PREFIX + code : `${ID_PREFIX}${code}-${gen}`)
/** 客人一次同时尝试的代数 */
const GEN_WINDOW = 6

/** 这个标签页知道的某个房间的最新一代（刷新页面后仍然记得） */
function knownGen(key: string): number {
  return Number(sessionStorage.getItem(`xqm-gen-${key}`) ?? 0) || 0
}
function rememberGen(key: string, gen: number) {
  sessionStorage.setItem(`xqm-gen-${key}`, String(gen))
}

/** 调试用：在控制台执行 localStorage.xqmForceRelay = 1 后刷新，强制只走中转，用来检查中转服务器 */
const forceRelay = () => {
  try {
    return localStorage.getItem('xqmForceRelay') === '1'
  } catch {
    return false
  }
}

const PEER_OPTIONS: PeerOptions = {
  debug: 1,
  config: { iceServers: ICE_SERVERS, iceTransportPolicy: forceRelay() ? 'relay' : 'all' },
}

const OPEN_TIMEOUT = 15000
const CONNECT_TIMEOUT = 20000
const PING_INTERVAL = 4000
/** 超过这么久没收到任何消息就认为连接已断 */
const DEAD_AFTER = 13000

// 按需加载，同屏对战的玩家不用下载 PeerJS
const loadPeer = () => import('peerjs').then((m) => m.Peer)

const randomCode = () => String(100000 + Math.floor(Math.random() * 900000))


function openPeer(PeerCtor: typeof Peer, id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new PeerCtor(id, PEER_OPTIONS) : new PeerCtor(PEER_OPTIONS)
    const timer = setTimeout(() => {
      peer.destroy()
      reject(new Error('连接服务器超时，请检查网络后重试'))
    }, OPEN_TIMEOUT)
    const onError = (e: PeerError<string>) => {
      clearTimeout(timer)
      peer.destroy()
      reject(e)
    }
    peer.once('error', onError)
    peer.once('open', () => {
      clearTimeout(timer)
      peer.off('error', onError)
      peer.on('error', (e) => console.warn('[peer]', e.type, e))
      // 与信令服务器断开不影响已建立的连接，但要重连才能接受新连接
      peer.on('disconnected', () => {
        if (!peer.destroyed) peer.reconnect()
      })
      resolve(peer)
    })
  })
}

function wrap(dc: DataConnection, onClosed?: () => void): Connection {
  const messageCbs: ((m: NetMessage) => void)[] = []
  const closeCbs: (() => void)[] = []
  let closed = false
  let lastSeen = Date.now()

  const fireClose = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    for (const cb of closeCbs) cb()
    onClosed?.()
  }

  // WebRTC 在对方直接关掉页面时可能很久才报告断开，用心跳兜底
  const heartbeat = setInterval(() => {
    if (Date.now() - lastSeen > DEAD_AFTER) {
      dc.close()
      fireClose()
    } else if (dc.open) dc.send({ t: 'ping' } satisfies NetMessage)
  }, PING_INTERVAL)

  dc.on('data', (data) => {
    lastSeen = Date.now()
    const msg = data as NetMessage
    if (msg.t !== 'ping') for (const cb of messageCbs) cb(msg)
  })
  dc.on('close', fireClose)
  dc.on('error', fireClose)

  return {
    route: () => routeOf(dc.peerConnection),
    send: (msg) => {
      if (dc.open) dc.send(msg)
    },
    onMessage: (cb) => messageCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    close: () => {
      dc.close()
      fireClose()
    },
  }
}

export const peerTransport: Transport = {
  async host(roomCode?: string): Promise<HostHandle> {
    const PeerCtor = await loadPeer()
    let peer: Peer | null = null
    let code = roomCode ?? randomCode()
    // 恢复房间：从上一代的下一代开始；新建房间：第 0 代
    let gen = roomCode ? knownGen(`host-${roomCode}`) + 1 : 0
    for (let attempt = 0; !peer; attempt++) {
      try {
        peer = await openPeer(PeerCtor, peerId(code, gen))
      } catch (e) {
        if ((e as PeerError<string>).type !== 'unavailable-id' || attempt >= 5) throw new Error(describe(e))
        // 新建房间：房间号被占用就换一个；恢复房间：这一代被占用就用下一代
        if (roomCode) gen++
        else code = randomCode()
      }
    }
    rememberGen(`host-${code}`, gen)
    const id = peerId(code, gen)

    let current: Peer = peer
    let destroyed = false
    let onConn: ((conn: Connection) => void) | null = null
    const listen = (p: Peer) =>
      p.on('connection', (dc) => {
        dc.on('open', () => onConn?.(wrap(dc)))
      })
    listen(current)

    // 与信令服务器断开（网络切换、切到后台）时不断重连，否则客人连不进来
    let reviving = false
    const keepAlive = async () => {
      if (destroyed || reviving) return
      if (current.destroyed) {
        reviving = true
        try {
          current = await openPeer(PeerCtor, id)
          listen(current)
        } catch {
          // 下次再试
        } finally {
          reviving = false
        }
      } else if (current.disconnected) current.reconnect()
    }
    const timer = setInterval(() => void keepAlive(), 5000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void keepAlive()
    }
    document.addEventListener('visibilitychange', onVisible)
    // 刷新或关闭页面时主动注销房间号。只靠浏览器断开连接的话，信令服务器要一分多钟才释放它，
    // 房主刷新后就得等这么久才能恢复房间
    const onPageHide = () => current.destroy()
    window.addEventListener('pagehide', onPageHide)

    return {
      roomCode: code,
      onConnection: (cb) => {
        onConn = cb
      },
      destroy: () => {
        destroyed = true
        clearInterval(timer)
        document.removeEventListener('visibilitychange', onVisible)
        window.removeEventListener('pagehide', onPageHide)
        current.destroy()
      },
    }
  },

  async join(roomCode: string): Promise<Connection> {
    const PeerCtor = await loadPeer()
    let peer: Peer
    try {
      peer = await openPeer(PeerCtor)
    } catch (e) {
      throw new Error(describe(e))
    }
    // 从记得的那一代开始，同时连几代：不存在的 ID 会很快报错，在线的那个会连上
    const first = knownGen(roomCode)
    const gens = Array.from({ length: GEN_WINDOW }, (_, i) => first + i)
    return new Promise((resolve, reject) => {
      let settled = false
      let unavailable = 0
      const channels: DataConnection[] = []
      const fail = (msg: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        peer.destroy()
        reject(new Error(msg))
      }
      const timer = setTimeout(
        () => fail('连接超时：没能和房主建立连接。可以在联机大厅点「网络检测」，看看是哪一步出了问题'),
        CONNECT_TIMEOUT,
      )
      peer.on('error', (e) => {
        // 每个不存在的 ID 各报一次；全都不存在才算房间不存在
        if (e.type === 'peer-unavailable') {
          if (++unavailable >= gens.length) fail(describe(e))
          return
        }
        fail(describe(e))
      })
      for (const gen of gens) {
        const dc = peer.connect(peerId(roomCode, gen), { reliable: true, serialization: 'json' })
        channels.push(dc)
        dc.on('open', () => {
          if (settled) return dc.close()
          settled = true
          clearTimeout(timer)
          rememberGen(roomCode, gen)
          for (const other of channels) if (other !== dc) other.close()
          resolve(wrap(dc, () => peer.destroy()))
        })
      }
    })
  },
}

function describe(e: unknown): string {
  const type = (e as PeerError<string>)?.type
  switch (type) {
    case 'peer-unavailable':
      return '房间不存在或已关闭'
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return '无法连接联机服务器，请检查网络后重试'
    case 'browser-incompatible':
      return '当前浏览器不支持联机，请换用 Chrome、Edge 或 Safari'
    case 'webrtc':
      return '建立连接失败，可以在联机大厅点「网络检测」看看是哪一步出了问题'
    default:
      return e instanceof Error ? e.message : `连接失败（${type ?? '未知错误'}）`
  }
}

/** 当前连接走的是直连还是中转（读取 WebRTC 统计里选中的候选对） */
async function routeOf(pc: RTCPeerConnection | undefined): Promise<Route | null> {
  if (!pc) return null
  try {
    const stats = [...(await pc.getStats()).values()] as Record<string, unknown>[]
    const transport = stats.find((s) => s.type === 'transport' && s.selectedCandidatePairId)
    const pair =
      stats.find((s) => s.id === transport?.selectedCandidatePairId) ??
      stats.find((s) => s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated)
    if (!pair) return null
    const local = stats.find((s) => s.id === pair.localCandidateId)
    const remote = stats.find((s) => s.id === pair.remoteCandidateId)
    return local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct'
  } catch {
    return null
  }
}

// ───────────── 网络检测 ─────────────

export interface NetworkCheck {
  /** 能连上信令服务器（用来交换连接信息） */
  signaling: boolean
  /** STUN 能拿到公网地址（才有可能打洞直连） */
  stun: boolean
  /** 能连上我们的中转服务器 */
  relayUdp: boolean
  relayTcp: boolean
}

/** 收集一次 ICE 候选，看看能拿到哪些类型 */
async function gatherCandidates(timeoutMs: number): Promise<RTCIceCandidate[]> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  const found: RTCIceCandidate[] = []
  try {
    pc.createDataChannel('check')
    pc.onicecandidate = (e) => {
      if (e.candidate) found.push(e.candidate)
    }
    await pc.setLocalDescription(await pc.createOffer())
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer)
          resolve()
        }
      }
    })
  } finally {
    pc.close()
  }
  return found
}

export async function checkNetwork(): Promise<NetworkCheck> {
  const signaling = loadPeer()
    .then((PeerCtor) => openPeer(PeerCtor))
    .then((peer) => {
      peer.destroy()
      return true
    })
    .catch(() => false)
  const candidates = await gatherCandidates(8000)
  const relays = candidates.filter((c) => c.type === 'relay')
  return {
    signaling: await signaling,
    stun: candidates.some((c) => c.type === 'srflx'),
    relayUdp: relays.some((c) => (c as RTCIceCandidate & { relayProtocol?: string }).relayProtocol !== 'tcp'),
    relayTcp: relays.some((c) => (c as RTCIceCandidate & { relayProtocol?: string }).relayProtocol === 'tcp'),
  }
}
