import { useEffect, useMemo, useRef, useState } from 'react'
import { RULES_VERSION, SIDE_NAMES, type Side } from '../engine'
import { removeFromHistory, useHistory, type HistoryEntry } from '../replay/history'
import {
  hasNotes,
  parseReplay,
  replayToCode,
  replayToFile,
  ReplayError,
  type LoadedReplay,
  type Replay,
  type ReplayMode,
} from '../replay/replay'
import { GameView } from './GameView'
import { Modal } from './common'
import { SideNote } from './Notes'

const MODE_NAMES: Record<ReplayMode, string> = { hotseat: '同屏对战', ai: '人机对战', online: '联机对战', llm: '大模型对战' }

const replayLink = (r: Replay) => `${location.origin}${location.pathname}#replay=${replayToCode(r)}`

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ───────────── 分享 ─────────────

export function ReplayShareModal({ replay, onClose }: { replay: Replay; onClose: () => void }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const link = useMemo(() => replayLink(replay), [replay])
  const inputRef = useRef<HTMLInputElement>(null)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied('ok')
      setTimeout(() => setCopied(null), 2000)
    } catch {
      // 有的浏览器（如部分 App 内置浏览器）不允许写剪贴板：选中链接，让玩家手动复制
      inputRef.current?.select()
      setCopied('fail')
    }
  }

  const save = () => {
    const stamp = replay.meta.date.slice(0, 16).replace(/[-:T]/g, '')
    download(`象棋大乱斗回放-${stamp}.json`, replayToFile(replay))
  }

  const notes = hasNotes(replay)
  return (
    <Modal onClose={onClose} className="share">
      <h3>分享回放</h3>
      {notes ? (
        <p className="muted">
          <b className="accent">大模型的发言和思考只保存在回放文件里</b>，想让朋友看到请发送回放文件。链接里只有棋步（共{' '}
          {replay.actions.length} 步）。
        </p>
      ) : (
        <p className="muted">链接里包含整局棋（共 {replay.actions.length} 步），对方打开就能观看，不需要服务器。</p>
      )}
      <div className="invite">
        <input ref={inputRef} readOnly value={link} onFocus={(e) => e.target.select()} />
        <button type="button" className="primary" onClick={copy}>
          {copied === 'ok' ? '已复制 ✓' : '复制链接'}
        </button>
      </div>
      {copied === 'fail' && <p className="field-note warn">无法自动复制，链接已选中，请手动复制</p>}
      <div className="modal-actions">
        <button type="button" className={notes ? 'primary' : ''} onClick={save}>
          下载回放文件
        </button>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  )
}

// ───────────── 导入 ─────────────

export function ReplayImport({ onLoad, onBack }: { onLoad: (r: LoadedReplay) => void; onBack: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const tryLoad = (input: string) => {
    try {
      onLoad(parseReplay(input))
    } catch (e) {
      setError(e instanceof ReplayError ? e.message : '无法打开这个回放')
    }
  }

  return (
    <div className="lobby">
      <h2>对局记录</h2>
      <RecentGames onOpen={tryLoad} />
      <section className="lobby-card">
        <h3>打开别人分享的回放</h3>
        <p className="muted left">粘贴回放链接：</p>
        <textarea
          className="replay-input"
          rows={4}
          placeholder="https://…#replay=…"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
        />
        <button type="button" className="primary" disabled={!text.trim()} onClick={() => tryLoad(text)}>
          打开链接
        </button>
        <p className="muted left">或者选择回放文件：</p>
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (e) => {
            const file = e.target.files?.[0]
            if (file) tryLoad(await file.text())
          }}
        />
      </section>
      {error && <p className="error-text">{error}</p>}
      <button type="button" onClick={onBack}>
        返回主页
      </button>
    </div>
  )
}

// ───────────── 播放 ─────────────

const SPEEDS = [0.5, 1, 2, 4]

