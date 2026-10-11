import { useEffect, useState } from 'react'
import { SIDE_NAMES, type Side } from '../engine'
import { errorText } from '../llm/client'
import { ASSIST_LEVELS, PERSONAS, type AssistLevel, type PersonaId } from '../llm/prompt'
import { profileLabel, useProfiles, type StoredProfile } from '../llm/settings'
import { makeReplay, type Replay } from '../replay/replay'
import { ResumeCard } from './AiGame'
import { ConfirmModal, Modal } from './common'
import { GameView } from './GameView'
import {
  fmtTokens,
  notesForReplay,
  notesForSave,
  notesFromSave,
  sideView,
  speechList,
  taskFor,
  useTurnRecords,
  validNotes,
  type LiveNote,
  type LlmSideSave,
  type SavedNote,
} from './llmNotes'
import { ProfileEditor } from './LlmSettings'
import { SideNote } from './Notes'
import { ReplayShareModal } from './Replay'
import { clearSaved, loadSaved, useAutoSave, useSaved, type SavedGame } from './savedGame'
import { useFinishedGame } from './useFinishedGame'
import { useLlmSide, type LlmOptions } from './useLlmSide'
import { useLocalGame } from './useLocalGame'

/**
 * 模型斗蛐蛐：两个大模型对战，玩家观战。
 * 每个模型只看得到棋盘、双方的走法和公开的锦囊，看不到对方的思考；
 * 发言默认也互相听不到，打开「对喷模式」后才能听到对方上一句话。
 */

type Speed = 'slow' | 'normal' | 'fast'

const SPEEDS: Record<Speed, { name: string; ms: number }> = {
  slow: { name: '慢', ms: 4000 },
  normal: { name: '中', ms: 2000 },
  fast: { name: '快', ms: 0 },
}

interface EveSettings {
  red: LlmOptions
  black: LlmOptions
  /** 双方都发言 */
  speak: boolean
  /** 对喷模式：发言时能听到对方上一句 */
  hearOpponent: boolean
  speed: Speed
}

interface EveSave {
  settings: EveSettings
  notes: SavedNote[]
  red: LlmSideSave
  black: LlmSideSave
}

const SETTINGS_KEY = 'xqm-eve-settings'
const SIDES: Side[] = ['red', 'black']

const defaultSide = (persona: PersonaId): LlmOptions => ({
  profileId: '',
  assist: 'tactics',
  speak: true,
  persona,
  customPersona: '',
})

const DEFAULTS: EveSettings = {
  red: defaultSide('cocky'),
  black: defaultSide('strategist'),
  speak: true,
  hearOpponent: false,
  speed: 'normal',
}

function loadSettings(): EveSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '')
    const side = (s: Partial<LlmOptions> | undefined, d: LlmOptions): LlmOptions => {
      const merged = { ...d, ...s }
      if (!(merged.assist in ASSIST_LEVELS)) merged.assist = d.assist
      return merged
    }
    return {
      ...DEFAULTS,
      ...saved,
      red: side(saved.red, DEFAULTS.red),
      black: side(saved.black, DEFAULTS.black),
      speed: saved.speed in SPEEDS ? saved.speed : DEFAULTS.speed,
    }
  } catch {
    return DEFAULTS
  }
}

export function EveGame({ onExit, onOpenSettings, resume }: { onExit: () => void; onOpenSettings: () => void; resume?: boolean }) {
  const [game, setGame] = useState<{ settings: EveSettings; resume: SavedGame<EveSave> | null } | null>(() => {
    const saved = resume ? loadSaved<EveSave>('eve') : null
    return saved ? { settings: saved.extra.settings, resume: saved } : null
  })
  if (!game) {
    return (
      <EveSetup
        onStart={(settings) => {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
          setGame({ settings, resume: null })
        }}
        onResume={(saved) => setGame({ settings: saved.extra.settings, resume: saved })}
        onBack={onExit}
        onOpenSettings={onOpenSettings}
      />
    )
  }
  return <EveMatch settings={game.settings} resume={game.resume} onExit={onExit} onBack={() => setGame(null)} />
}

// ───────────── 设置 ─────────────

