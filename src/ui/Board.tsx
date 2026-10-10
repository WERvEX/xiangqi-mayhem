import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { PIECE_CHARS, type FxKind, type GameState, type Move, type Piece, type Pos } from '../engine'

export const CELL = 60
const PAD = 40
const W = CELL * 8 + PAD * 2
const H = CELL * 9 + PAD * 2

export interface FxItem {
  key: string
  kind: FxKind
  pos: Pos
}

const FX_LABEL: Partial<Record<FxKind, string>> = {
  shield: '格挡',
  protect: '免死',
  revive: '复活',
  promote: '升变',
  burn: '火烧',
  summon: '降临',
  convert: '倒戈',
  swap: '换位',
  extra: '再走一步',
}

interface Props {
  state: GameState
  flipped: boolean
  selectedId: string | null
  /** 选中棋子的可走目标 */
  targets: Move[]
  /** 可被直接吃掉的将帅 id */
  dangerKingIds: string[]
  /** 会被攻击但有保护的将帅 id */
  guardedKingIds: string[]
  /** 刚被吃掉的棋子，播放淡出动画 */
  ghosts: Piece[]
  fx: FxItem[]
  /** AI 推荐的走法，用金色箭头标出 */
  hint?: Move
  onClickPoint(pos: Pos): void
}

const CHAR_FONT_FAMILY = "'STKaiti', 'KaiTi', '楷体', serif"
const CHAR_FONT_SIZE = 30
const ALL_CHARS = Object.values(PIECE_CHARS).flatMap((m) => Object.values(m))

type GlyphOffsets = Record<string, { x: number; y: number }>

/**
 * 不同字的墨迹重心不同（例如"象"偏右、"相"偏左），只靠 text-anchor 和基线无法真正居中。
 * 用 canvas 按实际字体量出每个字的墨迹边界，算出让墨迹中心落在圆心所需的偏移。
 */
