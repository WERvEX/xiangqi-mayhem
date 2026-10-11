import { useEffect, useMemo, useRef, useState } from 'react'
import { BotClient } from '../ai/client'
import { other, type Action, type GameState, type Side } from '../engine'
import { errorText, LlmError, type Usage } from '../llm/client'
import { addUsage, comment, decide, ZERO_USAGE, type DecideResult } from '../llm/player'
import {
  describeAction,
  needsEngine,
  PERSONAS,
  type AssistLevel,
  type CommentMoment,
  type PersonaId,
  type TurnRecord,
} from '../llm/prompt'
import { profileLabel, useProfiles } from '../llm/settings'
import { makeReplay, parseReplay, replayToFile, type LoadedReplay, type Replay, type ReplayNote } from '../replay/replay'
import { Modal } from './common'
import { GameView } from './GameView'
import { ProfileEditor } from './LlmSettings'
import { SideNote } from './Notes'
import { ReplayShareModal, ReplayView } from './Replay'
import { clearSaved, useAutoSave } from './savedGame'
import { useLocalGame } from './useLocalGame'

export interface LlmOptions {
  profileId: string
  /** 辅助等级 */
  assist: AssistLevel
  /** 发言 */
  speak: boolean
  persona: PersonaId
  customPersona: string
}

/** 模型失败时代走的规则 AI 难度 */
const FALLBACK_LEVEL = 'hard'
/** 发言显示出来之后，至少停留这么久再落子 */
const READ_MS = 1500

/**
 * 对局中的发言与思考记录。
 * - 已落子：action 为对应的操作，悔棋撤回这个操作后自动失效
 * - 进行中：task 为当前任务的标识，任务取消时删除
 * - 结束语：closing 为 true，只在对局结束时显示
 */
interface LiveNote extends ReplayNote {
  action?: Action
  task?: string
  closing?: boolean
  memo?: string
}

/** 存档里的发言与思考（只存已落子的） */
export interface LlmSave {
  notes: (ReplayNote & { memo?: string })[]
  usage: Usage
  takeover: boolean
}

const thoughtOf = (d: DecideResult) =>
  [d.reasoning.trim(), d.analysis && `【分析】${d.analysis}`, d.ok && d.memo && `【备忘】${d.memo}`]
    .filter(Boolean)
    .join('\n\n')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const fmtTokens = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

