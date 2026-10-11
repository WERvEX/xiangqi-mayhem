import { useState } from 'react'
import { ResumeCard } from './AiGame'
import { Codex, Modal, Rules } from './common'
import { clearSaved, useSaved, type SaveSlot } from './savedGame'

const REPO_URL = 'https://github.com/WERvEX/xiangqi-mayhem'

export function Home({
  onPvp,
  onPve,
  onEve,
  onReplay,
  onSettings,
  onResume,
}: {
  /** 继续上一局 */
  onResume: (slot: SaveSlot) => void
  onPvp: () => void
  onPve: () => void
  onEve: () => void
  onReplay: () => void
  onSettings: () => void
}) {
  const [showCodex, setShowCodex] = useState(false)
  const savedAi = useSaved('ai')
  const savedHotseat = useSaved('hotseat')
  const savedEve = useSaved('eve')
  return (
    <div className="home">
      <h1 className="title">
        象棋大乱斗
        <small>XIANGQI MAYHEM</small>
      </h1>
      <p className="tagline">中国象棋 × 锦囊三选一。每局都不一样的象棋。</p>

      {savedAi && <ResumeCard saved={savedAi} onResume={() => onResume('ai')} onDiscard={() => clearSaved('ai')} />}
      {savedHotseat && (
        <ResumeCard saved={savedHotseat} onResume={() => onResume('hotseat')} onDiscard={() => clearSaved('hotseat')} />
      )}
      {savedEve && <ResumeCard saved={savedEve} onResume={() => onResume('eve')} onDiscard={() => clearSaved('eve')} />}

      <div className="home-actions">
        <button type="button" className="primary big mode-button" onClick={onPvp}>
          <b>对战玩家</b>
          <span>联机 · 同屏</span>
        </button>
        <button type="button" className="primary big mode-button" onClick={onPve}>
          <b>挑战 AI</b>
          <span>规则 AI · 大模型</span>
        </button>
        <button type="button" className="primary big mode-button" onClick={onEve}>
          <b>模型斗蛐蛐</b>
          <span>大模型对战大模型</span>
        </button>
        <div className="home-row three">
          <button type="button" className="big" onClick={() => setShowCodex(true)}>
            锦囊图鉴
          </button>
          <button type="button" className="big" onClick={onReplay}>
            对局记录
          </button>
          <button type="button" className="big" onClick={onSettings}>
            ⚙ 设置
          </button>
        </div>
      </div>

      <section className="home-rules">
        <h3>规则速览</h3>
        <Rules />
      </section>

      <p className="home-footer muted">
        有新锦囊的点子、发现了问题？欢迎到{' '}
        <a href={`${REPO_URL}/issues/new/choose`} target="_blank" rel="noreferrer">
          GitHub
        </a>{' '}
        提给我们 · 开源（GPL-3.0）
      </p>

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

/** 对战玩家：联机或同屏 */
export function PvpMenu({ onOnline, onHotseat, onBack }: { onOnline: () => void; onHotseat: () => void; onBack: () => void }) {
  return (
    <div className="lobby">
      <h2>对战玩家</h2>
      <button type="button" className="option big-option" onClick={onOnline}>
        <b>联机对战</b>
        <span>创建房间，把链接发给朋友，各用各的设备</span>
      </button>
      <button type="button" className="option big-option" onClick={onHotseat}>
        <b>同屏对战</b>
        <span>一台设备，两个人轮流走棋</span>
      </button>
      <button type="button" onClick={onBack}>
        返回
      </button>
    </div>
  )
}