function EveSetup({
  onStart,
  onResume,
  onBack,
  onOpenSettings,
}: {
  onStart: (s: EveSettings) => void
  onResume: (saved: SavedGame<EveSave>) => void
  onBack: () => void
  onOpenSettings: () => void
}) {
  const [s, setS] = useState(loadSettings)
  const saved = useSaved<EveSave>('eve')
  const profiles = useProfiles()
  // 没选过或者选的配置被删了：默认用第一个
  const pick = (id: string) => (profiles.some((p) => p.id === id) ? id : (profiles[0]?.id ?? ''))
  const resolved: EveSettings = {
    ...s,
    red: { ...s.red, profileId: pick(s.red.profileId), speak: s.speak },
    black: { ...s.black, profileId: pick(s.black.profileId), speak: s.speak },
  }
  const setSide = (side: Side, patch: Partial<LlmOptions>) => setS((cur) => ({ ...cur, [side]: { ...cur[side], ...patch } }))

  return (
    <div className="lobby">
      <h2>模型斗蛐蛐</h2>
      <p className="muted lobby-note">选两个大模型对战，你来观战。每个模型只看得到棋盘和双方的走法，看不到对方的思考。</p>

      {saved && <ResumeCard saved={saved} onResume={() => onResume(saved)} onDiscard={() => clearSaved('eve')} />}

      {profiles.length === 0 ? (
        <section className="lobby-card">
          <p className="muted">还没有配置大模型。需要先填写模型服务商的接口地址和 API 密钥。</p>
          <button type="button" className="primary" onClick={onOpenSettings}>
            去配置模型
          </button>
        </section>
      ) : (
        <>
          {SIDES.map((side) => (
            <EveSideCard
              key={side}
              side={side}
              options={resolved[side]}
              profiles={profiles}
              onChange={(patch) => setSide(side, patch)}
            />
          ))}
          <button
            type="button"
            onClick={() => setS((cur) => ({ ...cur, red: cur.black, black: cur.red }))}
            title="交换双方的设置"
          >
            ⇅ 交换红黑
          </button>

          <section className="lobby-card">
            <h3>观战设置</h3>
            <div className="field-row">
              <span>速度</span>
              <div className="segmented">
                {(Object.keys(SPEEDS) as Speed[]).map((sp) => (
                  <button key={sp} type="button" className={s.speed === sp ? 'on' : ''} onClick={() => setS((cur) => ({ ...cur, speed: sp }))}>
                    {SPEEDS[sp].name}
                  </button>
                ))}
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={s.speak} onChange={(e) => setS((cur) => ({ ...cur, speak: e.target.checked }))} />
              双方每步发言（关掉可以省一半请求）
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.hearOpponent}
                disabled={!s.speak}
                onChange={(e) => setS((cur) => ({ ...cur, hearOpponent: e.target.checked }))}
              />
              对喷模式：模型能听到对方上一句话，互相回嘴（思考仍然完全隔离）
            </label>
            <p className="field-note">双方的请求都用各自模型配置的额度，一局通常要走 60–150 步。</p>
          </section>
          <button type="button" className="link" onClick={onOpenSettings}>
            管理模型 / API 设置
          </button>
        </>
      )}

      <button
        type="button"
        className="primary big"
        disabled={!resolved.red.profileId || !resolved.black.profileId}
        onClick={() => onStart(resolved)}
      >
        开始对局
      </button>
      <button type="button" onClick={onBack}>
        返回
      </button>
    </div>
  )
}

function EveSideCard({
  side,
  options,
  profiles,
  onChange,
}: {
  side: Side
  options: LlmOptions
  profiles: StoredProfile[]
  onChange: (patch: Partial<LlmOptions>) => void
}) {
  return (
    <section className={`lobby-card eve-side ${side}`}>
      <h3>
        <span className={`side-dot ${side}`} />
        {SIDE_NAMES[side]}
        {side === 'red' ? '（先手）' : '（后手）'}
      </h3>
      <label className="field-row">
        <span>模型</span>
        <select value={options.profileId} onChange={(e) => onChange({ profileId: e.target.value })}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {profileLabel(p)}
            </option>
          ))}
        </select>
      </label>
      <label className="field-row">
        <span>人设</span>
        <select value={options.persona} onChange={(e) => onChange({ persona: e.target.value as PersonaId })}>
          {(Object.keys(PERSONAS) as (keyof typeof PERSONAS)[]).map((id) => (
            <option key={id} value={id}>
              {PERSONAS[id].name}
            </option>
          ))}
          <option value="custom">自定义</option>
        </select>
      </label>
      {options.persona === 'custom' && (
        <input
          className="text-input"
          value={options.customPersona}
          maxLength={100}
          onChange={(e) => onChange({ customPersona: e.target.value })}
          placeholder="描述说话风格，如：东北大哥，爱讲段子"
        />
      )}
      <div className="field-row top">
        <span>辅助</span>
        <div>
          <div className="segmented small">
            {(Object.keys(ASSIST_LEVELS) as AssistLevel[]).map((level) => (
              <button
                key={level}
                type="button"
                className={options.assist === level ? 'on' : ''}
                onClick={() => onChange({ assist: level })}
              >
                {ASSIST_LEVELS[level].name}
              </button>
            ))}
          </div>
          <p className="field-note">{ASSIST_LEVELS[options.assist].desc}</p>
        </div>
      </div>
    </section>
  )
}