export function LlmMatch({
  options,
  humanSide,
  onExit,
  onChangeSettings,
  resume,
  saveExtra,
}: {
  options: LlmOptions
  humanSide: Side
  onExit: () => void
  onChangeSettings: () => void
  /** 从存档恢复 */
  resume?: { seed: string; actions: Action[]; llm?: LlmSave } | null
  /** 存档时一起保存的对局设置 */
  saveExtra: object
}) {
  const profiles = useProfiles()
  const profile = profiles.find((p) => p.id === options.profileId) ?? null
  const game = useLocalGame(resume)
  const { state, states, seed, actions, canUndo, dispatch, undo, restart } = game
  const llmSide = other(humanSide)
  // 恢复存档时，发言记录要指回恢复出来的操作对象（有效性按对象判断）
  const [notes, setNotes] = useState<LiveNote[]>(
    () => resume?.llm?.notes.map((n) => ({ ...n, action: resume.actions[n.i] })) ?? [],
  )
  const [usage, setUsage] = useState<Usage>(resume?.llm?.usage ?? ZERO_USAGE)
  /** 对局中查看模型的思考（默认隐藏） */
  const [showThought, setShowThought] = useState(false)
  const [fatal, setFatal] = useState<{ error: LlmError; task: string } | null>(null)
  const [editing, setEditing] = useState(false)
  /** 规则 AI 接管本局剩下的部分 */
  const [takeover, setTakeover] = useState(resume?.llm?.takeover ?? false)
  const [sharing, setSharing] = useState<Replay | null>(null)
  /** 对局结束后的复盘（带思考的回放），看完回到对局 */
  const [review, setReview] = useState<LoadedReplay | null>(null)
  /** 当前任务开始的时间，用于显示"思考中… N 秒" */
  const [timer, setTimer] = useState<{ task: string | null; at: number }>({ task: null, at: 0 })
  const [now, setNow] = useState(() => Date.now())
  const skipRef = useRef<(() => void) | null>(null)
  const botRef = useRef<BotClient | null>(null)
  /** 给模型做战术检查用的引擎，和兜底的分开，互不打断 */
  const analyzerRef = useRef<BotClient | null>(null)

  useEffect(
    () => () => {
      botRef.current?.dispose()
      analyzerRef.current?.dispose()
    },
    [],
  )

  // 每一步操作的文字记录（按局面缓存，避免每次渲染都重新生成走法）
  const recordCache = useRef(new WeakMap<GameState, TurnRecord>())
  const history = useMemo(
    () =>
      actions.map((a, i) => {
        const next = states[i + 1]
        let r = recordCache.current.get(next)
        if (!r) {
          r = describeAction(states[i], a, next)
          recordCache.current.set(next, r)
        }
        return r
      }),
    [actions, states],
  )

  const llmToAct =
    (state.phase === 'play' && state.turn === llmSide) || (state.phase === 'draft' && !state.draft!.sides[llmSide].done)
  // 当前任务的标识：选锦囊时对方也在选，对方选完不应打断模型，所以按"第几次发放、第几次刷新"区分
  const task = !llmToAct
    ? null
    : state.phase === 'draft'
      ? `d${state.draft!.index}-${state.draft!.sides[llmSide].rerollNo}`
      : `p${actions.length}`

  const valid = (n: LiveNote) =>
    n.action ? actions[n.i] === n.action : n.task ? n.task === task : !!n.closing && state.phase === 'over' && n.i === actions.length
  const liveNotes = notes.filter(valid)

  useAutoSave('ai', game, `大模型 ${profile?.name ?? ''}`, {
    ...saveExtra,
    llm: {
      notes: liveNotes
        .filter((n) => n.action)
        .map(({ i, side, speech, thought, fallback, memo }) => ({ i, side, speech, thought, fallback, memo })),
      usage,
      takeover,
    } satisfies LlmSave,
  })

  // 让异步任务读到最新的值
  const latest = useRef({ state, history, liveNotes, actions })
  latest.current = { state, history, liveNotes, actions }

  const personaText = options.persona === 'custom' ? options.customPersona || PERSONAS.calm.prompt : PERSONAS[options.persona].prompt

  /** 上次模型行动之后，玩家做了什么 */
  const sinceLastLlm = (acts: Action[], hist: TurnRecord[]) => {
    let j = acts.length - 1
    while (j >= 0 && acts[j].side !== llmSide) j--
    return { theirs: hist.slice(j + 1).filter((r) => r.side !== llmSide), first: j < 0 }
  }

  const fallbackAction = async (s: GameState) => {
    const bot = (botRef.current ??= new BotClient())
    return bot.think(s, llmSide, { difficulty: FALLBACK_LEVEL, personality: 'balanced' })
  }

  // ───── 模型行动 ─────
  useEffect(() => {
    if (!task || !profile || fatal?.task === task) return
    const ctl = new AbortController()
    let cancelled = false
    let skipped = false
    skipRef.current = () => {
      skipped = true
      ctl.abort()
    }

    const { state: s, history: hist, liveNotes: ns, actions: acts } = latest.current
    const index = acts.length

    const finish = (action: Action, extra: Partial<LiveNote>) => {
      setNotes((cur) => {
        const pending = cur.find((n) => n.task === task && !n.action)
        return [
          ...cur.filter((n) => n !== pending),
          { ...pending, i: index, side: llmSide, task: undefined, action, ...extra },
        ]
      })
      dispatch(action)
    }

    const run = async () => {
      if (takeover) {
        const a = await fallbackAction(s)
        if (a && !cancelled) finish(a, {})
        return
      }

      // 发言与走棋同时请求：发言时模型还没决定走哪步，不会剧透
      const { theirs, first } = sinceLastLlm(acts, hist)
      let shownAt = 0
      const wantSpeech = options.speak && (theirs.length > 0 || first) && !ns.some((n) => n.task === task && n.speech)
      const speech = wantSpeech
        ? comment(
            profile,
            { state: s, side: llmSide, opponentActions: theirs, moment: theirs.length ? 'reply' : 'opening', persona: personaText },
            ctl.signal,
          )
            .then((r) => {
              setUsage((u) => addUsage(u, r.usage))
              if (cancelled || !r.text) return
              shownAt = Date.now()
              setNotes((cur) => [...cur.filter((n) => n.task !== task || n.action), { i: index, side: llmSide, task, speech: r.text }])
            })
            .catch(() => {})
        : Promise.resolve()

      const memo = [...ns].reverse().find((n) => n.action && n.memo !== undefined)?.memo ?? ''
      let action: Action | null
      let extra: Partial<LiveNote>
      try {
        // 战术检查：先让引擎给每个走法打分（在后台线程里，约 1 秒）
        let engine = null
        if (needsEngine(options.assist) && s.phase === 'play') {
          engine = await (analyzerRef.current ??= new BotClient()).score(s, { maxDepth: 4, timeMs: 1200 })
          if (cancelled) return
        }
        const d = await decide(
          profile,
          { state: s, side: llmSide, history: hist, memo, assist: options.assist, engine },
          ctl.signal,
        )
        setUsage((u) => addUsage(u, d.usage))
        if (d.ok) {
          action = d.action
          extra = { thought: thoughtOf(d), memo: d.memo ?? memo }
        } else {
          action = await fallbackAction(s)
          extra = { thought: thoughtOf(d), fallback: d.reason, memo }
        }
      } catch (e) {
        if (cancelled) return
        if (skipped) {
          action = await fallbackAction(s)
          extra = { fallback: '玩家跳过了等待', memo }
        } else if (e instanceof LlmError) {
          setFatal({ error: e, task })
          return
        } else throw e
      }
      await speech
      const wait = shownAt ? shownAt + READ_MS - Date.now() : 0
      if (wait > 0) await sleep(wait)
      if (cancelled || !action) return
      finish(action, extra)
    }
    void run()

    return () => {
      cancelled = true
      ctl.abort()
      skipRef.current = null
      // 取消的任务留下的发言作废
      setNotes((cur) => cur.filter((n) => n.task !== task || !!n.action))
    }
    // 只在任务变化时重新开始；其余值通过 latest 读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, profile, fatal, takeover])

  // ───── 结束语 ─────
  const over = state.phase === 'over'
  useEffect(() => {
    if (!over || !options.speak || !profile || takeover) return
    const { state: s, history: hist, actions: acts } = latest.current
    const index = acts.length
    const ctl = new AbortController()
    const moment: CommentMoment = s.winner === null ? 'draw' : s.winner === llmSide ? 'win' : 'lose'
    const { theirs } = sinceLastLlm(acts, hist)
    comment(profile, { state: s, side: llmSide, opponentActions: theirs, moment, persona: personaText }, ctl.signal)
      .then((r) => {
        setUsage((u) => addUsage(u, r.usage))
        if (r.text) setNotes((cur) => [...cur, { i: index, side: llmSide, closing: true, speech: r.text }])
      })
      .catch(() => {})
    return () => ctl.abort()
    // 每局结束时说一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over])

  // 开发模式下暴露给控制台，便于调试和测试（生产构建会移除）
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __xq: { state, dispatch } })
  })

  // 思考计时：任务变化时重新计时
  if (timer.task !== task) setTimer({ task, at: Date.now() })
  const busy = !!task && !fatal && !!profile
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [busy])

  if (!profile) {
    return (
      <div className="lobby">
        <p className="error-text">找不到这个模型配置，可能已经被删除了。</p>
        <button type="button" onClick={onChangeSettings}>
          返回设置
        </button>
      </div>
    )
  }

  const name = takeover ? `${profile.name}（规则 AI 接管）` : profileLabel(profile)
  const llmNotes = liveNotes.filter((n) => n.side === llmSide)
  const latestNote = llmNotes.reduce<LiveNote | null>((best, n) => (!best || n.i >= best.i ? n : best), null)
  const lastSpeech = [...llmNotes].sort((a, b) => a.i - b.i).findLast((n) => n.speech)
  const fallbacks = llmNotes.filter((n) => n.fallback).length

  const humanToMove = (s: GameState) => s.phase === 'play' && s.turn === humanSide

  const buildReplay = () => {
    const replayNotes: ReplayNote[] = liveNotes
      .filter((n) => n.speech || n.thought || n.fallback)
      .map(({ i, side, speech, thought, fallback }) => ({ i, side, speech, thought, fallback }))
      .sort((a, b) => a.i - b.i)
    return makeReplay(seed, actions, { mode: 'llm', [humanSide]: '玩家', [llmSide]: name }, replayNotes)
  }

  const banner = (
    <div className={`conn-banner ${busy ? 'warn' : 'ok'}`}>
      <span className="dot" /> 对手：{name}
      <span className="muted usage" title="本局累计 token 用量（输入 / 输出）">
        {fmtTokens(usage.input)} / {fmtTokens(usage.output)} tokens
        {fallbacks > 0 && ` · ${fallbacks} 步代走`}
      </span>
      <button type="button" onClick={onChangeSettings}>
        更换设置
      </button>
    </div>
  )

  const note = (
    <SideNote
      side={llmSide}
      name={name}
      note={
        latestNote
          ? {
              speech: lastSpeech?.speech,
              fallback: latestNote.fallback,
              thought: latestNote.thought,
            }
          : null
      }
      // 对局中思考对玩家隐藏，只在开发模式下显示，便于调提示词
      showThought={showThought}
      thinkingSec={busy ? Math.max(0, Math.round((now - timer.at) / 1000)) : null}
      onSkip={() => skipRef.current?.()}
    />
  )

  if (review) return <ReplayView replay={review} onExit={() => setReview(null)} exitLabel="返回对局" />

  return (
    <>
      <GameView
        key={seed}
        state={state}
        dispatch={dispatch}
        mySide={humanSide}
        labels={{ [humanSide]: '（你）', [llmSide]: `（${profile.name}）` }}
        banner={banner}
        onExit={onExit}
        onUndo={canUndo ? () => undo(humanToMove) : undefined}
        hints
        onRestart={() => {
          clearSaved('ai')
          restart()
          setNotes([])
          setUsage(ZERO_USAGE)
          setTakeover(false)
          setFatal(null)
        }}
        sideNotes={{ [llmSide]: note }}
        extraControls={
          <>
            <button
              type="button"
              className={showThought ? 'on' : ''}
              onClick={() => setShowThought((v) => !v)}
              title="显示模型每一步的分析、备忘和推理过程"
            >
              🧠 {showThought ? '隐藏思考' : over ? '查看思考' : '偷看思考'}
            </button>
            {over && (
              <button type="button" onClick={() => setReview(parseReplay(replayToFile(buildReplay())))}>
                复盘
              </button>
            )}
          </>
        }
        onShareReplay={actions.length > 0 ? () => setSharing(buildReplay()) : undefined}
      />

      {fatal && !editing && (
        <Modal className="confirm">
          <h3>⚠ 大模型请求失败</h3>
          <p>{errorText(fatal.error)}</p>
          <div className="modal-actions wrap">
            <button type="button" onClick={() => setEditing(true)}>
              修改模型设置
            </button>
            <button
              type="button"
              onClick={() => {
                setFatal(null)
                setTakeover(true)
              }}
            >
              改由规则 AI 接管本局
            </button>
            <button type="button" className="primary" onClick={() => setFatal(null)}>
              重试
            </button>
          </div>
        </Modal>
      )}
      {editing && (
        <Modal className="editor-modal">
          <ProfileEditor
            initial={profile}
            onDone={() => {
              setEditing(false)
              setFatal(null)
            }}
          />
        </Modal>
      )}
      {sharing && <ReplayShareModal replay={sharing} onClose={() => setSharing(null)} />}
    </>
  )
}
