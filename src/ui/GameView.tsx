import { useMemo, useState, type ReactNode } from 'react'
import {
  AUGMENTS,
  kingThreat,
  exposesKing,
  findKing,
  legalMoves,
  material,
  nextDraftRound,
  other,
  pieceAt,
  roundOf,
  PIECE_CHARS,
  SIDE_NAMES,
  TIER_NAMES,
  type Action,
  type GameState,
  type Move,
  type Piece,
  type Pos,
  type Side,
} from '../engine'
import { DIFFICULTIES, type Difficulty } from '../ai/bot'
import { Board, type FxItem } from './Board'
import { AugmentCard, AugmentChip, AugmentGlyph, ConfirmModal, Modal, Rules } from './common'
import { useHint } from './Hint'

const SIDES: Side[] = ['red', 'black']

export interface GameViewProps {
  state: GameState
  dispatch: (action: Action) => void
  /** 联机时为自己执子的一方；同屏对战为 null，双方都由本机操作 */
  mySide: Side | null
  onExit: () => void
  /** 退出按钮的文字，默认"主页" */
  exitLabel?: string
  /** 只有同屏对战提供悔棋 */
  onUndo?: () => void
  onRestart: () => void
  restartLabel?: string
  restartDisabled?: boolean
  /** 显示在顶部的提示条（联机状态等） */
  banner?: ReactNode
  /** 观战模式（回放）：不能操作，只显示棋局 */
  spectator?: boolean
  /** 自定义双方的称呼，如"（AI·困难）" */
  labels?: Partial<Record<Side, string>>
  /** 额外的控制按钮 */
  extraControls?: ReactNode
  /** 提供时，对局结束后显示"分享回放" */
  onShareReplay?: () => void
  /** 提供时，对局结束后可以直接查看回放 */
  onWatchReplay?: () => void
  /** 额外的悔棋入口文字（联机为"申请悔棋"） */
  undoLabel?: string
  /** 是否提供 AI 走法推荐（联机和回放中关闭） */
  hints?: boolean
  /** 大模型的发言等：宽屏时显示在棋盘两侧，窄屏时显示在对应一方的信息栏旁 */
  sideNotes?: Partial<Record<Side, ReactNode>>
}

