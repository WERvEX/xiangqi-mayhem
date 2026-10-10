import { useEffect, useRef, useState } from 'react'
import { DIFFICULTIES, PERSONALITIES, type Difficulty, type Personality } from '../ai/bot'
import { BotClient } from '../ai/client'
import { other, type GameState, type Side } from '../engine'
import { makeReplay, type Replay } from '../replay/replay'
import { GameView } from './GameView'
import { ReplayShareModal } from './Replay'
import { useLocalGame } from './useLocalGame'

interface AiSettings {
  side: Side | 'random'
  difficulty: Difficulty
  personality: Personality
}

const SETTINGS_KEY = 'xqm-ai-settings'

function loadSettings(): AiSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '')
    if (saved.difficulty in DIFFICULTIES && saved.personality in PERSONALITIES) return saved
  } catch {
    // 没有保存过或格式不对，用默认值
  }
  return { side: 'red', difficulty: 'normal', personality: 'balanced' }
}

export function AiGame({ onExit }: { onExit: () => void }) {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [humanSide, setHumanSide] = useState<Side>('red')

  if (!settings) {
    return (
      <AiSetup
        onStart={(s) => {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
          setHumanSide(s.side === 'random' ? (Math.random() < 0.5 ? 'red' : 'black') : s.side)
          setSettings(s)
        }}
        onBack={onExit}
      />
    )
  }
  return <AiMatch settings={settings} humanSide={humanSide} onExit={onExit} onChangeSettings={() => setSettings(null)} />
}

function AiSetup({ onStart, onBack }: { onStart: (s: AiSettings) => void; onBack: () => void }) {
  const [s, setS] = useState(loadSettings)
  return (
    <div className="lobby">
      <h2>人机对战</h2>

      <section className="lobby-card">
        <h3>你执</h3>
        <div className="segmented">
          {(['red', 'black', 'random'] as const).map((p) => (
            <button key={p} type="button" className={s.side === p ? 'on' : ''} onClick={() => setS((cur) => ({ ...cur, side: p }))}>
              {p === 'random' ? '随机' : p === 'red' ? '红（先手）' : '黑（后手）'}
            </button>
          ))}
        </div>
      </section>

      <section className="lobby-card">
        <h3>难度</h3>
        <div className="option-grid">
          {(Object.keys(DIFFICULTIES) as Difficulty[]).map((d) => (
            <button
              key={d}
              type="button"
              className={`option ${s.difficulty === d ? 'on' : ''}`}
              onClick={() => setS((cur) => ({ ...cur, difficulty: d }))}
            >
              <b>{DIFFICULTIES[d].name}</b>
              <span>{DIFFICULTIES[d].desc}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="lobby-card">
        <h3>AI 性格</h3>
        <div className="option-grid three">
          {(Object.keys(PERSONALITIES) as Personality[]).map((p) => (
            <button
              key={p}
              type="button"
              className={`option ${s.personality === p ? 'on' : ''}`}
              onClick={() => setS((cur) => ({ ...cur, personality: p }))}
            >
              <b>{PERSONALITIES[p].name}</b>
              <span>{PERSONALITIES[p].desc}</span>
            </button>
          ))}
        </div>
      </section>

      <button type="button" className="primary big" onClick={() => onStart(s)}>
        开始对局
      </button>
      <button type="button" onClick={onBack}>
        返回主页
      </button>
    </div>
  )
}

function AiMatch({
  settings,
  humanSide,
  onExit,
  onChangeSettings,
}: {
  settings: AiSettings
  humanSide: Side
  onExit: () => void
  onChangeSettings: () => void
}) {
  const { state, seed, actions, canUndo, dispatch, undo, restart } = useLocalGame()
  const aiSide = other(humanSide)
  const [sharing, setSharing] = useState<Replay | null>(null)
  const botRef = useRef<BotClient | null>(null)

  const aiToAct = (s: GameState) =>
    (s.phase === 'play' && s.turn === aiSide) || (s.phase === 'draft' && !s.draft!.sides[aiSide].done)
  const humanToAct = (s: GameState) =>
    (s.phase === 'play' && s.turn === humanSide) || (s.phase === 'draft' && !s.draft!.sides[humanSide].done)
  const thinking = aiToAct(state)

  useEffect(() => () => botRef.current?.dispose(), [])

  // 轮到 AI 时让它思考；局面变化（包括悔棋）会作废尚未返回的结果
  const { difficulty, personality } = settings
  useEffect(() => {
    const mustAct =
      (state.phase === 'play' && state.turn === aiSide) || (state.phase === 'draft' && !state.draft!.sides[aiSide].done)
    if (!mustAct) return
    const bot = (botRef.current ??= new BotClient())
    let alive = true
    bot.think(state, aiSide, { difficulty, personality }).then((a) => {
      if (alive && a) dispatch(a)
    })
    return () => {
      alive = false
      bot.cancel()
    }
  }, [state, aiSide, difficulty, personality, dispatch])

  const aiName = `AI·${DIFFICULTIES[settings.difficulty].name}·${PERSONALITIES[settings.personality].name}`
  const labels = { [humanSide]: '（你）', [aiSide]: `（${aiName}）` }

  const banner = (
    <div className={`conn-banner ${thinking ? 'warn' : 'ok'}`}>
      {thinking ? (
        <>
          <span className="spinner small" /> {aiName} 思考中…
        </>
      ) : (
        <>
          <span className="dot" /> 对手：{aiName}
        </>
      )}
      <button type="button" onClick={onChangeSettings}>
        更换设置
      </button>
    </div>
  )

  return (
    <>
      <GameView
        key={seed}
        state={state}
        dispatch={dispatch}
        mySide={humanSide}
        labels={labels}
        banner={banner}
        onExit={onExit}
        // 连同 AI 的应对一起撤回，回到你上一次行动之前
        onUndo={canUndo ? () => undo(humanToAct) : undefined}
        onRestart={restart}
        onShareReplay={
          actions.length > 0
            ? () =>
                setSharing(
                  makeReplay(seed, actions, {
                    mode: 'ai',
                    [humanSide]: '玩家',
                    [aiSide]: aiName,
                  }),
                )
            : undefined
        }
      />
      {sharing && <ReplayShareModal replay={sharing} onClose={() => setSharing(null)} />}
    </>
  )
}
