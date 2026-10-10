import { useRef, type MouseEvent } from 'react'
import { PIECE_CHARS, type GameState, type Move, type Piece, type Pos } from '../engine'

export const CELL = 60
const PAD = 40
const W = CELL * 8 + PAD * 2
const H = CELL * 9 + PAD * 2

interface Props {
  state: GameState
  flipped: boolean
  selectedId: string | null
  /** 选中棋子的可走目标 */
  targets: Move[]
  /** 处于危险中的将帅 id */
  dangerKingIds: string[]
  onClickPoint(pos: Pos): void
}

export function Board({ state, flipped, selectedId, targets, dangerKingIds, onClickPoint }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)

  const px = (x: number) => PAD + (flipped ? 8 - x : x) * CELL
  const py = (y: number) => PAD + (flipped ? 9 - y : y) * CELL

  const handleClick = (e: MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
    let x = Math.round((p.x - PAD) / CELL)
    let y = Math.round((p.y - PAD) / CELL)
    if (x < 0 || x > 8 || y < 0 || y > 9) return
    if (flipped) {
      x = 8 - x
      y = 9 - y
    }
    onClickPoint({ x, y })
  }

  const last = state.lastMove

  return (
    <svg
      ref={svgRef}
      className="board"
      viewBox={`0 0 ${W} ${H}`}
      onClick={handleClick}
      role="img"
      aria-label="棋盘"
    >
      <defs>
        <radialGradient id="pieceFace" cx="40%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#fdf3dc" />
          <stop offset="100%" stopColor="#e7cf9f" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width={W} height={H} rx="14" className="board-bg" />
      <Grid px={px} py={py} />

      {last && (
        <g className="last-move">
          {[last.from, last.to].map((p, i) => (
            <rect key={i} x={px(p.x) - 29} y={py(p.y) - 29} width="58" height="58" rx="8" />
          ))}
        </g>
      )}

      {state.pieces
        .filter((p) => p.alive)
        .map((p) => (
          <PieceView
            key={p.id}
            piece={p}
            cx={px(p.x)}
            cy={py(p.y)}
            selected={p.id === selectedId}
            danger={dangerKingIds.includes(p.id)}
          />
        ))}

      {targets.map((m) =>
        m.captureId ? (
          <circle key={`${m.to.x},${m.to.y}`} className="target-capture" cx={px(m.to.x)} cy={py(m.to.y)} r="30" />
        ) : (
          <circle key={`${m.to.x},${m.to.y}`} className="target-dot" cx={px(m.to.x)} cy={py(m.to.y)} r="8" />
        ),
      )}
    </svg>
  )
}

function Grid({ px, py }: { px: (x: number) => number; py: (y: number) => number }) {
  const lines: [number, number, number, number][] = []
  for (let y = 0; y <= 9; y++) lines.push([0, y, 8, y])
  for (let x = 0; x <= 8; x++) {
    if (x === 0 || x === 8) lines.push([x, 0, x, 9])
    else {
      lines.push([x, 0, x, 4])
      lines.push([x, 5, x, 9])
    }
  }
  lines.push([3, 0, 5, 2], [5, 0, 3, 2], [3, 7, 5, 9], [5, 7, 3, 9])

  const marks: [number, number][] = [
    [1, 2],
    [7, 2],
    [1, 7],
    [7, 7],
    ...[0, 2, 4, 6, 8].flatMap((x) => [
      [x, 3] as [number, number],
      [x, 6] as [number, number],
    ]),
  ]

  const riverY = (py(4) + py(5)) / 2
  return (
    <g className="grid">
      <rect
        x={Math.min(px(0), px(8)) - 6}
        y={Math.min(py(0), py(9)) - 6}
        width={CELL * 8 + 12}
        height={CELL * 9 + 12}
        className="grid-frame"
      />
      {lines.map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={px(x1)} y1={py(y1)} x2={px(x2)} y2={py(y2)} />
      ))}
      {marks.map(([x, y]) => (
        <PointMark key={`${x},${y}`} cx={px(x)} cy={py(y)} left={x > 0} right={x < 8} />
      ))}
      <text x={PAD + CELL * 2} y={riverY} className="river">
        楚 河
      </text>
      <text x={PAD + CELL * 6} y={riverY} className="river">
        漢 界
      </text>
    </g>
  )
}

function PointMark({ cx, cy, left, right }: { cx: number; cy: number; left: boolean; right: boolean }) {
  const g = 5
  const l = 10
  const d: string[] = []
  for (const sx of [-1, 1]) {
    if ((sx < 0 && !left) || (sx > 0 && !right)) continue
    for (const sy of [-1, 1]) {
      const x = cx + sx * g
      const y = cy + sy * g
      d.push(`M${x + sx * l},${y} L${x},${y} L${x},${y + sy * l}`)
    }
  }
  return <path d={d.join(' ')} className="point-mark" />
}

function PieceView({
  piece,
  cx,
  cy,
  selected,
  danger,
}: {
  piece: Piece
  cx: number
  cy: number
  selected: boolean
  danger: boolean
}) {
  const cls = ['piece', piece.side, selected && 'selected', danger && 'danger'].filter(Boolean).join(' ')
  return (
    <g className={cls} style={{ transform: `translate(${cx}px, ${cy}px)` }}>
      {danger && <circle className="danger-ring" r="31" />}
      {piece.shield > 0 && <circle className="shield-ring" r="30" />}
      <circle className="piece-body" r="26" fill="url(#pieceFace)" />
      <circle className="piece-inner" r="22" />
      <text className="piece-char" dy="0.36em">
        {PIECE_CHARS[piece.side][piece.type]}
      </text>
      {piece.shield > 1 && (
        <text className="shield-count" x="20" y="-18">
          {piece.shield}
        </text>
      )}
      {piece.promoted && (
        <text className="promoted-mark" x="-21" y="-17">
          ★
        </text>
      )}
    </g>
  )
}