/** 对局界面。新开一局时请用 key 重新挂载，以重置界面状态。 */
export function GameView({
  state,
  dispatch,
  mySide,
  onExit,
  exitLabel = '主页',
  onUndo,
  onRestart,
  restartLabel = '再来一局',
  restartDisabled = false,
  banner,
  spectator = false,
  labels,
  extraControls,
  onShareReplay,
  onWatchReplay,
  undoLabel = '悔棋',
  hints = false,
  sideNotes,
}: GameViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [flipped, setFlipped] = useState(mySide === 'black')
  const [pendingMove, setPendingMove] = useState<Move | null>(null)
  const [overDismissed, setOverDismissed] = useState(false)
  const [draftHidden, setDraftHidden] = useState(false)
  const [infoId, setInfoId] = useState<string | null>(null)
  const [showRules, setShowRules] = useState(false)
  const [confirmResign, setConfirmResign] = useState(false)

  const [fx, setFx] = useState<FxItem[]>([])
  const [ghosts, setGhosts] = useState<Piece[]>([])

  // 局面变化（包括对方的操作、悔棋）时清掉临时的界面状态，并播放这一步产生的特效
  const [prevState, setPrevState] = useState(state)
  if (state !== prevState) {
    setPrevState(state)
    setSelectedId(null)
    setPendingMove(null)
    setDraftHidden(false)
    if (state.phase !== 'over') setOverDismissed(false)
    const forward = state.log.length > prevState.log.length
    const fresh = forward ? state.log.slice(prevState.log.length) : []
    setFx(
      fresh.flatMap((e, i) => (e.fx ? [{ key: `${state.log.length}-${i}`, kind: e.fx.kind, pos: e.fx.pos }] : [])),
    )
    const wasAlive = new Map(prevState.pieces.filter((p) => p.alive).map((p) => [p.id, p]))
    setGhosts(forward ? state.pieces.filter((p) => !p.alive && wasAlive.has(p.id)).map((p) => wasAlive.get(p.id)!) : [])
  }

  const canAct = (side: Side) => mySide === null || mySide === side
  const myTurn = !spectator && state.phase === 'play' && canAct(state.turn)

  const moves = useMemo(() => legalMoves(state), [state])
  const extra = state.extraMoves[0]
  // 额外行动限定某个棋子时自动选中它
  const activeId = myTurn ? (extra?.pieceId ?? selectedId) : null
  const targets = activeId ? moves.filter((m) => m.pieceId === activeId) : []

  // 红圈：将帅可被直接吃掉；黄圈：会被攻击，但有护盾或锦囊挡下（仍会付出代价）
  const { dangerKingIds, guardedKingIds } = useMemo(() => {
    const danger: string[] = []
    const guarded: string[] = []
    if (state.phase !== 'over') {
      for (const side of SIDES) {
        const threat = kingThreat(state, other(side))
        if (threat === 'lethal') danger.push(findKing(state, side)!.id)
        else if (threat === 'guarded') guarded.push(findKing(state, side)!.id)
      }
    }
    return { dangerKingIds: danger, guardedKingIds: guarded }
  }, [state])

  const doMove = (m: Move) => dispatch({ type: 'move', side: state.turn, pieceId: m.pieceId, to: m.to })

  const onClickPoint = (pos: Pos) => {
    if (!myTurn) return
    const t = targets.find((m) => m.to.x === pos.x && m.to.y === pos.y)
    if (t) {
      if (exposesKing(state, t)) setPendingMove(t)
      else doMove(t)
      return
    }
    if (extra?.pieceId) return
    const p = pieceAt(state, pos.x, pos.y)
    if (p && p.side === state.turn && p.id !== selectedId && moves.some((m) => m.pieceId === p.id)) {
      setSelectedId(p.id)
    } else setSelectedId(null)
  }

  const draft = state.draft
  let draftSide: Side | null = null
  if (draft && !spectator) {
    if (mySide) draftSide = draft.sides[mySide].done ? null : mySide
    else draftSide = SIDES.find((s) => !draft.sides[s].done) ?? null
  }
  const waitingOpponentDraft = !!(draft && mySide && draft.sides[mySide].done)

  // 走法推荐：轮到本机这边操作时才能请求
  const hintActor: Side | null = !hints || spectator ? null : myTurn ? state.turn : draftSide
  const hint = useHint(state, hintActor)
  const hintAction = hint.hint
  const hintMove =
    hintAction?.type === 'move'
      ? moves.find((m) => m.pieceId === hintAction.pieceId && m.to.x === hintAction.to.x && m.to.y === hintAction.to.y)
      : undefined
  const recommended = hintAction?.type === 'pick' ? hintAction.augmentId : null
  const rerollAdvised = hintAction?.type === 'reroll'

  const resignSide = mySide ?? state.turn
  const next = nextDraftRound(state)
  const topSide: Side = flipped ? 'red' : 'black'

  let statusText: ReactNode
  if (state.phase === 'over') {
    statusText = `${state.winner ? `${SIDE_NAMES[state.winner]}胜` : '和棋'} · ${state.endReason}`
  } else if (state.phase === 'draft') {
    statusText = spectator ? '双方选择锦囊中' : waitingOpponentDraft ? '等待对方选择锦囊…' : '选择锦囊中'
  } else {
    let who: ReactNode
    if (!mySide || spectator) {
      who = (
        <>
          <b className={`side-text ${state.turn}`}>{SIDE_NAMES[state.turn]}</b>走棋
        </>
      )
    } else if (myTurn) who = <b className={`side-text ${state.turn}`}>轮到你走棋</b>
    else who = '等待对方走棋…'
    statusText = (
      <>
        {who} · 第 {roundOf(state)} 回合
        {next !== null && ` · 下次锦囊：第 ${next} 回合`}
      </>
    )
  }

  let overTitle = '和棋'
  if (state.winner) {
    if (!mySide) overTitle = `${SIDE_NAMES[state.winner]}获胜！`
    else overTitle = state.winner === mySide ? '你赢了！' : '你输了'
  }

  const topNote = sideNotes?.[topSide]
  const bottomNote = sideNotes?.[other(topSide)]

  const game = (
    <div className="game">
      {banner}
      <PlayerPanel state={state} side={topSide} mySide={mySide} label={labels?.[topSide]} onInfo={setInfoId} />
      {topNote && <div className="notes-inline">{topNote}</div>}

      <div className="board-wrap">
        <Board
          state={state}
          flipped={flipped}
          selectedId={activeId}
          targets={targets}
          dangerKingIds={dangerKingIds}
          guardedKingIds={guardedKingIds}
          ghosts={ghosts}
          fx={fx}
          hint={hintMove}
          onClickPoint={onClickPoint}
        />
      </div>

      <PlayerPanel
        state={state}
        side={other(topSide)}
        mySide={mySide}
        label={labels?.[other(topSide)]}
        onInfo={setInfoId}
      />
      {bottomNote && <div className="notes-inline">{bottomNote}</div>}

      <div className="status-bar">
        <span>{statusText}</span>
      </div>

      {hintMove && (
        <div className="hint-banner">
          💡 AI（{DIFFICULTIES[hint.level].name}）推荐的走法已用金色箭头标出
        </div>
      )}

      {extra && myTurn && (
        <div className="extra-banner">
          <span>
            【{AUGMENTS[extra.source].name}】可以再走一步{extra.noCapture && '（不能吃子）'}
          </span>
          <button type="button" onClick={() => dispatch({ type: 'skip', side: state.turn })}>
            跳过
          </button>
        </div>
      )}

      <div className="controls">
        {onUndo && !spectator && state.phase !== 'over' && (
          <button type="button" onClick={onUndo}>
            {undoLabel}
          </button>
        )}
        <button type="button" onClick={() => setFlipped((f) => !f)}>
          翻转棋盘
        </button>
        <button type="button" onClick={() => setShowRules(true)}>
          规则
        </button>
        {extraControls}
        {hints && !spectator && state.phase === 'play' && (
          <span className="hint-control">
            <select
              value={hint.level}
              onChange={(e) => hint.setLevel(e.target.value as Difficulty)}
              aria-label="推荐强度"
              title="推荐强度"
            >
              {(Object.keys(DIFFICULTIES) as Difficulty[]).map((d) => (
                <option key={d} value={d}>
                  {DIFFICULTIES[d].name}
                </option>
              ))}
            </select>
            <button type="button" onClick={hint.ask} disabled={!hint.canAsk || hint.thinking || !!hintMove}>
              {hint.thinking ? '思考中…' : '💡 提示'}
            </button>
          </span>
        )}
        {!spectator &&
          (state.phase === 'over' ? (
            <button type="button" onClick={onRestart} disabled={restartDisabled}>
              {restartLabel}
            </button>
          ) : (
            <button type="button" onClick={() => setConfirmResign(true)}>
              认输
            </button>
          ))}
        {onWatchReplay && state.phase === 'over' && !spectator && (
          <button type="button" onClick={onWatchReplay}>
            查看回放
          </button>
        )}
        {onShareReplay && (spectator || state.phase === 'over') && (
          <button type="button" onClick={onShareReplay}>
            分享回放
          </button>
        )}
        <button type="button" onClick={onExit}>
          {exitLabel}
        </button>
        {draftSide && draftHidden && (
          <button type="button" className="primary" onClick={() => setDraftHidden(false)}>
            继续选锦囊
          </button>
        )}
      </div>

      <GameLog state={state} />

      {draftSide && !draftHidden && (
        <DraftModal
          state={state}
          side={draftSide}
          onPick={(id) => dispatch({ type: 'pick', side: draftSide, augmentId: id })}
          onReroll={() => dispatch({ type: 'reroll', side: draftSide })}
          onHide={() => setDraftHidden(true)}
          hint={
            hints
              ? {
                  level: hint.level,
                  thinking: hint.thinking,
                  recommended,
                  rerollAdvised,
                  onAsk: hint.ask,
                }
              : undefined
          }
        />
      )}

      {confirmResign && (
        <ConfirmModal
          title={`${mySide ? '' : SIDE_NAMES[resignSide]}确定要认输吗？`}
          message="认输后本局立即结束。"
          confirmLabel="认输"
          cancelLabel="继续下"
          danger
          onConfirm={() => {
            setConfirmResign(false)
            if (state.phase !== 'over') dispatch({ type: 'resign', side: resignSide })
          }}
          onCancel={() => setConfirmResign(false)}
        />
      )}

      {pendingMove && (
        <Modal onClose={() => setPendingMove(null)} className="confirm">
          <h3>⚠ 送将提醒</h3>
          <p>走这步之后，对方可以直接吃掉你的{state.turn === 'red' ? '帥' : '將'}！确定要走吗？</p>
          <div className="modal-actions">
            <button type="button" onClick={() => setPendingMove(null)}>
              再想想
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                doMove(pendingMove)
                setPendingMove(null)
              }}
            >
              就这么走
            </button>
          </div>
        </Modal>
      )}

      {state.phase === 'over' && !overDismissed && !spectator && (
        <Modal onClose={() => setOverDismissed(true)} className="game-over">
          <h2 className={state.winner ? `side-text ${state.winner}` : ''}>{overTitle}</h2>
          <p>{state.endReason}</p>
          <div className="modal-actions">
            <button type="button" onClick={() => setOverDismissed(true)}>
              查看棋盘
            </button>
            {onWatchReplay && (
              <button type="button" onClick={onWatchReplay}>
                查看回放
              </button>
            )}
            {onShareReplay && (
              <button type="button" onClick={onShareReplay}>
                分享回放
              </button>
            )}
            <button type="button" onClick={onExit}>
              返回主页
            </button>
            <button type="button" className="primary" onClick={onRestart} disabled={restartDisabled}>
              {restartLabel}
            </button>
          </div>
        </Modal>
      )}

      {infoId && (
        <Modal onClose={() => setInfoId(null)} className="info">
          <AugmentCard id={infoId} />
          <div className="modal-actions">
            <button type="button" onClick={() => setInfoId(null)}>
              关闭
            </button>
          </div>
        </Modal>
      )}

      {showRules && (
        <Modal onClose={() => setShowRules(false)}>
          <h3>规则</h3>
          <Rules />
          <div className="modal-actions">
            <button type="button" onClick={() => setShowRules(false)}>
              关闭
            </button>
          </div>
        </Modal>
      )}
    </div>
  )

  if (!sideNotes) return game
  return (
    <div className="game-layout">
      <aside className="notes-aside">{topNote}</aside>
      {game}
      <aside className="notes-aside">{bottomNote}</aside>
    </div>
  )
}

