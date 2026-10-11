import type { DataConnection, Peer, PeerError, PeerOptions } from 'peerjs'
import { ICE_SERVERS } from './iceServers'
import type { NetMessage } from './protocol'
import type { Connection, HostHandle, Route, Transport } from './transport'

const ID_PREFIX = 'xqmayhem-'

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
  async host(): Promise<HostHandle> {
    const PeerCtor = await loadPeer()
    for (let attempt = 0; ; attempt++) {
      const code = randomCode()
      let peer: Peer
      try {
        peer = await openPeer(PeerCtor, ID_PREFIX + code)
      } catch (e) {
        if ((e as PeerError<string>).type === 'unavailable-id' && attempt < 5) continue
        throw new Error(describe(e))
      }
      return {
        roomCode: code,
        onConnection: (cb) =>
          peer.on('connection', (dc) => {
            dc.on('open', () => cb(wrap(dc)))
          }),
        destroy: () => peer.destroy(),
      }
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
    return new Promise((resolve, reject) => {
      let settled = false
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
      peer.on('error', (e) => fail(describe(e)))
      const dc = peer.connect(ID_PREFIX + roomCode, { reliable: true, serialization: 'json' })
      dc.on('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(wrap(dc, () => peer.destroy()))
      })
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
