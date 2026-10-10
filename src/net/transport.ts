import type { NetMessage } from './protocol'

/**
 * 联机传输层。会话逻辑只依赖这个接口，
 * 目前用 PeerJS（P2P）实现，以后可以换成 WebSocket 中转服务器。
 */
export interface Connection {
  send(msg: NetMessage): void
  onMessage(cb: (msg: NetMessage) => void): void
  /** 连接断开（对方离开、网络中断、主动关闭）时触发一次 */
  onClose(cb: () => void): void
  close(): void
}

export interface HostHandle {
  roomCode: string
  onConnection(cb: (conn: Connection) => void): void
  destroy(): void
}

export interface Transport {
  host(): Promise<HostHandle>
  join(roomCode: string): Promise<Connection>
}