function PlayerPanel({
  state,
  side,
  mySide,
  label,
  onInfo,
}: {
  state: GameState
  side: Side
  mySide: Side | null
  label?: string
  onInfo: (id: string) => void
}) {
  const active = state.phase !== 'over' && state.turn === side
  const diff = material(state, side) - material(state, other(side))
  // 这一方吃掉的对方棋子（按价值排序）
  const order = 'RCNBAPK'
  const captured = state.pieces
    .filter((p) => !p.alive && p.side !== side)
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
  return (
    <div className={`player-panel ${side} ${active ? 'active' : ''}`}>
      <div className="player-head">
        <span className={`side-dot ${side}`} />
        <b>{SIDE_NAMES[side]}</b>
        {label ? (
          <span className="muted">{label}</span>
        ) : (
          mySide && <span className="muted">{mySide === side ? '（你）' : '（对方）'}</span>
        )}
        {diff !== 0 && (
          <span className={`material ${diff > 0 ? 'up' : 'down'}`} title="子力差">
            {diff > 0 ? '+' : ''}
            {diff}
          </span>
        )}
        {captured.length > 0 && (
          <span className="captured" title="已吃掉的棋子">
            {captured.map((p) => (
              <span key={p.id} className={`cap ${p.side}`}>
                {PIECE_CHARS[p.side][p.type]}
              </span>
            ))}
          </span>
        )}
        <span className="rerolls" title="剩余刷新次数">
          ↻ {state.rerollsLeft[side]}
        </span>
      </div>
      <div className="aug-chips">
        {state.augments[side].length === 0 ? (
          <span className="muted">暂无锦囊</span>
        ) : (
          state.augments[side].map((a) => <AugmentChip key={a.id} owned={a} onClick={() => onInfo(a.id)} />)
        )}
      </div>
    </div>
  )
}

