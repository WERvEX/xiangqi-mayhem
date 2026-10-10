import { useEffect, useMemo, useState } from 'react'
import { RULES_VERSION } from '../engine'
import {
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

const MODE_NAMES: Record<ReplayMode, string> = { hotseat: '同屏对战', ai: '人机对战', online: '联机对战' }

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
  const [copied, setCopied] = useState(false)
  const link = useMemo(() => replayLink(replay), [replay])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      prompt('复制下面的链接：', link)
    }
  }

  const save = () => {
    const stamp = replay.meta.date.slice(0, 16).replace(/[-:T]/g, '')
    download(`象棋大乱斗回放-${stamp}.json`, replayToFile(replay))
  }

  return (
    <Modal onClose={onClose} className="share">
      <h3>分享回放</h3>
      <p className="muted">链接里包含整局棋（共 {replay.actions.length} 步），对方打开就能观看，不需要服务器。</p>
      <div className="invite">
        <input readOnly value={link} onFocus={(e) => e.target.select()} />
        <button type="button" className="primary" onClick={copy}>
          {copied ? '已复制 ✓' : '复制链接'}
        </button>
      </div>
      <div className="modal-actions">
        <button type="button" onClick={save}>
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
      <h2>观看回放</h2>
      <section className="lobby-card">
        <h3>粘贴回放链接</h3>
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
          打开
        </button>
      </section>
      <section className="lobby-card">
        <h3>或者打开回放文件</h3>
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

export function ReplayView({ replay, onExit }: { replay: LoadedReplay; onExit: () => void }) {
  const last = replay.states.length - 1
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [sharing, setSharing] = useState(false)

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
        onRestart={() => {}}
        onShareReplay={() => setSharing(true)}
      />
      {sharing && <ReplayShareModal replay={replay} onClose={() => setSharing(false)} />}
    </>
  )
}
