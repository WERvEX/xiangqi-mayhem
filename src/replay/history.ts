import { useSyncExternalStore } from 'react'
import { roundOf, type GameState, type Side } from '../engine'
import { replayToFile, type Replay, type ReplayMode } from './replay'

/**
 * 最近的对局记录：每局结束时自动把回放存到本机（localStorage），最多保留 20 局。
 * 大模型对局的回放带着思考，可能比较大；总量超过上限时先删最旧的，单局太大时去掉思考只留发言。
 */

export interface HistoryEntry {
  id: string
  savedAt: string
  mode: ReplayMode
  red?: string
  black?: string
  /** 本机玩家执哪一方；同屏对战为 null */
  mySide: Side | null
  winner: Side | null
  reason: string
  rounds: number
  /** 回放文件内容（与「下载回放文件」相同） */
  file: string
}

const KEY = 'xqm-history'
const MAX_ENTRIES = 20
/** localStorage 一般有 5MB，给其他数据留出空间 */
const MAX_BYTES = 2_500_000
/** 单局超过这个大小就去掉思考 */
const MAX_ENTRY_BYTES = 400_000

const listeners = new Set<() => void>()
let cache: HistoryEntry[] | null = null

function read(): HistoryEntry[] {
  if (cache) return cache
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    cache = Array.isArray(list) ? list : []
  } catch {
    cache = []
  }
  return cache
}

function write(list: HistoryEntry[]) {
  // 超出容量时从最旧的开始删
  let entries = list.slice(0, MAX_ENTRIES)
  for (;;) {
    const json = JSON.stringify(entries)
    if (json.length <= MAX_BYTES || entries.length <= 1) {
      try {
        localStorage.setItem(KEY, json)
        break
      } catch {
        if (entries.length <= 1) break
      }
    }
    entries = entries.slice(0, -1)
  }
  cache = entries
  for (const l of listeners) l()
}

export function addToHistory(replay: Replay, final: GameState, mySide: Side | null) {
  let r = replay
  let file = replayToFile(r)
  if (file.length > MAX_ENTRY_BYTES && r.notes) {
    r = { ...r, notes: r.notes.map(({ thought: _thought, ...n }) => n) }
    file = replayToFile(r)
  }
  const entry: HistoryEntry = {
    // 同一局（同一个种子、同样的步数）只保留一条，例如结束后又补上了大模型的结束语
    id: `${r.seed}-${r.actions.length}`,
    savedAt: new Date().toISOString(),
    mode: r.meta.mode,
    red: r.meta.red,
    black: r.meta.black,
    mySide,
    winner: final.winner,
    reason: final.endReason ?? '',
    rounds: roundOf(final),
    file,
  }
  write([entry, ...read().filter((e) => e.id !== entry.id)])
}

export function removeFromHistory(id: string) {
  write(read().filter((e) => e.id !== id))
}

export function useHistory(): HistoryEntry[] {
  return useSyncExternalStore((cb) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }, read)
}
