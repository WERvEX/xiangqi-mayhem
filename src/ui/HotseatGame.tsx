import { useEffect, useState } from 'react'
import { makeReplay, type Replay } from '../replay/replay'
import { GameView } from './GameView'
import { ReplayShareModal } from './Replay'
import { clearSaved, loadSaved, useAutoSave } from './savedGame'
import { useFinishedGame } from './useFinishedGame'
import { useLocalGame } from './useLocalGame'

/** 同屏对战：一台设备轮流下，支持无限悔棋 */
export function HotseatGame({ onExit, resume = false }: { onExit: () => void; resume?: boolean }) {
  const game = useLocalGame(resume ? loadSaved('hotseat') : null)
  const { state, seed, actions, canUndo, dispatch, undo, restart } = game
  useAutoSave('hotseat', game, '同屏对战', null)
  const buildReplay = () => makeReplay(seed, actions, { mode: 'hotseat' })
  const finished = useFinishedGame(state, buildReplay, null)
  const [sharing, setSharing] = useState<Replay | null>(null)

  // 开发模式下暴露给控制台，便于调试和测试（生产构建会移除）
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __xq: { state, dispatch } })
  })

  return (
    <>
      {finished.reviewView}
      <div hidden={!!finished.reviewView}>
        <GameView
          key={seed}
          state={state}
          dispatch={dispatch}
          mySide={null}
          onExit={onExit}
          // 只停在走棋的局面：锦囊选择跟着它前面那步棋一起撤回
          onUndo={canUndo ? () => undo((s) => s.phase === 'play') : undefined}
          hints
          onRestart={() => {
            clearSaved('hotseat')
            restart()
          }}
          onShareReplay={actions.length > 0 ? () => setSharing(buildReplay()) : undefined}
          onWatchReplay={finished.watch}
        />
      </div>
      {sharing && <ReplayShareModal replay={sharing} onClose={() => setSharing(null)} />}
    </>
  )
}
