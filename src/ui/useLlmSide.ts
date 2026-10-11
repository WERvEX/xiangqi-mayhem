import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { BotClient } from '../ai/client'
import { applyAction, other, type Action, type GameState, type Side } from '../engine'
import { LlmError, thinkingOffRejected, type LlmProfile, type Usage } from '../llm/client'
import { addUsage, comment, decide, ZERO_USAGE } from '../llm/player'
import {
  describeAction,
  needsEngine,
  PERSONAS,
  type AssistLevel,
  type CommentMoment,
  type PersonaId,
  type TurnRecord,
} from '../llm/prompt'
import { taskFor, thoughtOf, type LiveNote, type LlmSideSave } from './llmNotes'

/** 一方大模型的设置 */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const personaText = (o: LlmOptions) =>
  o.persona === 'custom' ? o.customPersona || PERSONAS.calm.prompt : PERSONAS[o.persona].prompt

/**
 * 驱动一方大模型：轮到它时发言、走棋（或选锦囊），失败时兜底，对局结束时说结束语。
 * 玩家对模型用一次，模型对模型用两次。发言与思考记录由调用方保存（双方共用一个列表，按 side 区分）。
 */
export function useLlmSide(p: {
  side: Side
  profile: LlmProfile | null
  options: LlmOptions
  state: GameState
  actions: Action[]
  history: TurnRecord[]
  /** 当前有效的记录（见 validNotes） */
  liveNotes: LiveNote[]
  setNotes: Dispatch<SetStateAction<LiveNote[]>>
  dispatch: (a: Action) => void
  /** 从存档恢复 */
  initial?: LlmSideSave
  /** 对喷模式：发言时能听到对方上一句话（走棋请求里永远没有） */
  hearOpponent?: boolean
  /** 每步至少花这么久（观战节奏） */
  minMoveMs?: number
  /** 暂停：不发起新请求；进行中的那步算完后也先不落子 */
  paused?: boolean
  /** 实时显示思维链：走棋请求改用流式输出（在下一次请求时生效） */
  stream?: boolean
}) {
  const { side, profile, options, state, actions, dispatch, setNotes } = p
  const [usage, setUsage] = useState<Usage>(p.initial?.usage ?? ZERO_USAGE)
  /** 规则 AI 接管本局剩下的部分 */
  const [takeover, setTakeover] = useState(p.initial?.takeover ?? false)
  const [fatal, setFatal] = useState<{ error: LlmError; task: string } | null>(null)
  const [timer, setTimer] = useState<{ task: string | null; at: number }>({ task: null, at: 0 })
  const [now, setNow] = useState(() => Date.now())
  /** 流式输出到目前为止的内容（按任务区分，换任务后作废） */
  const [live, setLive] = useState<{ task: string; reasoning: string; text: string } | null>(null)
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

  const task = taskFor(state, actions.length, side)

  // 让异步任务读到最新的值
  const latest = useRef(p)
  latest.current = p

  /** 上次这一方行动之后，对方做了什么 */
  const sinceLast = (acts: Action[], hist: TurnRecord[]) => {
    let j = acts.length - 1
    while (j >= 0 && acts[j].side !== side) j--
    return {
      theirs: hist.slice(j + 1).filter((r) => r.side !== side),
      /** 对方走了棋（只选了锦囊不算，没什么可评的） */
      moved: acts.slice(j + 1).some((a) => a.side !== side && a.type === 'move'),
      first: j < 0,
    }
  }

  /** 对喷模式：对方最近一句话 */
  const opponentSpeech = (notes: LiveNote[]) =>
    latest.current.hearOpponent
      ? notes
          .filter((n) => n.side === other(side) && n.speech)
          .sort((a, b) => a.i - b.i)
          .at(-1)?.speech
      : undefined

  const fallbackAction = (s: GameState) =>
    (botRef.current ??= new BotClient()).think(s, side, { difficulty: FALLBACK_LEVEL, personality: 'balanced' })

  // ───── 行动 ─────
  useEffect(() => {
    if (!task || !profile || fatal?.task === task) return
    const ctl = new AbortController()
    let cancelled = false
    let skipped = false
    skipRef.current = () => {
      skipped = true
      ctl.abort()
    }
    // 流式输出的内容攒一下再刷新界面，避免每个字都重新渲染
    let pendingLive: { reasoning: string; text: string } | null = null
    let liveTimer: ReturnType<typeof setTimeout> | null = null
    const onDelta = latest.current.stream
      ? (d: { reasoning: string; text: string }) => {
          pendingLive = d
          liveTimer ??= setTimeout(() => {
            liveTimer = null
            if (!cancelled && pendingLive) setLive({ task, ...pendingLive })
          }, 120)
        }
      : undefined
    const waitWhilePaused = async () => {
      while (latest.current.paused && !cancelled) await sleep(300)
    }

    const { state: s, history: hist, liveNotes: ns, actions: acts, options: opts } = latest.current
    const index = acts.length

    const finish = (action: Action, extra: Partial<LiveNote>) => {
      // 代走时记下走的是哪一步，对话框里会写明
      if (extra.fallback) {
        try {
          extra = { ...extra, fallbackMove: describeAction(s, action, applyAction(s, action)).text }
        } catch {
          // 局面已经变了（不太可能），就不写具体走法
        }
      }
      // 选锦囊时双方同时选，对方可能先选完，所以按落子时的步数记，而不是开始思考时的
      const at = latest.current.actions.length
      setNotes((cur) => {
        const pending = cur.find((n) => n.task === task && n.side === side && !n.action)
        return [...cur.filter((n) => n !== pending), { ...pending, i: at, side, task: undefined, action, ...extra }]
      })
      dispatch(action)
    }

    const run = async () => {
      await waitWhilePaused()
      if (cancelled) return
      const started = Date.now()
      const pace = async () => {
        const wait = started + (latest.current.minMoveMs ?? 0) - Date.now()
        if (wait > 0) await sleep(wait)
        await waitWhilePaused()
      }

      if (takeover) {
        const a = await fallbackAction(s)
        await pace()
        if (a && !cancelled) finish(a, {})
        return
      }

      // 发言与走棋同时请求：发言时模型还没决定走哪步，不会剧透
      const { theirs, moved, first } = sinceLast(acts, hist)
      let shownAt = 0
      // 开局先自我介绍，之后只在对方走了棋时点评
      const wantSpeech =
        opts.speak && (moved || first) && !ns.some((n) => n.task === task && n.side === side && n.speech)
      const speech = wantSpeech
        ? comment(
            profile,
            {
              state: s,
              side,
              opponentActions: theirs,
              moment: first ? 'opening' : 'reply',
              persona: personaText(opts),
              opponentSpeech: opponentSpeech(ns),
            },
            ctl.signal,
          )
            .then((r) => {
              setUsage((u) => addUsage(u, r.usage))
              if (cancelled || !r.text) return
              shownAt = Date.now()
              setNotes((cur) => [
                ...cur.filter((n) => n.task !== task || n.side !== side || n.action),
                { i: index, side, task, speech: r.text },
              ])
            })
            .catch(() => {})
        : Promise.resolve()

      const memo = [...ns].reverse().find((n) => n.side === side && n.action && n.memo !== undefined)?.memo ?? ''
      // 最近三步的决策和理由，帮助模型连贯地推理
      const decisions = ns
        .filter((n) => n.side === side && n.action && n.reason && hist[n.i])
        .sort((a, b) => a.i - b.i)
        .slice(-3)
        .map((n) => `第 ${hist[n.i].round} 回合 ${hist[n.i].text}：${n.reason}`)
      let action: Action | null
      let extra: Partial<LiveNote>
      try {
        // 战术检查：先让引擎给每个走法打分（在后台线程里，约 1 秒）
        let engine = null
        if (needsEngine(opts.assist) && s.phase === 'play') {
          engine = await (analyzerRef.current ??= new BotClient()).score(s, { maxDepth: 4, timeMs: 1200 })
          if (cancelled) return
        }
        const d = await decide(
          profile,
          { state: s, side, history: hist, memo, decisions, assist: opts.assist, engine },
          ctl.signal,
          onDelta,
        )
        setUsage((u) => addUsage(u, d.usage))
        if (d.ok) {
          action = d.action
          extra = { thought: thoughtOf(d), memo: d.memo ?? memo, reason: d.reason }
        } else {
          action = await fallbackAction(s)
          extra = { thought: thoughtOf(d), fallback: d.reason, memo }
        }
      } catch (e) {
        if (cancelled) return
        if (skipped) {
          action = await fallbackAction(s)
          extra = { fallback: '跳过了等待', memo }
        } else if (e instanceof LlmError) {
          setFatal({ error: e, task })
          return
        } else throw e
      }
      await speech
      const wait = shownAt ? shownAt + READ_MS - Date.now() : 0
      if (wait > 0) await sleep(wait)
      await pace()
      if (cancelled || !action) return
      finish(action, extra)
    }
    void run()

    return () => {
      cancelled = true
      ctl.abort()
      skipRef.current = null
      if (liveTimer) clearTimeout(liveTimer)
      // 取消的任务留下的发言作废
      setNotes((cur) => cur.filter((n) => n.task !== task || n.side !== side || !!n.action))
    }
    // 只在任务变化时重新开始；其余值通过 latest 读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, profile, fatal, takeover])

  // ───── 结束语 ─────
  const over = state.phase === 'over'
  useEffect(() => {
    if (!over || !options.speak || !profile || takeover) return
    const { state: s, history: hist, actions: acts, liveNotes: ns } = latest.current
    const index = acts.length
    const ctl = new AbortController()
    const moment: CommentMoment = s.winner === null ? 'draw' : s.winner === side ? 'win' : 'lose'
    const { theirs } = sinceLast(acts, hist)
    comment(
      profile,
      {
        state: s,
        side,
        opponentActions: theirs,
        moment,
        persona: personaText(latest.current.options),
        opponentSpeech: opponentSpeech(ns),
      },
      ctl.signal,
    )
      .then((r) => {
        setUsage((u) => addUsage(u, r.usage))
        if (r.text) setNotes((cur) => [...cur, { i: index, side, closing: true, speech: r.text }])
      })
      .catch(() => {})
    return () => ctl.abort()
    // 每局结束时说一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over])

  // 思考计时：任务变化时重新计时
  if (timer.task !== task) setTimer({ task, at: Date.now() })
  const busy = !!task && !fatal && !!profile
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [busy])

  return {
    task,
    busy,
    /** 实时思维链：这一步到目前为止的思考和回答 */
    live: live && live.task === task ? { reasoning: live.reasoning, text: live.text } : null,
    /** 这个模型在当前接口上关不掉思考（选了「关闭」但服务商不接受），每步会比较慢 */
    slowThinking: !!profile && thinkingOffRejected(profile),
    /** 正在思考时已等待的秒数，没在思考时为 null */
    thinkingSec: busy ? Math.max(0, Math.round((now - timer.at) / 1000)) : null,
    usage,
    takeover,
    fatal,
    /** 不等了，由规则 AI 代走这一步 */
    skip: () => skipRef.current?.(),
    retry: () => setFatal(null),
    /** 规则 AI 接管这一方剩下的对局 */
    takeOver: () => {
      setFatal(null)
      setTakeover(true)
    },
    /** 新开一局 */
    reset: () => {
      setUsage(ZERO_USAGE)
      setTakeover(false)
      setFatal(null)
    },
    save: (): LlmSideSave => ({ usage, takeover }),
  }
}