function DraftModal({
  state,
  side,
  onPick,
  onReroll,
  onHide,
  hint,
}: {
  state: GameState
  side: Side
  onPick: (id: string) => void
  onReroll: () => void
  onHide: () => void
  hint?: {
    level: Difficulty
    thinking: boolean
    recommended: string | null
    rerollAdvised: boolean
    onAsk: () => void
  }
}) {
  const ds = state.draft!.sides[side]
  const opponent = state.augments[other(side)]
  const opponentReady = state.draft!.sides[other(side)].done
  return (
    <Modal className="draft">
      <h2>
        <span className={`side-text ${side}`}>{SIDE_NAMES[side]}</span> 选择锦囊
      </h2>
      <p className="draft-sub">
        第 {state.draft!.round} 回合 · <span className={`tier-label tier-${ds.tier}`}>{TIER_NAMES[ds.tier]}</span>
        {ds.comeback && <span className="comeback"> · 逆风补偿：品质提升</span>}
      </p>
      <div className="aug-cards" key={ds.rerollNo}>
        {ds.options.map((id, i) => (
          <AugmentCard
            key={id}
            id={id}
            onClick={() => onPick(id)}
            delay={i * 90}
            recommended={hint?.recommended === id}
          />
        ))}
      </div>
      {opponent.length > 0 && (
        <p className="draft-opponent">
          对手已有：
          {opponent.map((a) => (
            <span key={a.id} className="opp-aug">
              <AugmentGlyph id={a.id} size="sm" />
              {AUGMENTS[a.id].name}
            </span>
          ))}
        </p>
      )}
      <p className="muted draft-secret">
        {opponentReady ? '对方已选好。' : '对方正在选择。'}双方都选完后同时揭晓
      </p>
      {hint?.rerollAdvised && <p className="hint-note">💡 AI 觉得这三个都不太理想，建议刷新</p>}
      <div className="modal-actions">
        <button type="button" onClick={onHide}>
          看一眼棋盘
        </button>
        {hint && (
          <button
            type="button"
            onClick={hint.onAsk}
            disabled={hint.thinking || !!hint.recommended || hint.rerollAdvised}
            title={`按「${DIFFICULTIES[hint.level].name}」难度的 AI 推荐`}
          >
            {hint.thinking ? '思考中…' : '💡 AI 推荐'}
          </button>
        )}
        <button type="button" onClick={onReroll} disabled={state.rerollsLeft[side] <= 0}>
          刷新选项（剩 {state.rerollsLeft[side]} 次）
        </button>
      </div>
    </Modal>
  )
}

function GameLog({ state }: { state: GameState }) {
  const entries = state.log.slice(-8).reverse()
  return (
    <details className="game-log">
      <summary>对局记录</summary>
      <ul>
        {entries.map((e, i) => (
          <li key={state.log.length - i}>
            <span className="log-round">#{e.round}</span>
            {e.side && <span className={`side-dot ${e.side}`} />}
            {e.text}
          </li>
        ))}
      </ul>
    </details>
  )
}
