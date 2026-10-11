import { RULES_VERSION, type Action, type Side } from '../engine'

/**
 * 双方版本不一致会拒绝连接：规则不同的两端各自计算会得到不同的局面，消息格式不同也无法通信。
 * 规则版本 × 100 + 协议修订号（1：悔棋）
 */
export const PROTOCOL_VERSION = RULES_VERSION * 100 + 1

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
  /** 客人 → 房主：申请悔棋 */
  | { t: 'undo-request' }
  /** 客人 → 房主：回应房主的悔棋申请 */
  | { t: 'undo-answer'; accept: boolean }
  /** 房主 → 客人：悔棋申请的状态（requester 为 null 表示没有进行中的申请） */
  | { t: 'undo-status'; requester: Side | null; result?: 'accepted' | 'declined' }
  /** 房主 → 客人：拒绝加入 */
  | { t: 'reject'; reason: string }
  /** 心跳，由传输层处理 */
  | { t: 'ping' }
