import { useEffect, useSyncExternalStore } from 'react'
import { applyAction, createGame, roundOf, RULES_VERSION, type Action, type GameState } from '../engine'

/**
 * 本机对局的存档：刷新、关闭页面、开发时热更新之后都能接着下。
 * 每种模式一个存档位，只存"种子 + 操作序列"（和回放一样），恢复时重放一遍。
 * 对局结束后自动删除。
 */

export type SaveSlot = 'ai' | 'hotseat'

export interface SavedGame<E = unknown> {
  v: 1
  rules: number
  seed: string
  actions: Action[]
  savedAt: string
  /** 给"继续上一局"看的简短说明，如"大模型 DeepSeek · 第 12 回合" */
  label: string
  /** 各模式自己的数据（对局设置、大模型的发言等） */
  extra: E
}

const key = (slot: SaveSlot) => `xqm-saved-${slot}`

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

export function loadSaved<E>(slot: SaveSlot): SavedGame<E> | null {
  try {
    const g = JSON.parse(localStorage.getItem(key(slot)) ?? 'null') as SavedGame<E> | null
    // 规则变了，旧存档的操作可能已经重放不出来，直接作废
    if (!g || g.v !== 1 || g.rules !== RULES_VERSION || !Array.isArray(g.actions)) return null
    return g
  } catch {
    return null
  }
}

export function clearSaved(slot: SaveSlot) {
  if (localStorage.getItem(key(slot)) === null) return
  localStorage.removeItem(key(slot))
  notify()
}

function writeSaved(slot: SaveSlot, g: SavedGame) {
  try {
    localStorage.setItem(key(slot), JSON.stringify(g))
  } catch {
    // 存储空间满了：放弃存档，不影响对局
  }
  notify()
}

/** 重放出每一步的局面；存档损坏时返回 null */
export function replayStates(seed: string, actions: Action[]): GameState[] | null {
  try {
    const states = [createGame(seed)]
    for (const a of actions) states.push(applyAction(states[states.length - 1], a))
    return states
  } catch {
    return null
  }
}

/** 存档列表的订阅（主页用来显示"继续上一局"） */
export function useSaved<E>(slot: SaveSlot): SavedGame<E> | null {
  const raw = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => localStorage.getItem(key(slot)),
  )
  return raw === null ? null : loadSaved<E>(slot)
}

/**
 * 对局进行中自动存档，结束后删除。
 * 还没走过一步的新局不存，避免覆盖掉之前没下完的那局。
 */
export function useAutoSave<E>(
  slot: SaveSlot,
  game: { state: GameState; seed: string; actions: Action[] },
  label: string,
  extra: E,
) {
  const { state, seed, actions } = game
  const json = JSON.stringify(extra)
  useEffect(() => {
    if (state.phase === 'over') clearSaved(slot)
    else if (actions.length > 0) {
      writeSaved(slot, {
        v: 1,
        rules: RULES_VERSION,
        seed,
        actions,
        savedAt: new Date().toISOString(),
        label: `${label} · 第 ${roundOf(state)} 回合`,
        extra: JSON.parse(json) as E,
      })
    }
  }, [slot, state, seed, actions, label, json])
}
