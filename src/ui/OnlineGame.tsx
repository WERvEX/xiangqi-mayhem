import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { other, SIDE_NAMES, type Action, type Side } from '../engine'
import { checkNetwork, peerTransport, type NetworkCheck } from '../net/peerTransport'
import { OnlineSession, type HostSave } from '../net/session'
import { makeReplay, type Replay } from '../replay/replay'
import { GameView } from './GameView'
import { ConfirmModal } from './common'
import { ReplayShareModal } from './Replay'
import { useFinishedGame } from './useFinishedGame'

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

const HOST_KEY = 'xqm-host-room'

/** 房主在这个标签页里保存的房间（刷新页面后恢复用） */
function readHostSave(code: string): HostSave | null {
  try {
    const save = JSON.parse(sessionStorage.getItem(HOST_KEY) ?? 'null') as HostSave | null
    return save?.roomCode === code ? save : null
  } catch {
    return null
  }
}

/** 页面打开时要不要直接恢复会话：房主刷新后恢复房间；客人刷新后自动重连 */
type AutoStart = { kind: 'host'; save: HostSave } | { kind: 'guest'; code: string } | null

export function OnlineGame({
  onExit,
  initialCode,
  hostCode,
}: {
  onExit: () => void
  initialCode: string | null
  /** 链接里的 #host=房间号：房主刷新了页面 */
  hostCode?: string | null
}) {
  const [session, setSession] = useState<OnlineSession | null>(null)
  const [auto] = useState<AutoStart>(() => {
    const save = hostCode ? readHostSave(hostCode) : null
    if (save) return { kind: 'host', save }
    // 这个标签页之前加入过这个房间（有身份记录），说明是刷新：直接重连
    if (initialCode && sessionStorage.getItem(`xqm-token-${initialCode}`)) return { kind: 'guest', code: initialCode }
    return null
  })

  // 只在页面打开时执行一次。会话要连网络，不能在渲染时创建，所以放在 effect 里。
  // 开发模式下 effect 会执行两次：第一次创建的会话必须在这里关掉，否则它会一直占着房间号
  useEffect(() => {
    if (!auto) return
    const s =
      auto.kind === 'host'
        ? OnlineSession.resumeHost(peerTransport, auto.save)
        : OnlineSession.join(peerTransport, auto.code, guestToken(auto.code))
    // eslint-disable-next-line react/set-state-in-effect
    setSession(s)
    return () => s.leave()
  }, [auto])

  useEffect(() => () => session?.leave(), [session])

  const leave = () => {
    sessionStorage.removeItem(HOST_KEY)
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
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const [sharing, setSharing] = useState<Replay | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  /** 已经看过的悔棋结果提示（按时间） */
  const [noticeSeen, setNoticeSeen] = useState(0)
  const inviteRef = useRef<HTMLInputElement>(null)

  const inGame = snap.status === 'playing'
  const mySide = snap.mySide

  // 对局中关闭或刷新页面前提醒
  useEffect(() => {
    if (!inGame) return
    const handler = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [inGame])

  // 房主：随时保存房间，刷新页面后可以恢复（只存在这个标签页里）
  useEffect(() => {
    const save = session.hostSave()
    if (!save) return
    sessionStorage.setItem(HOST_KEY, JSON.stringify(save))
    if (!location.hash.includes(`host=${save.roomCode}`)) history.replaceState(null, '', `#host=${save.roomCode}`)
  }, [session, snap])

  // 客人：页面从后台回到前台时，如果断线了就立即重连（手机切出去发消息再回来很常见）
  useEffect(() => {
    if (snap.role !== 'guest') return
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !session.getSnapshot().opponentOnline) session.retry()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [session, snap.role])

  // 客人关掉页面（包括手机上的返回手势）时告诉房主，换个页面能马上重新加入
  useEffect(() => {
    const onHide = () => session.pageClosing()
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [session])

  // 开发模式下暴露给控制台，便于调试和测试（生产构建会移除）
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __xq: { state: snap.state, dispatch: (a: Action) => session.submit(a), session } })
  })

  // 悔棋结果提示显示几秒后自动消失
  const undoResult = snap.undoResult
  useEffect(() => {
    if (!undoResult || undoResult.at <= noticeSeen) return
    const t = setTimeout(() => setNoticeSeen(undoResult.at), 4000)
    return () => clearTimeout(t)
  }, [undoResult, noticeSeen])

  const buildReplay = () => {
    const { seed, actions } = session.replayData()
    return makeReplay(seed, actions, { mode: 'online', ...(mySide ? { [mySide]: '我', [other(mySide)]: '对手' } : {}) })
  }
  const finished = useFinishedGame(snap.state, buildReplay, mySide)

  const leave = () => {
    if (!inGame || snap.state?.phase === 'over') onLeave()
    else setConfirmLeave(true)
  }

  if (snap.status === 'connecting') {
    return (
      <div className="lobby">
        <div className="spinner" />
        <p>
          {snap.role === 'host'
            ? snap.roomCode
              ? `正在恢复房间 ${snap.roomCode}…`
              : '正在创建房间…'
            : `正在加入房间 ${snap.roomCode}…`}
        </p>
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
        setCopied('ok')
        setTimeout(() => setCopied(null), 2000)
      } catch {
        // 部分 App 内置浏览器不允许写剪贴板：选中链接，让玩家手动复制
        inviteRef.current?.select()
        setCopied('fail')
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
          <input ref={inviteRef} readOnly value={link} onFocus={(e) => e.target.select()} />
          <button type="button" className="primary" onClick={copy}>
            {copied === 'ok' ? '已复制 ✓' : '复制链接'}
          </button>
        </div>
        {copied === 'fail' && <p className="field-note warn">无法自动复制，链接已选中，请手动复制</p>}
        <p className="muted">
          <span className="spinner small" /> 等待对手加入…（刷新页面不会关闭房间）
        </p>
        <button type="button" onClick={onLeave}>
          关闭房间
        </button>
      </div>
    )
  }

  const state = snap.state!
  const side = mySide!
  const votes = snap.rematchVotes
  let restartLabel = '再来一局'
  if (votes.includes(side)) restartLabel = '等待对方同意…'
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
  } else if (snap.role === 'host' && snap.opponentLeft) {
    banner = (
      <div className="conn-banner warn">
        <span>
          对方离开了房间。把房间号 {snap.roomCode} 或邀请链接发给对方，重新加入就能接着下
        </span>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(inviteLink(snap.roomCode!))}>
          复制邀请链接
        </button>
      </div>
    )
  } else if (snap.role === 'host') {
    banner = (
      <div className="conn-banner warn">
        <span className="spinner small" /> 对方已断开，等待对方重新连接…（房间 {snap.roomCode}）
      </div>
    )
  } else if (snap.reconnecting) {
    banner = (
      <div className="conn-banner warn">
        <span className="spinner small" /> 与房主的连接中断，正在重连…（第 {snap.reconnectAttempt} 次）
        <button type="button" onClick={() => session.retry()}>
          立即重试
        </button>
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

  let undoNotice: string | null = null
  if (snap.undoRequester === side) undoNotice = '已申请悔棋，等待对方回应…'
  else if (undoResult && undoResult.at > noticeSeen) {
    if (undoResult.requester === side) undoNotice = undoResult.result === 'accepted' ? '对方同意了悔棋' : '对方拒绝了悔棋'
    else if (undoResult.result === 'accepted') undoNotice = '已悔棋'
  }

  return (
    <>
      {finished.reviewView}
      {/* 看回放时只隐藏对局界面，返回后界面状态不变 */}
      <div hidden={!!finished.reviewView}>
        <GameView
          key={state.seed}
          state={state}
          dispatch={(a) => session.submit(a)}
          mySide={side}
          onExit={leave}
          onUndo={session.canRequestUndo() ? () => session.requestUndo() : undefined}
          undoLabel="申请悔棋"
          onRestart={() => session.requestRematch()}
          restartLabel={restartLabel}
          restartDisabled={votes.includes(side) || !snap.opponentOnline}
          banner={
            <>
              {banner}
              {undoNotice && <div className="undo-notice">{undoNotice}</div>}
            </>
          }
          onShareReplay={() => setSharing(buildReplay())}
          onWatchReplay={finished.watch}
        />
      </div>
      {snap.undoRequester && snap.undoRequester !== side && (
        <ConfirmModal
          title="对方申请悔棋"
          message="同意后，撤回对方的上一步棋（如果你已经应了一步，也一起撤回）。"
          confirmLabel="同意"
          cancelLabel="拒绝"
          onConfirm={() => session.answerUndo(true)}
          onCancel={() => session.answerUndo(false)}
        />
      )}
      {confirmLeave && (
        <ConfirmModal
          title="确定离开房间吗？"
          message={snap.role === 'host' ? '你是房主，离开后房间关闭，对局无法继续。' : '离开后对局无法继续。'}
          confirmLabel="离开"
          cancelLabel="留下"
          danger
          onConfirm={onLeave}
          onCancel={() => setConfirmLeave(false)}
        />
      )}
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