// ───────────── 对局 ─────────────

function EveMatch({
  settings,
  resume,
  onExit,
  onBack,
}: {
  settings: EveSettings
  resume: SavedGame<EveSave> | null
  onExit: () => void
  /** 回到设置页 */
  onBack: () => void
}) {
  const profiles = useProfiles()
  const game = useLocalGame(resume)
  const { state, states, seed, actions, dispatch, restart } = game
  const [notes, setNotes] = useState<LiveNote[]>(() => notesFromSave(resume?.extra.notes, resume?.actions ?? []))
  const [paused, setPaused] = useState(false)
  const [speed, setSpeed] = useState<Speed>(settings.speed)
  const [showThought, setShowThought] = useState(false)
  /** 实时显示双方的思维链（流式输出） */
  const [liveCot, setLiveCot] = useState(false)
  const [editing, setEditing] = useState<Side | null>(null)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [sharing, setSharing] = useState<Replay | null>(null)

  const history = useTurnRecords(actions, states)
  const liveNotes = validNotes(notes, actions, state, {
    red: taskFor(state, actions.length, 'red'),
    black: taskFor(state, actions.length, 'black'),
  })

  const profileOf = (side: Side) => profiles.find((p) => p.id === settings[side].profileId) ?? null
  const common = {
    state,
    actions,
    history,
    liveNotes,
    setNotes,
    dispatch,
    hearOpponent: settings.hearOpponent,
    minMoveMs: SPEEDS[speed].ms,
    paused,
    stream: liveCot,
  }
  const sides = {
    red: useLlmSide({ ...common, side: 'red', profile: profileOf('red'), options: settings.red, initial: resume?.extra.red }),
    black: useLlmSide({
      ...common,
      side: 'black',
      profile: profileOf('black'),
      options: settings.black,
      initial: resume?.extra.black,
    }),
  }

  const nameOf = (side: Side) => {
    const p = profileOf(side)
    if (!p) return '（配置已删除）'
    // 对局里只显示玩家给配置起的名字，不显示模型名
    return sides[side].takeover ? `${p.name}（规则 AI 接管）` : p.name
  }

  useAutoSave<EveSave>('eve', game, `${profileOf('red')?.name ?? '?'} vs ${profileOf('black')?.name ?? '?'}`, {
    settings: { ...settings, speed },
    notes: notesForSave(liveNotes),
    red: sides.red.save(),
    black: sides.black.save(),
  })

  // 开发模式下暴露给控制台，便于调试和测试（生产构建会移除）
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __xq: { state, dispatch } })
  })

  const buildReplay = () =>
    makeReplay(seed, actions, { mode: 'eve', red: nameOf('red'), black: nameOf('black') }, notesForReplay(liveNotes))
  const finished = useFinishedGame(state, buildReplay, null, liveNotes.length)

  const over = state.phase === 'over'
  const missing = SIDES.filter((side) => !profileOf(side))
  if (missing.length) {
    return (
      <div className="lobby">
        <p className="error-text">{missing.map((s) => SIDE_NAMES[s]).join('、')}的模型配置找不到了，可能已经被删除。</p>
        <button type="button" onClick={onBack}>
          返回设置
        </button>
      </div>
    )
  }

  const fatalSide = SIDES.find((side) => sides[side].fatal)
  const usageText = (side: Side) => {
    const u = sides[side].usage
    const fb = sideView(liveNotes, side).fallbacks
    return `${fmtTokens(u.input)} / ${fmtTokens(u.output)}${fb ? ` · ${fb} 步代走` : ''}`
  }

  let status: string
  if (over) status = state.winner ? `${SIDE_NAMES[state.winner]}（${nameOf(state.winner)}）获胜` : '和棋'
  else if (fatalSide) status = `${SIDE_NAMES[fatalSide]}请求失败，对局已暂停`
  else if (paused) status = '已暂停'
  else status = '对局进行中'

  const banner = (
    <div className="eve-banner">
      <div className={`conn-banner ${over ? 'ok' : paused || fatalSide ? 'warn' : 'ok'}`}>
        <span className="dot" /> {status}
      </div>
      <div className="eve-usage muted" title="本局累计 token 用量（输入 / 输出）">
        <span>
          <span className="side-dot red" />
          {usageText('red')}
        </span>
        <span>
          <span className="side-dot black" />
          {usageText('black')}
        </span>
      </div>
    </div>
  )

  const noteOf = (side: Side) => {
    const view = sideView(liveNotes, side)
    return (
      <SideNote
        side={side}
        name={nameOf(side)}
        speeches={speechList(liveNotes, side, states)}
        latest={view.latest}
        showThought={showThought}
        thinkingSec={sides[side].thinkingSec}
        onSkip={sides[side].skip}
        live={liveCot ? sides[side].live : null}
        warning={sides[side].slowThinking ? '这个模型在当前接口上关不掉思考，每步会比较慢。可以在模型设置里改用 OpenAI 兼容接口试试' : null}
      />
    )
  }

  const newGame = () => {
    clearSaved('eve')
    restart()
    setNotes([])
    sides.red.reset()
    sides.black.reset()
    setPaused(false)
  }

  const controls = (
    <>
      {!over && (
        <button type="button" className={paused ? 'on' : ''} onClick={() => setPaused((v) => !v)}>
          {paused ? '▶ 继续' : '⏸ 暂停'}
        </button>
      )}
      <span className="hint-control" title="每步之间至少停留多久">
        <select value={speed} onChange={(e) => setSpeed(e.target.value as Speed)} aria-label="速度">
          {(Object.keys(SPEEDS) as Speed[]).map((sp) => (
            <option key={sp} value={sp}>
              速度：{SPEEDS[sp].name}
            </option>
          ))}
        </select>
      </span>
      <button
        type="button"
        className={showThought ? 'on' : ''}
        onClick={() => setShowThought((v) => !v)}
        title="显示双方每一步的分析、备忘和推理过程"
      >
        🧠 {showThought ? '隐藏思考' : '显示思考'}
      </button>
      <button
        type="button"
        className={liveCot ? 'on' : ''}
        onClick={() => setLiveCot((v) => !v)}
        title="模型思考时实时显示它的思维链（下一次请求开始生效）"
      >
        📜 实时思维链
      </button>
      {over ? (
        <>
          <button type="button" onClick={finished.watch}>
            查看回放
          </button>
          <button type="button" className="primary" onClick={newGame}>
            再来一局
          </button>
        </>
      ) : (
        <button type="button" onClick={() => setConfirmEnd(true)}>
          结束对局
        </button>
      )}
      <button type="button" onClick={onBack}>
        更换设置
      </button>
    </>
  )

  return (
    <>
      {finished.reviewView}
      <div hidden={!!finished.reviewView}>
        <GameView
          key={seed}
          state={state}
          dispatch={() => {}}
          mySide={null}
          spectator
          labels={{ red: `（${profileOf('red')!.name}）`, black: `（${profileOf('black')!.name}）` }}
          banner={banner}
          onExit={onExit}
          onRestart={newGame}
          sideNotes={{ red: noteOf('red'), black: noteOf('black') }}
          extraControls={controls}
          onShareReplay={over && actions.length > 0 ? () => setSharing(buildReplay()) : undefined}
        />
      </div>

      {fatalSide && editing === null && (
        <Modal className="confirm">
          <h3>
            ⚠ {SIDE_NAMES[fatalSide]}（{nameOf(fatalSide)}）请求失败
          </h3>
          <p>{errorText(sides[fatalSide].fatal!.error)}</p>
          <div className="modal-actions wrap">
            <button type="button" onClick={() => setEditing(fatalSide)}>
              修改模型设置
            </button>
            <button type="button" onClick={sides[fatalSide].takeOver}>
              这一方改由规则 AI 接管
            </button>
            <button type="button" className="primary" onClick={sides[fatalSide].retry}>
              重试
            </button>
          </div>
        </Modal>
      )}
      {editing && (
        <Modal className="editor-modal">
          <ProfileEditor
            initial={profileOf(editing)!}
            onDone={() => {
              sides[editing].retry()
              setEditing(null)
            }}
          />
        </Modal>
      )}
      {confirmEnd && (
        <ConfirmModal
          title="结束这局？"
          message="对局会停止，存档也会删除。"
          confirmLabel="结束"
          danger
          onConfirm={() => {
            clearSaved('eve')
            onBack()
          }}
          onCancel={() => setConfirmEnd(false)}
        />
      )}
      {sharing && <ReplayShareModal replay={sharing} onClose={() => setSharing(null)} />}
    </>
  )
}
