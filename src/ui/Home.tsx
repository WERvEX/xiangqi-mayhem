import { useState } from 'react'
import { ResumeCard } from './AiGame'
import { Codex, Modal, Rules } from './common'
import { clearSaved, useSaved, type SaveSlot } from './savedGame'

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
            观看回放
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

/** 模型斗蛐蛐：下一阶段实现 */
export function EveSoon({ onSettings, onBack }: { onSettings: () => void; onBack: () => void }) {
  return (
    <div className="lobby">
      <h2>模型斗蛐蛐</h2>
      <section className="lobby-card">
        <p>选两个大模型互相对战，实时看它们边下边互相"嘴炮"，双方的思考互相隔离。</p>
        <p className="muted">正在开发中，敬请期待。可以先配置好模型，在「挑战 AI」里和大模型下一局。</p>
        <button type="button" onClick={onSettings}>
          配置模型 / API 设置
        </button>
      </section>
      <button type="button" onClick={onBack}>
        返回
      </button>
    </div>
  )
}
