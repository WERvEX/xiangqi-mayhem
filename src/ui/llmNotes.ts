import { useMemo } from 'react'
import { roundOf, type Action, type GameState, type Side } from '../engine'
import type { Usage } from '../llm/client'
import type { DecideResult } from '../llm/player'
import { describeAction, type TurnRecord } from '../llm/prompt'
import type { ReplayNote } from '../replay/replay'
import type { Speech } from './Notes'

/**
 * 大模型对局（玩家对模型、模型对模型）共用的发言与思考记录。
 * - 已落子：action 为对应的操作，悔棋撤回这个操作后自动失效
 * - 进行中：task 为当前任务的标识，任务取消时删除
 * - 结束语：closing 为 true，只在对局结束时显示
 */
export interface LiveNote extends ReplayNote {
  action?: Action
  task?: string
  closing?: boolean
  /** 作战笔记：模型留给下一步自己的策略、计划、要提防的威胁 */
  memo?: string
  /** 这一步的理由（下一步放进"你最近几步的决策"） */
  reason?: string
}

/** 存档里一方模型的数据（发言与思考只存已落子的） */
export interface LlmSideSave {
  usage: Usage
  takeover: boolean
}

export type SavedNote = ReplayNote & { memo?: string; reason?: string }

/** 一方当前的任务标识：没轮到它时为 null。选锦囊时双方同时选，对方选完不应打断，所以按"第几次发放、第几次刷新"区分 */
export function taskFor(state: GameState, actionCount: number, side: Side): string | null {
  if (state.phase === 'draft') {
    const ds = state.draft!.sides[side]
    return ds.done ? null : `d${state.draft!.index}-${ds.rerollNo}`
  }
  return state.phase === 'play' && state.turn === side ? `p${actionCount}` : null
}

/**
 * 筛出当前仍然有效的记录。
 * 已落子的记录按操作对象判断：步数对不上时（如双方同时选锦囊、几乎同时落子），按操作实际所在的位置修正，而不是丢掉
 */
export function validNotes(
  notes: LiveNote[],
  actions: Action[],
  state: GameState,
  tasks: Partial<Record<Side, string | null>>,
): LiveNote[] {
  const out: LiveNote[] = []
  for (const n of notes) {
    if (n.action) {
      if (actions[n.i] === n.action) out.push(n)
      else {
        const i = actions.lastIndexOf(n.action)
        if (i >= 0) out.push({ ...n, i })
      }
    } else if (n.task ? n.task === tasks[n.side] : !!n.closing && state.phase === 'over' && n.i === actions.length) {
      out.push(n)
    }
  }
  return out
}

/** 给玩家看的思考：结构化的局面判断、理由、策略和计划，最后是模型自带的推理过程 */
export const thoughtOf = (d: DecideResult) =>
  [d.analysis, d.ok && d.memo, d.reasoning.trim() && `【推理过程】\n${d.reasoning.trim()}`].filter(Boolean).join('\n\n')

/** 回放里的发言与思考 */
export const notesForReplay = (notes: LiveNote[]): ReplayNote[] =>
  notes
    .filter((n) => n.speech || n.thought || n.fallback)
    .map(({ i, side, speech, thought, fallback, fallbackMove }) => ({ i, side, speech, thought, fallback, fallbackMove }))
    .sort((a, b) => a.i - b.i)

/** 存档里的发言与思考（只存已落子的） */
export const notesForSave = (notes: LiveNote[]): SavedNote[] =>
  notes
    .filter((n) => n.action)
    .map(({ i, side, speech, thought, fallback, fallbackMove, memo, reason }) => ({
      i,
      side,
      speech,
      thought,
      fallback,
      fallbackMove,
      memo,
      reason,
    }))

/** 从存档恢复：记录要指回恢复出来的操作对象（有效性按对象判断） */
export const notesFromSave = (saved: SavedNote[] | undefined, actions: Action[]): LiveNote[] =>
  saved?.map((n) => ({ ...n, action: actions[n.i] })) ?? []

/** 一方最新的发言和最新一条记录（用于对话气泡） */
export function sideView(notes: LiveNote[], side: Side) {
  const mine = notes.filter((n) => n.side === side).sort((a, b) => a.i - b.i)
  return {
    // 最近一条带思考或兜底说明的记录（正在思考时，最新的那条只有发言）
    latest: mine.findLast((n) => n.thought || n.fallback) ?? null,
    fallbacks: mine.filter((n) => n.fallback).length,
  }
}

/** 操作记录按"操作之后的局面"缓存：局面对象不可变，不会过期 */
const recordCache = new WeakMap<GameState, TurnRecord>()

/**
 * 对话框里最近的几条，最新的在前：模型的发言，以及"规则 AI 代走了哪一步"这样的系统消息。
 * states[k] 是第 k 个操作之前的局面，用来标出第几回合
 */
export function speechList(notes: ReplayNote[], side: Side, states: GameState[], max = 12): Speech[] {
  const items: (Speech & { i: number; order: number })[] = []
  for (const n of notes) {
    if (n.side !== side) continue
    const round = roundOf(states[Math.min(n.i, states.length - 1)])
    // 同一步里先说话、后落子：代走的系统消息排在发言之后（显示时在上面）
    if (n.speech) items.push({ key: `s${n.i}-${n.speech}`, text: n.speech, round, kind: 'speech', i: n.i, order: 0 })
    if (n.fallback) {
      const what = n.fallbackMove ? `规则 AI 代走了「${n.fallbackMove}」` : '规则 AI 代走了这一步'
      items.push({ key: `f${n.i}`, text: `${what}：${n.fallback}`, round, kind: 'system', i: n.i, order: 1 })
    }
  }
  return items
    .sort((a, b) => b.i - a.i || b.order - a.order)
    .slice(0, max)
    .map(({ key, text, round, kind }) => ({ key, text, round, kind }))
}

/** 每一步操作的文字记录（缓存起来，避免每次渲染都重新生成走法） */
export function useTurnRecords(actions: Action[], states: GameState[]): TurnRecord[] {
  return useMemo(
    () =>
      actions.map((a, i) => {
        const next = states[i + 1]
        let r = recordCache.get(next)
        if (!r) {
          r = describeAction(states[i], a, next)
          recordCache.set(next, r)
        }
        return r
      }),
    [actions, states],
  )
}

export const fmtTokens = (n: number) =>
  n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
