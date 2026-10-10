import { useEffect, useState } from 'react'
import { applyAction, createGame, randomSeed, type Action, type GameState } from '../engine'
import { GameView } from './GameView'

/** 同屏对战：一台设备轮流下，支持无限悔棋 */
export function HotseatGame({ onExit }: { onExit: () => void }) {
  const [history, setHistory] = useState<GameState[]>(() => [createGame(randomSeed())])
  const state = history[history.length - 1]

  const dispatch = (action: Action) => {
    try {
      const next = applyAction(state, action)
      setHistory((h) => [...h, next])
    } catch (e) {
      console.warn(e)
    }
  }

  // 开发模式下暴露给控制台，便于调试和测试（生产构建会移除）
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __xq: { state, dispatch } })
  })

  return (
    <GameView
      key={state.seed}
      state={state}
      dispatch={dispatch}
      mySide={null}
      onExit={onExit}
      onUndo={history.length > 1 ? () => setHistory((h) => h.slice(0, -1)) : undefined}
      onRestart={() => setHistory([createGame(randomSeed())])}
    />
  )
}
