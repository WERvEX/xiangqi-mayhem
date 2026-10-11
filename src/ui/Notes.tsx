import { useEffect, useRef } from 'react'
import { SIDE_NAMES, type Side } from '../engine'

/** 对话列表里的一句话 */
export interface Speech {
  key: string
  text: string
  /** 第几回合说的 */
  round: number
  /** speech：模型的发言；system：系统消息（如规则 AI 代走） */
  kind: 'speech' | 'system'
}

/**
 * 大模型的对话框：像聊天软件一样，最新的一句在最上面，旧的往下推、逐渐淡出，保留最近几句。
 * 下面可以展开最新一步的思考。
 * 宽屏时放在棋盘两侧，窄屏时放在对应一方的信息栏旁边（见 GameView 的 sideNotes）。
 */
export function SideNote({
  side,
  name,
  speeches,
  latest,
  showThought = false,
  thinkingSec,
  onSkip,
  live,
  warning,
}: {
  side: Side
  name: string
  /** 最近几句发言，最新的在前 */
  speeches: Speech[]
  /** 最新一步的思考和兜底说明 */
  latest: { thought?: string; fallback?: string } | null
  showThought?: boolean
  /** 正在思考时传入已等待的秒数 */
  thinkingSec?: number | null
  onSkip?: () => void
  /** 实时思维链：这一步到目前为止的思考和回答 */
  live?: { reasoning: string; text: string } | null
  /** 提示，如"这个模型关不掉思考" */
  warning?: string | null
}) {
  const thinking = thinkingSec !== undefined && thinkingSec !== null
  return (
    <div className={`side-note ${side}`}>
      <div className="note-head">
        <span className={`side-dot ${side}`} />
        <b>{SIDE_NAMES[side]}</b>
        <span className="muted">{name}</span>
      </div>
      <div className="chat-list">
        {thinking && (
          <div className="note-thinking">
            <span className="spinner small" /> 思考中… {thinkingSec} 秒
            {onSkip && thinkingSec >= 5 && (
              <button type="button" onClick={onSkip} title="不等了，由规则 AI 代走这一步">
                跳过
              </button>
            )}
          </div>
        )}
        {thinking && live && <LiveThought live={live} />}
        {speeches.map((s, i) =>
          s.kind === 'system' ? (
            <div key={s.key} className={`chat-system ${i === 0 ? 'latest' : 'old'}`} style={{ opacity: Math.max(0.5, 1 - i * 0.1) }}>
              ⚠ 第 {s.round} 回合 · {s.text}
            </div>
          ) : (
            <div
              key={s.key}
              className={`speech-bubble ${side} ${i === 0 ? 'latest' : 'old'}`}
              style={{ opacity: Math.max(0.5, 1 - i * 0.1) }}
            >
              {s.text}
              <span className="speech-round">第 {s.round} 回合</span>
            </div>
          ),
        )}
        {!thinking && speeches.length === 0 && <div className="speech-empty muted">……</div>}
      </div>
      {warning && <div className="note-fallback">⚠ {warning}</div>}
      {showThought && latest?.thought && (
        <details className="note-thought" open>
          <summary>最新一步的思考</summary>
          <div className="thought-text">{latest.thought}</div>
        </details>
      )}
    </div>
  )
}

/** 实时思维链：模型边想边输出，自动滚到最新的位置 */
function LiveThought({ live }: { live: { reasoning: string; text: string } }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [live])
  return (
    <div className="live-thought" ref={ref}>
      {live.reasoning && <div className="live-reasoning">{live.reasoning}</div>}
      {live.text && <div className="live-answer">{live.text}</div>}
      {!live.reasoning && !live.text && <div className="muted">等待模型输出…</div>}
    </div>
  )
}
