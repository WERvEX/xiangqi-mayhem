import { SIDE_NAMES, type Side } from '../engine'

/** 一方大模型当前要显示的内容 */
export interface NoteContent {
  speech?: string
  thought?: string
  fallback?: string
}

/**
 * 大模型的发言气泡（以及可选的思考内容）。
 * 宽屏时放在棋盘两侧，窄屏时放在对应一方的信息栏旁边（见 GameView 的 sideNotes）。
 */
export function SideNote({
  side,
  name,
  note,
  showThought = false,
  thinkingSec,
  onSkip,
}: {
  side: Side
  name: string
  note: NoteContent | null
  showThought?: boolean
  /** 正在思考时传入已等待的秒数 */
  thinkingSec?: number | null
  onSkip?: () => void
}) {
  const thinking = thinkingSec !== undefined && thinkingSec !== null
  return (
    <div className={`side-note ${side}`}>
      <div className="note-head">
        <span className={`side-dot ${side}`} />
        <b>{SIDE_NAMES[side]}</b>
        <span className="muted">{name}</span>
      </div>
      {note?.speech ? (
        <div className={`speech-bubble ${side}`} key={note.speech}>
          {note.speech}
        </div>
      ) : (
        !thinking && <div className="speech-empty muted">……</div>
      )}
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
      {note?.fallback && <div className="note-fallback">⚠ 模型这步失败，由规则 AI 代走：{note.fallback}</div>}
      {showThought && note?.thought && (
        <details className="note-thought" open>
          <summary>思考过程</summary>
          <div className="thought-text">{note.thought}</div>
        </details>
      )}
    </div>
  )
}
