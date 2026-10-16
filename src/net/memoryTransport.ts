import type { NetMessage } from './protocol'
import type { Connection, HostHandle, Transport } from './transport'

/** 进程内的传输层，用于测试。消息异步投递，模拟网络。 */
export class MemoryNetwork {
  private rooms = new Map<string, (conn: Connection) => void>()
  private nextCode = 100000
  /** 所有已建立的连接对，便于测试模拟断线 */
  links: { code: string; host: Connection; guest: Connection; drop(): void }[] = []

  /** 房主不打招呼就消失（刷新、关掉页面）：房间和连接都没了 */
  crashHost(code: string) {
    this.rooms.delete(code)
    for (const l of this.links) if (l.code === code) l.drop()
  }

  transport: Transport = {
    host: async (roomCode?: string): Promise<HostHandle> => {
      const code = roomCode ?? String(this.nextCode++)
      if (this.rooms.has(code)) throw new Error('房间号已被占用')
      let handler: ((conn: Connection) => void) | null = null
      this.rooms.set(code, (conn) => handler?.(conn))
      return {
        roomCode: code,
        onConnection: (cb) => {
          handler = cb
        },
        destroy: () => this.rooms.delete(code),
      }
    },
    join: async (code: string): Promise<Connection> => {
      const accept = this.rooms.get(code)
      if (!accept) throw new Error('房间不存在或已关闭')
      const [a, b, drop] = pipe()
      this.links.push({ code, host: a, guest: b, drop })
      accept(a)
      return b
    },
  }
}

function pipe(): [Connection, Connection, () => void] {
  type End = { msg: ((m: NetMessage) => void)[]; close: (() => void)[]; closed: boolean }
  const ends: [End, End] = [
    { msg: [], close: [], closed: false },
    { msg: [], close: [], closed: false },
  ]
  const shut = () => {
    for (const e of ends) {
      if (e.closed) continue
      e.closed = true
      queueMicrotask(() => e.close.forEach((cb) => cb()))
    }
  }
  const make = (self: End, peer: End): Connection => ({
    send: (m) => {
      if (self.closed) return
      const copy = structuredClone(m)
      queueMicrotask(() => {
        if (!peer.closed) peer.msg.forEach((cb) => cb(copy))
      })
    },
    onMessage: (cb) => self.msg.push(cb),
    onClose: (cb) => self.close.push(cb),
    close: shut,
  })
  return [make(ends[0], ends[1]), make(ends[1], ends[0]), shut]
}
