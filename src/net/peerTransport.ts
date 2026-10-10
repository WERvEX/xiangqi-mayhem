import type { DataConnection, Peer, PeerError, PeerOptions } from 'peerjs'
import type { NetMessage } from './protocol'
import type { Connection, HostHandle, Transport } from './transport'

const ID_PREFIX = 'xqmayhem-'

const PEER_OPTIONS: PeerOptions = {
  debug: 1,
  config: {
    iceServers: [
      // 国内可用的 STUN 放前面；Google 的在国内不可用，留给海外用户
      { urls: ['stun:stun.miwifi.com:3478', 'stun:stun.chat.bilibili.com:3478'] },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
      // PeerJS 官方提供的公共 TURN，直连失败时兜底
      {
        urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
        username: 'peerjs',
        credential: 'peerjsp',
      },
    ],
  },
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
        () => fail('连接超时：当前网络可能不支持直连。可以让双方连同一个 Wi-Fi，或换个网络再试'),
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
      return '建立直连失败，可以换个网络再试'
    default:
      return e instanceof Error ? e.message : `连接失败（${type ?? '未知错误'}）`
  }
}
