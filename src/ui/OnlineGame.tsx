import { useEffect, useState, useSyncExternalStore } from 'react'
import { other, SIDE_NAMES, type Side } from '../engine'
import { checkNetwork, peerTransport, type NetworkCheck } from '../net/peerTransport'
import { OnlineSession } from '../net/session'
import { makeReplay, type Replay } from '../replay/replay'
import { GameView } from './GameView'
import { ReplayShareModal } from './Replay'

const inviteLink = (code: string) => `${location.origin}${location.pathname}#room=${code}`

/** 同一个标签页刷新后用同一身份重连 */
function guestToken(code: string): string {
  const key = `xqm-token-${code}`
  let token = sessionStorage.getItem(key)
  if (!token) {
    token = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)
    sessionStorage.setItem(key, token)
  }
  return token
}

export function OnlineGame({ onExit, initialCode }: { onExit: () => void; initialCode: string | null }) {
  const [session, setSession] = useState<OnlineSession | null>(null)

  useEffect(() => () => session?.leave(), [session])

  const leave = () => {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search)
    setSession(null)
    onExit()
  }

  if (!session) {
    return (
      <Lobby
        initialCode={initialCode}
        onHost={(pref) => setSession(OnlineSession.createHost(peerTransport, pref))}
        onJoin={(code) => {
          history.replaceState(null, '', `#room=${code}`)
          setSession(OnlineSession.join(peerTransport, code, guestToken(code)))
        }}
        onBack={leave}
      />
    )
  }
  return <OnlineRoom session={session} onLeave={leave} />
}

function Lobby({
  initialCode,
  onHost,
  onJoin,
  onBack,
}: {
  initialCode: string | null
  onHost: (pref: Side | 'random') => void
  onJoin: (code: string) => void
  onBack: () => void
}) {
  const [pref, setPref] = useState<Side | 'random'>('random')
  const [code, setCode] = useState(initialCode ?? '')
  const valid = /^\d{6}$/.test(code)

  return (
    <div className="lobby">
      <h2>联机对战</h2>

      {initialCode && (
        <section className="lobby-card highlight">
          <p>你收到了一个对战邀请</p>
          <button type="button" className="primary big" onClick={() => onJoin(initialCode)}>
            加入房间 {initialCode}
          </button>
        </section>
      )}

      <section className="lobby-card">
        <h3>创建房间</h3>
        <div className="segmented">
          {(['red', 'black', 'random'] as const).map((p) => (
            <button key={p} type="button" className={pref === p ? 'on' : ''} onClick={() => setPref(p)}>
              {p === 'random' ? '随机' : `执${p === 'red' ? '红' : '黑'}`}
            </button>
          ))}
        </div>
        <button type="button" className={initialCode ? 'big' : 'primary big'} onClick={() => onHost(pref)}>
          创建房间
        </button>
      </section>

      <section className="lobby-card">
        <h3>加入房间</h3>
        <form
          className="join-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid) onJoin(code)
          }}
        >
          <input
            inputMode="numeric"
            maxLength={6}
            placeholder="6 位房间号"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <button type="submit" disabled={!valid}>
            加入
          </button>
        </form>
      </section>

      <p className="muted lobby-note">
        联机优先点对点直连；双方网络无法直连时，会自动经中转服务器转发。连不上的话，可以让双方都做一下网络检测。
      </p>

      <NetworkCheckCard />

      <button type="button" onClick={onBack}>
        返回主页
      </button>
    </div>
  )
}

