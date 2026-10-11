import { useEffect, useState } from 'react'
import { other, type Action, type GameState, type Side } from '../engine'
import { errorText } from '../llm/client'
import { useProfiles } from '../llm/settings'
import { makeReplay, type Replay } from '../replay/replay'
import { Modal } from './common'
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
import { clearSaved, useAutoSave } from './savedGame'
import { useFinishedGame } from './useFinishedGame'
import { useLlmSide, type LlmOptions } from './useLlmSide'
import { useLocalGame } from './useLocalGame'

/** 存档里的大模型数据 */
export interface LlmSave extends LlmSideSave {
  notes: SavedNote[]
}

/** 玩家对战大模型 */
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
  const [notes, setNotes] = useState<LiveNote[]>(() => notesFromSave(resume?.llm?.notes, resume?.actions ?? []))
  /** 对局中查看模型的思考（默认隐藏） */
  const [showThought, setShowThought] = useState(false)
  /** 实时显示模型的思维链（流式输出） */
  const [liveCot, setLiveCot] = useState(false)
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState<Replay | null>(null)

  const history = useTurnRecords(actions, states)
  const liveNotes = validNotes(notes, actions, state, { [llmSide]: taskFor(state, actions.length, llmSide) })

  const llm = useLlmSide({
    side: llmSide,
    profile,
    options,
    state,
    actions,
    history,
    liveNotes,
    setNotes,
    dispatch,
    initial: resume?.llm,
    stream: liveCot,
  })

  useAutoSave('ai', game, `大模型 ${profile?.name ?? ''}`, {
    ...saveExtra,
    llm: { notes: notesForSave(liveNotes), ...llm.save() } satisfies LlmSave,
  })

  // 开发模式下暴露给控制台，便于调试和测试（生产构建会移除）
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __xq: { state, dispatch } })
  })

  // 对局里只显示玩家给配置起的名字，不显示模型名
  const name = !profile ? '' : llm.takeover ? `${profile.name}（规则 AI 接管）` : profile.name
  const buildReplay = () =>
    makeReplay(seed, actions, { mode: 'llm', [humanSide]: '玩家', [llmSide]: name }, notesForReplay(liveNotes))
  // 结束语稍后才到，发言条数变化时重新存进对局记录
  const finished = useFinishedGame(state, buildReplay, humanSide, liveNotes.length)

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

  const over = state.phase === 'over'
  const view = sideView(liveNotes, llmSide)
  const humanToMove = (s: GameState) => s.phase === 'play' && s.turn === humanSide

  const banner = (
    <div className={`conn-banner ${llm.busy ? 'warn' : 'ok'}`}>
      <span className="dot" /> 对手：{name}
      <span className="muted usage" title="本局累计 token 用量（输入 / 输出）">
        {fmtTokens(llm.usage.input)} / {fmtTokens(llm.usage.output)} tokens
        {view.fallbacks > 0 && ` · ${view.fallbacks} 步代走`}
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
      speeches={speechList(liveNotes, llmSide, states)}
      latest={view.latest}
      // 对局中思考默认隐藏，玩家可以点「偷看思考」
      showThought={showThought}
      thinkingSec={llm.thinkingSec}
      onSkip={llm.skip}
      live={liveCot ? llm.live : null}
      warning={llm.slowThinking ? '这个模型在当前接口上关不掉思考，每步会比较慢。可以在模型设置里改用 OpenAI 兼容接口试试' : null}
    />
  )

  return (
    <>
      {finished.reviewView}
      <div hidden={!!finished.reviewView}>
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
            llm.reset()
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
              <button
                type="button"
                className={liveCot ? 'on' : ''}
                onClick={() => setLiveCot((v) => !v)}
                title="模型思考时实时显示它的思维链（下一次请求开始生效）"
              >
                📜 实时思维链
              </button>
            </>
          }
          onShareReplay={actions.length > 0 ? () => setSharing(buildReplay()) : undefined}
          onWatchReplay={finished.watch}
        />
      </div>

      {llm.fatal && !editing && (
        <Modal className="confirm">
          <h3>⚠ 大模型请求失败</h3>
          <p>{errorText(llm.fatal.error)}</p>
          <div className="modal-actions wrap">
            <button type="button" onClick={() => setEditing(true)}>
              修改模型设置
            </button>
            <button type="button" onClick={llm.takeOver}>
              改由规则 AI 接管本局
            </button>
            <button type="button" className="primary" onClick={llm.retry}>
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
              llm.retry()
            }}
          />
        </Modal>
      )}
      {sharing && <ReplayShareModal replay={sharing} onClose={() => setSharing(null)} />}
    </>
  )
}
