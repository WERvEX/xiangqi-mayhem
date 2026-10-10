import type { Action, Side } from '../engine'

/** 规则或协议有不兼容改动时加一，双方版本不一致会拒绝连接 */
export const PROTOCOL_VERSION = 1

export type NetMessage =
  /** 客人 → 房主：加入或重连 */
  | { t: 'hello'; version: number; token: string }
  /** 房主 → 客人：完整对局（首次加入、重连、新开一局） */
  | { t: 'sync'; seed: string; yourSide: Side; actions: Action[]; rematch: Side[] }
  /** 客人 → 房主：提交一个操作，由房主校验 */
  | { t: 'submit'; action: Action }
  /** 房主 → 客人：已确认的操作，seq 为它在操作序列中的下标 */
  | { t: 'action'; seq: number; action: Action }
  /** 客人 → 房主：本地序列出现缺口，请求完整同步 */
  | { t: 'resync' }
  /** 客人 → 房主：想再来一局 */
  | { t: 'rematch' }
  /** 房主 → 客人：当前再来一局的投票 */
  | { t: 'rematch-status'; votes: Side[] }
  /** 房主 → 客人：拒绝加入 */
  | { t: 'reject'; reason: string }
  /** 心跳，由传输层处理 */
  | { t: 'ping' }
