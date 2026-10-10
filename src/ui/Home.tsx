import { useState } from 'react'
import { Codex, Modal, Rules } from './common'

export function Home({ onStart }: { onStart: () => void }) {
  const [showCodex, setShowCodex] = useState(false)
  return (
    <div className="home">
      <h1 className="title">
        象棋大乱斗
        <small>XIANGQI MAYHEM</small>
      </h1>
      <p className="tagline">中国象棋 × 锦囊三选一。每局都不一样的象棋。</p>

      <div className="home-actions">
        <button type="button" className="primary big" onClick={onStart}>
          同屏对战
        </button>
        <button type="button" className="big" disabled title="即将推出">
          联机对战 <small>即将推出</small>
        </button>
        <button type="button" className="big" onClick={() => setShowCodex(true)}>
          锦囊图鉴
        </button>
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