function OnlineRoom({ session, onLeave }: { session: OnlineSession; onLeave: () => void }) {
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [copied, setCopied] = useState(false)
  const [sharing, setSharing] = useState<Replay | null>(null)

  const inGame = snap.status === 'playing'

  // 对局中关闭或刷新页面前提醒
  useEffect(() => {
    if (!inGame) return
    const handler = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [inGame])

  const confirmLeave = () => {
    if (!inGame || snap.state?.phase === 'over' || confirm('确定离开房间吗？对局将无法继续。')) onLeave()
  }

  if (snap.status === 'connecting') {
    return (
      <div className="lobby">
        <div className="spinner" />
        <p>{snap.role === 'host' ? '正在创建房间…' : `正在加入房间 ${snap.roomCode}…`}</p>
        <button type="button" onClick={onLeave}>
          取消
        </button>
      </div>
    )
  }

  if (snap.status === 'error' && !snap.state) {
    return (
      <div className="lobby">
        <h3>连接失败</h3>
        <p className="error-text">{snap.error}</p>
        <div className="modal-actions">
          {snap.role === 'guest' && (
            <button type="button" className="primary" onClick={() => session.retry()}>
              重试
            </button>
          )}
          <button type="button" onClick={onLeave}>
            返回
          </button>
        </div>
      </div>
    )
  }

  if (snap.status === 'waiting') {
    const link = inviteLink(snap.roomCode!)
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(link)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch {
        prompt('复制下面的链接发给好友：', link)
      }
    }
    return (
      <div className="lobby">
        <h3>房间已创建</h3>
        <div className="room-code">{snap.roomCode}</div>
        <p>
          你执<b className={`side-text ${snap.mySide}`}>{SIDE_NAMES[snap.mySide!].slice(0, 1)}</b>
          。把房间号或邀请链接发给好友：
        </p>
        <div className="invite">
          <input readOnly value={link} onFocus={(e) => e.target.select()} />
          <button type="button" className="primary" onClick={copy}>
            {copied ? '已复制 ✓' : '复制链接'}
          </button>
        </div>
        <p className="muted">
          <span className="spinner small" /> 等待对手加入…（请保持本页面打开）
        </p>
        <button type="button" onClick={onLeave}>
          关闭房间
        </button>
      </div>
    )
  }

  const state = snap.state!
  const mySide = snap.mySide!
  const votes = snap.rematchVotes
  let restartLabel = '再来一局'
  if (votes.includes(mySide)) restartLabel = '等待对方同意…'
  else if (votes.length > 0) restartLabel = '对方想再来一局，同意'

  let banner
  if (snap.opponentOnline) {
    banner = (
      <div className="conn-banner ok">
        <span className="dot" /> 房间 {snap.roomCode} · 对方在线
        {snap.route && (
          <span className="muted" title={snap.route === 'relay' ? '双方网络无法直连，消息经中转服务器转发' : '双方点对点直接连接'}>
            · {snap.route === 'relay' ? '经中转' : '直连'}
          </span>
        )}
      </div>
    )
  } else if (snap.role === 'host') {
    banner = (
      <div className="conn-banner warn">
        <span className="dot" /> 对方已断开，等待重新连接…（房间 {snap.roomCode}）
      </div>
    )
  } else if (snap.reconnecting) {
    banner = (
      <div className="conn-banner warn">
        <span className="spinner small" /> 与房主的连接中断，正在重连…
      </div>
    )
  } else {
    banner = (
      <div className="conn-banner bad">
        <span>{snap.error ?? '连接已断开'}</span>
        <button type="button" onClick={() => session.retry()}>
          重新连接
        </button>
      </div>
    )
  }

  const shareReplay = () => {
    const { seed, actions } = session.replayData()
    setSharing(makeReplay(seed, actions, { mode: 'online', [mySide]: '我', [other(mySide)]: '对手' }))
  }

  return (
    <>
      <GameView
        key={state.seed}
        state={state}
        dispatch={(a) => session.submit(a)}
        mySide={mySide}
        onExit={confirmLeave}
        onRestart={() => session.requestRematch()}
        restartLabel={restartLabel}
        restartDisabled={votes.includes(mySide) || !snap.opponentOnline}
        banner={banner}
        onShareReplay={shareReplay}
      />
      {sharing && <ReplayShareModal replay={sharing} onClose={() => setSharing(null)} />}
    </>
  )
}

const CHECK_ITEMS: { key: keyof NetworkCheck; name: string; fail: string }[] = [
  { key: 'signaling', name: '联机服务器', fail: '连不上，双方无法交换连接信息。请检查网络，或者换个网络再试' },
  { key: 'stun', name: '直连能力', fail: '拿不到公网地址，只能走中转（不影响联机）' },
  { key: 'relayUdp', name: '中转服务器（UDP）', fail: '连不上' },
  { key: 'relayTcp', name: '中转服务器（TCP）', fail: '连不上' },
]

/** 网络检测：逐项检查联机要用到的服务器，帮玩家判断是哪一步出了问题 */
function NetworkCheckCard() {
  const [result, setResult] = useState<NetworkCheck | 'running' | null>(null)
  const run = async () => {
    setResult('running')
    setResult(await checkNetwork())
  }
  const r = result !== 'running' ? result : null
  let verdict = ''
  if (r) {
    if (!r.signaling) verdict = '❌ 连不上联机服务器，暂时无法联机'
    else if (!r.relayUdp && !r.relayTcp && !r.stun) verdict = '❌ 直连和中转都不可用，联机很可能失败'
    else if (!r.relayUdp && !r.relayTcp) verdict = '⚠ 中转服务器连不上，只能直连，换个网络更稳'
    else verdict = '✅ 网络正常，可以联机'
  }
  return (
    <section className="lobby-card net-check">
      <h3>网络检测</h3>
      {r && (
        <ul>
          {CHECK_ITEMS.map((item) => (
            <li key={item.key}>
              <span>{r[item.key] ? '✅' : '❌'}</span> {item.name}
              {!r[item.key] && <span className="muted">：{item.fail}</span>}
            </li>
          ))}
        </ul>
      )}
      {r && <p>{verdict}</p>}
      <button type="button" onClick={run} disabled={result === 'running'}>
        {result === 'running' ? '检测中…（约 10 秒）' : r ? '重新检测' : '开始检测'}
      </button>
    </section>
  )
}
