import { useEffect, useRef, useState } from 'react'
import type { GameState, Side } from '../engine'
import { addToHistory } from '../replay/history'
import { loadReplay, type LoadedReplay, type Replay } from '../replay/replay'
import { ReplayView } from './Replay'

/**
 * 对局结束后的两件事：
 * - 自动存进「对局记录」（version 变化时重新保存，例如大模型的结束语稍后才到）
 * - 「查看回放」：在当前页面打开回放，看完回到对局
 */
export function useFinishedGame(
  state: GameState | null,
  buildReplay: () => Replay,
  mySide: Side | null,
  version: unknown = null,
) {
  const [review, setReview] = useState<LoadedReplay | null>(null)
  const recorded = useRef<{ state: GameState; version: unknown } | null>(null)

  useEffect(() => {
    if (!state || state.phase !== 'over') return
    if (recorded.current?.state === state && recorded.current.version === version) return
    recorded.current = { state, version }
    addToHistory(buildReplay(), state, mySide)
    // buildReplay 每次渲染都是新函数，只在局面或版本变化时保存
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, version, mySide])

  return {
    watch: () => setReview(loadReplay(buildReplay())),
    reviewView: review && <ReplayView replay={review} onExit={() => setReview(null)} exitLabel="返回对局" />,
  }
}
