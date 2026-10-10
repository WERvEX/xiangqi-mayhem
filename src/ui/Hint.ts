import { useEffect, useRef, useState } from 'react'
import { DIFFICULTIES, type Difficulty } from '../ai/bot'
import { BotClient } from '../ai/client'
import type { Action, GameState, Side } from '../engine'

const LEVEL_KEY = 'xqm-hint-level'

function loadLevel(): Difficulty {
  const saved = localStorage.getItem(LEVEL_KEY)
  return saved && saved in DIFFICULTIES ? (saved as Difficulty) : 'hard'
}

/**
 * 给玩家用的走法推荐。用独立的后台线程计算，不影响对手 AI。
 * actor：当前可以请求推荐的一方；为 null 时不能请求（不是你的回合、观战等）。
 * 局面变化后，旧的推荐自动失效。
 */
export function useHint(state: GameState, actor: Side | null) {
  const [level, setLevelState] = useState<Difficulty>(loadLevel)
  const [result, setResult] = useState<{ state: GameState; action: Action } | null>(null)
  const [thinkingFor, setThinkingFor] = useState<GameState | null>(null)
  const botRef = useRef<BotClient | null>(null)

  useEffect(() => () => botRef.current?.dispose(), [])
  // 局面一变就作废还没算完的推荐
  useEffect(() => () => botRef.current?.cancel(), [state])

  const setLevel = (l: Difficulty) => {
    localStorage.setItem(LEVEL_KEY, l)
    setLevelState(l)
  }

  const ask = async () => {
    if (!actor) return
    const bot = (botRef.current ??= new BotClient())
    setThinkingFor(state)
    const action = await bot.think(state, actor, { difficulty: level, personality: 'balanced' })
    setThinkingFor((cur) => (cur === state ? null : cur))
    if (action) setResult({ state, action })
  }

  return {
    level,
    setLevel,
    ask,
    canAsk: actor !== null,
    thinking: thinkingFor === state,
    /** 针对当前局面的推荐，局面变化后为 null */
    hint: result && result.state === state ? result.action : null,
  }
}