export function ReplayView({
  replay,
  onExit,
  exitLabel,
}: {
  replay: LoadedReplay
  onExit: () => void
  exitLabel?: string
}) {
  const last = replay.states.length - 1
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [sharing, setSharing] = useState(false)
  const [showSpeech, setShowSpeech] = useState(true)
  const [showThought, setShowThought] = useState(false)
  const notes = replay.notes ?? []

  // 自动播放；播到最后自然停下
  const isPlaying = playing && step < last
  useEffect(() => {
    if (!isPlaying) return
    const t = setTimeout(() => setStep((i) => Math.min(i + 1, last)), 900 / speed)
    return () => clearTimeout(t)
  }, [isPlaying, step, speed, last])

  // 键盘：← → 单步，空格播放/暂停
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowRight') setStep((i) => Math.min(i + 1, last))
      else if (e.key === 'ArrowLeft') setStep((i) => Math.max(i - 1, 0))
      else if (e.key === ' ') setPlaying((p) => !p)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [last])

  const goto = (i: number) => {
    setPlaying(false)
    setStep(Math.max(0, Math.min(i, last)))
  }

  const { meta } = replay
  const labels = { red: meta.red && `（${meta.red}）`, black: meta.black && `（${meta.black}）` }

  const banner = (
    <div className="replay-bar">
      <div className="replay-meta">
        <b>回放</b> · {MODE_NAMES[meta.mode]} · {new Date(meta.date).toLocaleString()}
        {replay.outdated && (
          <span className="warn"> · 来自旧版规则（v{replay.rules}，当前 v{RULES_VERSION}），效果可能不同</span>
        )}
      </div>
      <div className="replay-controls">
        <button type="button" onClick={() => goto(0)} title="回到开局">
          ⏮
        </button>
        <button type="button" onClick={() => goto(step - 1)} title="上一步（←）">
          ◀
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => {
            if (step >= last) setStep(0)
            setPlaying(!isPlaying)
          }}
          title="播放 / 暂停（空格）"
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button type="button" onClick={() => goto(step + 1)} title="下一步（→）">
          ▶▏
        </button>
        <button type="button" onClick={() => goto(last)} title="跳到结局">
          ⏭
        </button>
        <button
          type="button"
          onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
          title="播放速度"
        >
          {speed}×
        </button>
        {notes.length > 0 && (
          <>
            <button type="button" className={showSpeech ? 'on' : ''} onClick={() => setShowSpeech((v) => !v)} title="显示大模型的发言">
              💬 发言
            </button>
            <button type="button" className={showThought ? 'on' : ''} onClick={() => setShowThought((v) => !v)} title="显示大模型的思考">
              🧠 思考
            </button>
          </>
        )}
      </div>
      <input
        className="replay-scrub"
        type="range"
        min={0}
        max={last}
        value={step}
        onChange={(e) => goto(Number(e.target.value))}
      />
      <div className="muted replay-step">
        第 {step} / {last} 步
      </div>
    </div>
  )

  // 第 step 步时显示的内容：已经发生的操作（序号 < step）对应的发言与思考；结束语在最后一步显示
  const sidesWithNotes = (['red', 'black'] as Side[]).filter((side) => notes.some((n) => n.side === side))
  const sideNotes = sidesWithNotes.length
    ? Object.fromEntries(
        sidesWithNotes.map((side) => {
          const seen = notes.filter((n) => n.side === side && (n.i < step || (step === last && n.i === last)))
          const latest = seen.reduce<(typeof notes)[number] | null>((b, n) => (!b || n.i >= b.i ? n : b), null)
          const speech = seen.filter((n) => n.speech).at(-1)?.speech
          return [
            side,
            <SideNote
              key={side}
              side={side}
              name={meta[side] ?? ''}
              note={latest ? { speech: showSpeech ? speech : undefined, thought: latest.thought, fallback: latest.fallback } : null}
              showThought={showThought}
            />,
          ]
        }),
      )
    : undefined

  return (
    <>
      <GameView
        key={replay.seed}
        state={replay.states[step]}
        dispatch={() => {}}
        mySide={null}
        spectator
        labels={labels}
        banner={banner}
        onExit={onExit}
        exitLabel={exitLabel}
        onRestart={() => {}}
        onShareReplay={() => setSharing(true)}
        sideNotes={sideNotes}
      />
      {sharing && <ReplayShareModal replay={replay} onClose={() => setSharing(false)} />}
    </>
  )
}

// ───────────── 最近的对局 ─────────────

function resultText(e: HistoryEntry): string {
  if (!e.winner) return '和棋'
  if (e.mySide) return e.winner === e.mySide ? '胜' : '负'
  return `${SIDE_NAMES[e.winner]}胜`
}

function opponentText(e: HistoryEntry): string {
  if (e.mode === 'hotseat') return '同屏对战'
  if (e.mySide) {
    const opp = e.mySide === 'red' ? e.black : e.red
    return `执${e.mySide === 'red' ? '红' : '黑'} vs ${opp ?? MODE_NAMES[e.mode]}`
  }
  return `${e.red ?? '红方'} vs ${e.black ?? '黑方'}`
}

function RecentGames({ onOpen }: { onOpen: (file: string) => void }) {
  const history = useHistory()
  const [sharing, setSharing] = useState<Replay | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (history.length === 0) {
    return (
      <section className="lobby-card">
        <h3>最近的对局</h3>
        <p className="muted">还没有对局记录。每局结束后会自动保存在这台设备上（最多 20 局）。</p>
      </section>
    )
  }
  return (
    <section className="lobby-card">
      <h3>最近的对局</h3>
      <ul className="history-list">
        {history.map((e) => {
          const result = resultText(e)
          return (
            <li key={e.id}>
              <div className="history-main">
                <span className={`history-result ${result === '胜' ? 'win' : result === '负' ? 'lose' : ''}`}>{result}</span>
                <span className="history-title">{opponentText(e)}</span>
                <span className="muted history-sub">
                  {MODE_NAMES[e.mode]} · {e.rounds} 回合 · {new Date(e.savedAt).toLocaleString()}
                </span>
              </div>
              <div className="history-actions">
                <button type="button" className="primary" onClick={() => onOpen(e.file)}>
                  观看
                </button>
                <button
                  type="button"
                  onClick={() => {
                    try {
                      setSharing(parseReplay(e.file))
                    } catch (err) {
                      setError(err instanceof ReplayError ? err.message : '无法打开这个回放')
                    }
                  }}
                >
                  分享
                </button>
                <button type="button" onClick={() => removeFromHistory(e.id)} title="删除这条记录">
                  删除
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {error && <p className="error-text">{error}</p>}
      {sharing && <ReplayShareModal replay={sharing} onClose={() => setSharing(null)} />}
    </section>
  )
}
