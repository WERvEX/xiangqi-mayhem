import type { ReactNode } from 'react'
import { AUGMENT_LIST, AUGMENTS, CONFIG, TIER_NAMES, type OwnedAugment, type Tier } from '../engine'

export function Modal({
  children,
  onClose,
  className = '',
}: {
  children: ReactNode
  onClose?: () => void
  className?: string
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${className}`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

export function AugmentGlyph({ id, size = 'md' }: { id: string; size?: 'sm' | 'md' | 'lg' }) {
  const def = AUGMENTS[id]
  return <span className={`glyph glyph-${size} tier-${def.tier}`}>{def.glyph}</span>
}

export function AugmentCard({ id, onClick }: { id: string; onClick?: () => void }) {
  const def = AUGMENTS[id]
  return (
    <button type="button" className={`aug-card tier-${def.tier}`} onClick={onClick} disabled={!onClick}>
      <AugmentGlyph id={id} size="lg" />
      <div className="aug-card-name">{def.name}</div>
      <div className={`tier-label tier-${def.tier}`}>{TIER_NAMES[def.tier]}</div>
      <div className="aug-card-desc">{def.desc}</div>
    </button>
  )
}

export function AugmentChip({ owned, onClick }: { owned: OwnedAugment; onClick: () => void }) {
  const def = AUGMENTS[owned.id]
  const status = def.status?.(owned.data)
  return (
    <button type="button" className={`aug-chip tier-${def.tier}`} onClick={onClick} title={def.desc}>
      <AugmentGlyph id={owned.id} size="sm" />
      <span>{def.name}</span>
      {status && <span className="aug-status">{status}</span>}
    </button>
  )
}

export function Codex() {
  const tiers: Tier[] = ['silver', 'gold', 'prism']
  return (
    <div className="codex">
      {tiers.map((t) => (
        <section key={t}>
          <h3 className={`tier-label tier-${t}`}>{TIER_NAMES[t]}锦囊</h3>
          <ul className="codex-list">
            {AUGMENT_LIST.filter((a) => a.tier === t).map((a) => (
              <li key={a.id}>
                <AugmentGlyph id={a.id} />
                <div>
                  <b>{a.name}</b>
                  <p>{a.desc}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

export function Rules() {
  const [first, ...rest] = CONFIG.draftRounds
  return (
    <ul className="rules">
      <li>棋子走法与中国象棋相同。</li>
      <li>
        <b>吃掉对方的将（帅）即获胜</b>。允许送将，界面会高亮受威胁的将帅，并在你送将前提醒。
      </li>
      <li>将帅在同一直线上且中间无子时，可以"飞将"直接吃掉对方。</li>
      <li>
        第 {first}、{rest.join('、')} 回合开始时，双方各自从 3 个锦囊中选 1 个，锦囊对双方公开。每局可刷新{' '}
        {CONFIG.rerollsPerGame} 次选项。
      </li>
      <li>锦囊分白银、黄金、棱彩三档，越往后品质越高；子力落后较多的一方，选项会提升一档。</li>
      <li>护盾：挡下一次吃子，攻击者原地不动，消耗本回合。</li>
      <li>同一局面重复三次，或超过 {CONFIG.maxRounds} 回合判和；无棋可走判负。</li>
    </ul>
  )
}
