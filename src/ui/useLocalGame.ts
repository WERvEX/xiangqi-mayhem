import { useCallback, useState } from 'react'
import { applyAction, createGame, randomSeed, type Action, type GameState } from '../engine'
import { replayStates } from './savedGame'

interface History {
  /** states[i + 1] = applyAction(states[i], actions[i]) */
  states: GameState[]
  actions: Action[]
}

const fresh = (): History => ({ states: [createGame(randomSeed())], actions: [] })

/** 从存档恢复；存档损坏时开新局 */
function restored(initial: { seed: string; actions: Action[] }): History {
  const states = replayStates(initial.seed, initial.actions)
  return states ? { states, actions: initial.actions } : fresh()
}

/**
 * 本机对局（同屏、人机）的状态：完整历史，用于悔棋和生成回放。
 * initial：从存档恢复的对局（只在第一次渲染时读取）
 */
export function useLocalGame(initial?: { seed: string; actions: Action[] } | null) {
  const [h, setH] = useState<History>(() => (initial ? restored(initial) : fresh()))
  const state = h.states[h.states.length - 1]

  const dispatch = useCallback((action: Action) => {
    setH((cur) => {
      try {
        const next = applyAction(cur.states[cur.states.length - 1], action)
        return { states: [...cur.states, next], actions: [...cur.actions, action] }
      } catch (e) {
        console.warn(e)
        return cur
      }
    })
  }, [])

  /**
   * 至少撤回一步，然后继续撤回，直到 stopAt(局面) 为真或回到开局。
   * 用来连同 AI 的应对、锦囊选择一起撤回到上一次走棋之前。
   */
  const undo = useCallback((stopAt: (s: GameState) => boolean = () => true) => {
    setH((cur) => {
      let n = cur.actions.length
      if (n === 0) return cur
      do n--
      while (n > 0 && !stopAt(cur.states[n]))
      return { states: cur.states.slice(0, n + 1), actions: cur.actions.slice(0, n) }
    })
  }, [])

  const restart = useCallback(() => setH(fresh()), [])

  return {
    state,
    states: h.states,
    seed: h.states[0].seed,
    actions: h.actions,
    canUndo: h.actions.length > 0,
    dispatch,
    undo,
    restart,
  }
}
