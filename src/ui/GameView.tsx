import { useMemo, useState } from 'react'
import {
  applyAction,
  AUGMENTS,
  canAttackKing,
  createGame,
  exposesKing,
  findKing,
  legalMoves,
  material,
  nextDraftRound,
  other,
  pieceAt,
  randomSeed,
  roundOf,
  SIDE_NAMES,
  TIER_NAMES,
  type Action,
  type GameState,
  type Move,
  type Pos,
  type Side,
} from '../engine'
import { Board } from './Board'
import { AugmentCard, AugmentChip, AugmentGlyph, Modal, Rules } from './common'

const SIDES: Side[] = ['red', 'black']

export function GameView({ onExit }: { onExit: () => void }) {
  const [history, setHistory] = useState<GameState[]>(() => [createGame(randomSeed())])
  const state = history[history.length - 1]
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [flipped, setFlipped] = useState(false)
  const [pendingMove, setPendingMove] = useState<Move | null>(null)
  const [overDismissed, setOverDismissed] = useState(false)
  const [draftHidden, setDraftHidden] = useState(false)
  const [infoId, setInfoId] = useState<string | null>(null)
  const [showRules, setShowRules] = useState(false)

  const moves = useMemo(() => legalMoves(state), [state])
  const extra = state.extraMoves[0]
  // 额外行动限定某个棋子时自动选中它
  const activeId = extra?.pieceId ?? selectedId
  const targets = activeId ? moves.filter((m) => m.pieceId === activeId) : []

  const dangerKingIds = useMemo(() => {
    if (state.phase === 'over') return []
    return SIDES.filter((side) => canAttackKing(state, other(side))).map((side) => findKing(state, side)!.id)
  }, [state])

  const dispatch = (action: Action) => {
    try {
      const next = applyAction(state, action)
      setHistory((h) => [...h, next])
      setSelectedId(null)
      setDraftHidden(false)
      setOverDismissed(false)
    } catch (e) {
      console.warn(e)
    }
  }

  const doMove = (m: Move) => dispatch({ type: 'move', side: state.turn, pieceId: m.pieceId, to: m.to })

  const onClickPoint = (pos: Pos) => {
    if (state.phase !== 'play') return
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

  const undo = () => {
    if (history.length <= 1) return
    setHistory((h) => h.slice(0, -1))
    setSelectedId(null)
  }

  const restart = () => {
    setHistory([createGame(randomSeed())])
    setSelectedId(null)
  }

  const draftSide: Side | null = state.draft
    ? !state.draft.sides.red.done
      ? 'red'
      : !state.draft.sides.black.done
        ? 'black'
        : null
    : null

  const next = nextDraftRound(state)
  const topSide: Side = flipped ? 'red' : 'black'

  return (
    <div className="game">
      <PlayerPanel state={state} side={topSide} onInfo={setInfoId} />

      <div className="board-wrap">
        <Board
          state={state}
          flipped={flipped}
          selectedId={activeId}
          targets={targets}
          dangerKingIds={dangerKingIds}
          onClickPoint={onClickPoint}
        />
      </div>

      <PlayerPanel state={state} side={other(topSide)} onInfo={setInfoId} />

      <div className={`status-bar ${state.turn}`}>
        {state.phase === 'over' ? (
          <span>
            {state.winner ? `${SIDE_NAMES[state.winner]}胜` : '和棋'} · {state.endReason}
          </span>
        ) : (
          <span>
            <b className={`side-text ${state.turn}`}>{SIDE_NAMES[state.turn]}</b>
            {state.phase === 'draft' ? '选择锦囊中' : '走棋'} · 第 {roundOf(state)} 回合
            {state.phase === 'play' && next !== null && ` · 下次锦囊：第 ${next} 回合`}
          </span>
        )}
      </div>

      {extra && state.phase === 'play' && (
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
        <button type="button" onClick={undo} disabled={history.length <= 1}>
          悔棋
        </button>
        <button type="button" onClick={() => setFlipped((f) => !f)}>
          翻转棋盘
        </button>
        <button type="button" onClick={() => setShowRules(true)}>
          规则
        </button>
        {state.phase === 'over' ? (
          <button type="button" onClick={restart}>
            再来一局
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (confirm(`${SIDE_NAMES[state.turn]}确定要认输吗？`)) dispatch({ type: 'resign', side: state.turn })
            }}
          >
            认输
          </button>
        )}
        <button type="button" onClick={onExit}>
          主页
        </button>
        {state.phase === 'draft' && draftHidden && (
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

      {state.phase === 'over' && !overDismissed && (
        <Modal onClose={() => setOverDismissed(true)} className="game-over">
          <h2 className={state.winner ? `side-text ${state.winner}` : ''}>
            {state.winner ? `${SIDE_NAMES[state.winner]}获胜！` : '和棋'}
          </h2>
          <p>{state.endReason}</p>
          <div className="modal-actions">
            <button type="button" onClick={() => setOverDismissed(true)}>
              查看棋盘
            </button>
            <button type="button" className="primary" onClick={restart}>
              再来一局
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
}

function PlayerPanel({ state, side, onInfo }: { state: GameState; side: Side; onInfo: (id: string) => void }) {
  const active = state.phase !== 'over' && state.turn === side
  const diff = material(state, side) - material(state, other(side))
  return (
    <div className={`player-panel ${side} ${active ? 'active' : ''}`}>
      <div className="player-head">
        <span className={`side-dot ${side}`} />
        <b>{SIDE_NAMES[side]}</b>
        {diff !== 0 && (
          <span className={`material ${diff > 0 ? 'up' : 'down'}`} title="子力差">
            {diff > 0 ? '+' : ''}
            {diff}
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
}: {
  state: GameState
  side: Side
  onPick: (id: string) => void
  onReroll: () => void
  onHide: () => void
}) {
  const ds = state.draft!.sides[side]
  const opponent = state.augments[other(side)]
  return (
    <Modal className="draft">
      <h2>
        <span className={`side-text ${side}`}>{SIDE_NAMES[side]}</span> 选择锦囊
      </h2>
      <p className="draft-sub">
        第 {state.draft!.round} 回合 · <span className={`tier-label tier-${ds.tier}`}>{TIER_NAMES[ds.tier]}</span>
        {ds.comeback && <span className="comeback"> · 逆风补偿：品质提升</span>}
      </p>
      <div className="aug-cards">
        {ds.options.map((id) => (
          <AugmentCard key={id} id={id} onClick={() => onPick(id)} />
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
      <div className="modal-actions">
        <button type="button" onClick={onHide}>
          看一眼棋盘
        </button>
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
