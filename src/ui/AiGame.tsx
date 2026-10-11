import { useEffect, useRef, useState } from 'react'
import { DIFFICULTIES, PERSONALITIES, type Difficulty, type Personality } from '../ai/bot'
import { BotClient } from '../ai/client'
import { other, type GameState, type Side } from '../engine'
import { ASSIST_LEVELS, PERSONAS, type AssistLevel, type PersonaId } from '../llm/prompt'
import { profileLabel, useProfiles } from '../llm/settings'
import { makeReplay, type Replay } from '../replay/replay'
import { GameView } from './GameView'
import { LlmMatch, type LlmOptions, type LlmSave } from './LlmGame'
import { ReplayShareModal } from './Replay'
import { clearSaved, loadSaved, useAutoSave, useSaved, type SavedGame } from './savedGame'
import { useLocalGame } from './useLocalGame'

type Opponent = 'rule' | 'llm'

interface AiSettings {
  side: Side | 'random'
  opponent: Opponent
  difficulty: Difficulty
  personality: Personality
  llm: LlmOptions
}

const SETTINGS_KEY = 'xqm-ai-settings'

/** 人机对局存档里的额外数据 */
interface AiSave {
  settings: AiSettings
  humanSide: Side
  llm?: LlmSave
}

const DEFAULTS: AiSettings = {
  side: 'red',
  opponent: 'rule',
  difficulty: 'normal',
  personality: 'balanced',
  llm: { profileId: '', assist: 'tactics', speak: true, persona: 'cocky', customPersona: '' },
}

function loadSettings(): AiSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '')
    if (saved.difficulty in DIFFICULTIES && saved.personality in PERSONALITIES) {
      const llm = { ...DEFAULTS.llm, ...saved.llm }
      if (!(llm.assist in ASSIST_LEVELS)) llm.assist = DEFAULTS.llm.assist
      return { ...DEFAULTS, ...saved, llm }
    }
  } catch {
    // 没有保存过或格式不对，用默认值
  }
  return DEFAULTS
}

export function AiGame({
  initialOpponent,
  resume: autoResume,
  onExit,
  onOpenSettings,
}: {
  /** 预选的对手类型 */
  initialOpponent?: Opponent
  /** 直接继续上一局（从主页的"继续上一局"进来） */
  resume?: boolean
  onExit: () => void
  /** 打开大模型 API 设置 */
  onOpenSettings: () => void
}) {
  const [game, setGame] = useState<{ settings: AiSettings; humanSide: Side; resume: SavedGame<AiSave> | null } | null>(
    () => {
      const saved = autoResume ? loadSaved<AiSave>('ai') : null
      return saved ? { settings: saved.extra.settings, humanSide: saved.extra.humanSide, resume: saved } : null
    },
  )

  if (!game) {
    return (
      <AiSetup
        initialOpponent={initialOpponent}
        onStart={(s) => {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
          const humanSide = s.side === 'random' ? (Math.random() < 0.5 ? 'red' : 'black') : s.side
          setGame({ settings: s, humanSide, resume: null })
        }}
        onResume={(saved) => setGame({ settings: saved.extra.settings, humanSide: saved.extra.humanSide, resume: saved })}
        onBack={onExit}
        onOpenSettings={onOpenSettings}
      />
    )
  }
  const { settings, humanSide, resume } = game
  const back = () => setGame(null)
  if (settings.opponent === 'llm') {
    return (
      <LlmMatch
        options={settings.llm}
        humanSide={humanSide}
        onExit={onExit}
        onChangeSettings={back}
        resume={resume ? { seed: resume.seed, actions: resume.actions, llm: resume.extra.llm } : null}
        saveExtra={{ settings, humanSide }}
      />
    )
  }
  return <AiMatch settings={settings} humanSide={humanSide} resume={resume} onExit={onExit} onChangeSettings={back} />
}

/** "继续上一局"卡片 */
export function ResumeCard({ saved, onResume, onDiscard }: { saved: SavedGame; onResume: () => void; onDiscard: () => void }) {
  return (
    <section className="lobby-card highlight resume-card">
      <h3>有一局没下完</h3>
      <p>
        {saved.label}
        <span className="muted"> · {new Date(saved.savedAt).toLocaleString()}</span>
      </p>
      <div className="modal-actions">
        <button type="button" onClick={onDiscard}>
          放弃
        </button>
        <button type="button" className="primary" onClick={onResume}>
          继续上一局
        </button>
      </div>
    </section>
  )
}

