import { useEffect, useState } from 'react'
import { makeReplay, type Replay } from '../replay/replay'
import { GameView } from './GameView'
import { ReplayShareModal } from './Replay'
import { useLocalGame } from './useLocalGame'

/** 同屏对战：一台设备轮流下，支持无限悔棋 */
export function HotseatGame({ onExit }: { onExit: () => void }) {
  const { state, seed, actions, canUndo, dispatch, undo, restart } = useLocalGame()
  const [sharing, setSharing] = useState<Replay | null>(null)

  // 开发模式下暴露给控制台，便于调试和测试（生产构建会移除）
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __xq: { state, dispatch } })
  })

  return (
    <>
      <GameView
        key={seed}
        state={state}
        dispatch={dispatch}
        mySide={null}
        onExit={onExit}
        onUndo={canUndo ? () => undo() : undefined}
        onRestart={restart}
        onShareReplay={
          actions.length > 0 ? () => setSharing(makeReplay(seed, actions, { mode: 'hotseat' })) : undefined
        }
      />
      {sharing && <ReplayShareModal replay={sharing} onClose={() => setSharing(null)} />}
    </>
  )
}
