import { useState } from 'react'
import { Codex, Modal, Rules } from './common'

export function Home({
  onHotseat,
  onAi,
  onOnline,
  onReplay,
}: {
  onHotseat: () => void
  onAi: () => void
  onOnline: () => void
  onReplay: () => void
}) {
  const [showCodex, setShowCodex] = useState(false)
  return (
    <div className="home">
      <h1 className="title">
        象棋大乱斗
        <small>XIANGQI MAYHEM</small>
      </h1>
      <p className="tagline">中国象棋 × 锦囊三选一。每局都不一样的象棋。</p>

      <div className="home-actions">
        <button type="button" className="primary big" onClick={onAi}>
          人机对战
        </button>
        <button type="button" className="primary big" onClick={onOnline}>
          联机对战
        </button>
        <button type="button" className="primary big" onClick={onHotseat}>
          同屏对战
        </button>
        <div className="home-row">
          <button type="button" className="big" onClick={() => setShowCodex(true)}>
            锦囊图鉴
          </button>
          <button type="button" className="big" onClick={onReplay}>
            观看回放
          </button>
        </div>
      </div>

      <section className="home-rules">
        <h3>规则速览</h3>
        <Rules />
      </section>

      {showCodex && (
        <Modal onClose={() => setShowCodex(false)} className="codex-modal">
          <h2>锦囊图鉴</h2>
          <Codex />
          <div className="modal-actions">
            <button type="button" onClick={() => setShowCodex(false)}>
              关闭
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