function measureGlyphs(): GlyphOffsets {
  const ctx = document.createElement('canvas').getContext('2d')
  const out: GlyphOffsets = {}
  if (!ctx) return out
  ctx.font = `bold ${CHAR_FONT_SIZE}px ${CHAR_FONT_FAMILY}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  for (const ch of ALL_CHARS) {
    const m = ctx.measureText(ch)
    out[ch] = {
      x: -(m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2,
      y: (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2,
    }
  }
  return out
}

function useGlyphOffsets(): GlyphOffsets {
  const [offsets, setOffsets] = useState(measureGlyphs)
  useEffect(() => {
    // 字体可能在首次渲染后才加载完成，届时重新测量
    let alive = true
    document.fonts?.ready.then(() => alive && setOffsets(measureGlyphs()))
    return () => {
      alive = false
    }
  }, [])
  return offsets
}

// 木纹：固定的几条淡色曲线
const GRAIN = Array.from({ length: 16 }, (_, i) => {
  const y = 20 + i * 38 + ((i * 37) % 13)
  const a = 6 + ((i * 53) % 9)
  return `M0,${y} C${W * 0.3},${y - a} ${W * 0.6},${y + a} ${W},${y - a / 2}`
})

export function Board({
  state,
  flipped,
  selectedId,
  targets,
  dangerKingIds,
  guardedKingIds,
  ghosts,
  fx,
  hint,
  onClickPoint,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const glyphs = useGlyphOffsets()

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
        <radialGradient id="pieceFace" cx="40%" cy="32%" r="75%">
          <stop offset="0%" stopColor="#fff8e6" />
          <stop offset="70%" stopColor="#f0d9a8" />
          <stop offset="100%" stopColor="#dcbc80" />
        </radialGradient>
        <linearGradient id="pieceEdge" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d9b06a" />
          <stop offset="100%" stopColor="#8a6430" />
        </linearGradient>
        <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#eccb8f" />
          <stop offset="50%" stopColor="#deb173" />
          <stop offset="100%" stopColor="#e7c182" />
        </linearGradient>
        <marker id="hintArrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#ffb300" />
        </marker>
        <radialGradient id="vignette" cx="50%" cy="50%" r="70%">
          <stop offset="70%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#3a2108" stopOpacity="0.28" />
        </radialGradient>
      </defs>

      <rect x="0" y="0" width={W} height={H} rx="14" className="board-bg" fill="url(#wood)" />
      <g className="grain">
        {GRAIN.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
      <rect x="0" y="0" width={W} height={H} rx="14" fill="url(#vignette)" pointerEvents="none" />
      <Grid px={px} py={py} />

      {last && (
        <g className="last-move">
          <Corners cx={px(last.from.x)} cy={py(last.from.y)} faint />
          <Corners cx={px(last.to.x)} cy={py(last.to.y)} />
        </g>
      )}

      {ghosts.map((p) => (
        <g key={`ghost-${p.id}`} transform={`translate(${px(p.x)} ${py(p.y)})`}>
          <g className={`piece ${p.side} ghost`}>
            <PieceBody piece={p} glyphs={glyphs} />
          </g>
        </g>
      ))}

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
            guarded={guardedKingIds.includes(p.id)}
            glyphs={glyphs}
          />
        ))}

      {targets.map((m) => {
        const key = `${m.to.x},${m.to.y}`
        const cx = px(m.to.x)
        const cy = py(m.to.y)
        if (m.swapId) return <circle key={key} className="target-swap" cx={cx} cy={cy} r="30" />
        if (m.captureId) return <circle key={key} className="target-capture" cx={cx} cy={cy} r="30" />
        return <circle key={key} className="target-dot" cx={cx} cy={cy} r="8" />
      })}

      {hint && <HintArrow x1={px(hint.from.x)} y1={py(hint.from.y)} x2={px(hint.to.x)} y2={py(hint.to.y)} />}

      {fx.map((f) => (
        <g key={f.key} transform={`translate(${px(f.pos.x)} ${py(f.pos.y)})`} className={`fx fx-${f.kind}`}>
          <circle className="fx-ring" r="26" />
          {f.kind !== 'capture' && <circle className="fx-ring fx-ring-2" r="26" />}
          {FX_LABEL[f.kind] && (
            <text className="fx-label" y="-34">
              {FX_LABEL[f.kind]}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}

function HintArrow({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  // 箭头从起点棋子边缘指向终点格子边缘
  const len = Math.hypot(x2 - x1, y2 - y1)
  const ux = (x2 - x1) / len
  const uy = (y2 - y1) / len
  // 两端让出一段避免压住棋子；相邻两格距离很短，按比例缩小，保证箭头始终可见
  const start = Math.min(26, len * 0.25)
  const end = Math.min(30, len * 0.3)
  return (
    <g className="hint-arrow">
      <circle cx={x1} cy={y1} r="30" className="hint-ring" />
      <circle cx={x2} cy={y2} r="30" className="hint-ring" />
      <line
        x1={x1 + ux * start}
        y1={y1 + uy * start}
        x2={x2 - ux * end}
        y2={y2 - uy * end}
        markerEnd="url(#hintArrow)"
      />
    </g>
  )
}

function Corners({ cx, cy, faint }: { cx: number; cy: number; faint?: boolean }) {
  const r = 27
  const l = 9
  const d = [-1, 1]
    .flatMap((sx) =>
      [-1, 1].map((sy) => {
        const x = cx + sx * r
        const y = cy + sy * r
        return `M${x},${y - sy * l} L${x},${y} L${x - sx * l},${y}`
      }),
    )
    .join(' ')
  return <path d={d} className={faint ? 'corners faint' : 'corners'} />
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
        x={Math.min(px(0), px(8)) - 7}
        y={Math.min(py(0), py(9)) - 7}
        width={CELL * 8 + 14}
        height={CELL * 9 + 14}
        className="grid-frame"
      />
      <rect x={PAD} y={Math.min(py(4), py(5))} width={CELL * 8} height={CELL} className="river-band" />
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

function PieceBody({ piece, glyphs }: { piece: Piece; glyphs: GlyphOffsets }) {
  const ch = PIECE_CHARS[piece.side][piece.type]
  // 测量失败时退回经验值：基线下移约 0.36em
  const off = glyphs[ch] ?? { x: 0, y: CHAR_FONT_SIZE * 0.36 }
  return (
    <>
      <circle className="piece-edge" r="27" fill="url(#pieceEdge)" />
      <circle className="piece-body" r="25" fill="url(#pieceFace)" />
      <circle className="piece-inner" r="21" />
      <text
        className="piece-char"
        x={off.x}
        y={off.y}
        fontFamily={CHAR_FONT_FAMILY}
        fontSize={CHAR_FONT_SIZE}
        fontWeight="bold"
      >
        {ch}
      </text>
    </>
  )
}

function PieceView({
  piece,
  cx,
  cy,
  selected,
  danger,
  guarded,
  glyphs,
}: {
  piece: Piece
  cx: number
  cy: number
  selected: boolean
  danger: boolean
  guarded: boolean
  glyphs: GlyphOffsets
}) {
  const cls = ['piece', piece.side, selected && 'selected', danger && 'danger'].filter(Boolean).join(' ')
  return (
    <g className={cls} style={{ transform: `translate(${cx}px, ${cy}px)` }}>
      <g className="piece-lift">
        {danger && <circle className="danger-ring" r="32" />}
        {guarded && <circle className="guard-ring" r="33" />}
        {piece.shield > 0 && <circle className="shield-ring" r="31" />}
        <PieceBody piece={piece} glyphs={glyphs} />
        {piece.shield > 1 && (
          <g transform="translate(20 -20)">
            <circle r="9" className="shield-badge" />
            <text className="shield-count" dy="0.35em">
              {piece.shield}
            </text>
          </g>
        )}
        {piece.promoted && (
          <text className="promoted-mark" x="-20" y="-16">
            ★
          </text>
        )}
      </g>
    </g>
  )
}