function AiSetup({
  initialOpponent,
  onStart,
  onResume,
  onBack,
  onOpenSettings,
}: {
  initialOpponent?: Opponent
  onStart: (s: AiSettings) => void
  onResume: (saved: SavedGame<AiSave>) => void
  onBack: () => void
  onOpenSettings: () => void
}) {
  const saved = useSaved<AiSave>('ai')
  const [s, setS] = useState(() => {
    const saved = loadSettings()
    return initialOpponent ? { ...saved, opponent: initialOpponent } : saved
  })
  const profiles = useProfiles()
  const profileId = profiles.some((p) => p.id === s.llm.profileId) ? s.llm.profileId : (profiles[0]?.id ?? '')
  const setLlm = (patch: Partial<LlmOptions>) => setS((cur) => ({ ...cur, llm: { ...cur.llm, ...patch } }))
  const isLlm = s.opponent === 'llm'

  return (
    <div className="lobby">
      <h2>挑战 AI</h2>

      {saved && <ResumeCard saved={saved} onResume={() => onResume(saved)} onDiscard={() => clearSaved('ai')} />}

      <section className="lobby-card">
        <h3>对手</h3>
        <div className="segmented">
          {(['rule', 'llm'] as const).map((o) => (
            <button
              key={o}
              type="button"
              className={s.opponent === o ? 'on' : ''}
              onClick={() => setS((cur) => ({ ...cur, opponent: o }))}
            >
              {o === 'rule' ? '规则 AI' : '大模型'}
            </button>
          ))}
        </div>
      </section>

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

      {isLlm ? (
        <LlmSetup
          options={{ ...s.llm, profileId }}
          profiles={profiles.map((p) => ({ id: p.id, label: profileLabel(p) }))}
          onChange={setLlm}
          onOpenSettings={onOpenSettings}
        />
      ) : (
        <>
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
        </>
      )}

      <button
        type="button"
        className="primary big"
        disabled={isLlm && !profileId}
        onClick={() => onStart({ ...s, llm: { ...s.llm, profileId } })}
      >
        开始对局
      </button>
      <button type="button" onClick={onBack}>
        返回
      </button>
    </div>
  )
}

function LlmSetup({
  options,
  profiles,
  onChange,
  onOpenSettings,
}: {
  options: LlmOptions
  profiles: { id: string; label: string }[]
  onChange: (patch: Partial<LlmOptions>) => void
  onOpenSettings: () => void
}) {
  return (
    <>
      <section className="lobby-card">
        <h3>模型</h3>
        {profiles.length === 0 ? (
          <p className="muted">还没有配置大模型。需要先填写模型服务商的接口地址和 API 密钥。</p>
        ) : (
          <select value={options.profileId} onChange={(e) => onChange({ profileId: e.target.value })}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        <button type="button" onClick={onOpenSettings}>
          {profiles.length === 0 ? '去配置模型' : '管理模型 / API 设置'}
        </button>
      </section>

      <section className="lobby-card">
        <h3>发言人设</h3>
        <div className="option-grid">
          {(Object.keys(PERSONAS) as PersonaId[]).map((id) =>
            id === 'custom' ? null : (
              <button
                key={id}
                type="button"
                className={`option ${options.persona === id ? 'on' : ''}`}
                onClick={() => onChange({ persona: id })}
              >
                <b>{PERSONAS[id].name}</b>
              </button>
            ),
          )}
          <button
            type="button"
            className={`option ${options.persona === 'custom' ? 'on' : ''}`}
            onClick={() => onChange({ persona: 'custom' })}
          >
            <b>自定义</b>
          </button>
        </div>
        {options.persona === 'custom' && (
          <input
            className="text-input"
            value={options.customPersona}
            maxLength={100}
            onChange={(e) => onChange({ customPersona: e.target.value })}
            placeholder="描述说话风格，如：东北大哥，爱讲段子"
          />
        )}
        <label className="check">
          <input type="checkbox" checked={options.speak} onChange={(e) => onChange({ speak: e.target.checked })} />
          每步发言（关掉可以省一半请求）
        </label>
      </section>

      <section className="lobby-card">
        <h3>给模型的辅助</h3>
        <div className="option-grid">
          {(Object.keys(ASSIST_LEVELS) as AssistLevel[]).map((level) => (
            <button
              key={level}
              type="button"
              className={`option ${options.assist === level ? 'on' : ''}`}
              onClick={() => onChange({ assist: level })}
            >
              <b>{ASSIST_LEVELS[level].name}</b>
              <span>{ASSIST_LEVELS[level].desc}</span>
            </button>
          ))}
        </div>
      </section>
    </>
  )
}

function AiMatch({
  settings,
  humanSide,
  resume,
  onExit,
  onChangeSettings,
}: {
  settings: AiSettings
  humanSide: Side
  resume: SavedGame<AiSave> | null
  onExit: () => void
  onChangeSettings: () => void
}) {
  const game = useLocalGame(resume)
  const { state, seed, actions, canUndo, dispatch, undo, restart } = game
  const aiSide = other(humanSide)
  const [sharing, setSharing] = useState<Replay | null>(null)
  const botRef = useRef<BotClient | null>(null)

  const aiToAct = (s: GameState) =>
    (s.phase === 'play' && s.turn === aiSide) || (s.phase === 'draft' && !s.draft!.sides[aiSide].done)
  // 悔棋只停在轮到你走棋的局面：锦囊选择跟着它前面那步棋一起撤回
  const humanToMove = (s: GameState) => s.phase === 'play' && s.turn === humanSide
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

  // 开发模式下暴露给控制台，便于调试和测试（生产构建会移除）
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __xq: { state, dispatch } })
  })

  const aiName = `AI·${DIFFICULTIES[settings.difficulty].name}·${PERSONALITIES[settings.personality].name}`
  useAutoSave<AiSave>('ai', game, `规则 ${aiName}`, { settings, humanSide })
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
        onUndo={canUndo ? () => undo(humanToMove) : undefined}
        hints
        onRestart={() => {
          clearSaved('ai')
          restart()
        }}
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
