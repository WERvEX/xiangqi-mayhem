import { describe, expect, it } from 'vitest'
import { legalMoves, other, type Side } from '../engine'
import { MemoryNetwork } from './memoryTransport'
import { OnlineSession } from './session'

const flush = () => new Promise((r) => setTimeout(r, 0))

async function setup(pref: Side | 'random' = 'red') {
  const net = new MemoryNetwork()
  const host = OnlineSession.createHost(net.transport, pref)
  await flush()
  const code = host.getSnapshot().roomCode!
  const guest = OnlineSession.join(net.transport, code, 'guest-token')
  await flush()
  return { net, host, guest, code }
}

const snap = (s: OnlineSession) => s.getSnapshot()

/** 当前行动方走一步（随便挑一个合法走法） */
function playOne(red: OnlineSession, black: OnlineSession) {
  const state = snap(red).state!
  const mover = state.turn === snap(red).mySide ? red : black
  const m = legalMoves(state)[0]
  mover.submit({ type: 'move', side: state.turn, pieceId: m.pieceId, to: m.to })
}

describe('联机会话', () => {
  it('客人加入后双方状态一致，执子相反', async () => {
    const { host, guest } = await setup('red')
    expect(snap(host).status).toBe('playing')
    expect(snap(guest).status).toBe('playing')
    expect(snap(host).mySide).toBe('red')
    expect(snap(guest).mySide).toBe('black')
    expect(snap(guest).state).toEqual(snap(host).state)
  })

  it('双方同时选锦囊，结果一致', async () => {
    const { host, guest } = await setup('red')
    const hs = snap(host).state!
    guest.submit({ type: 'reroll', side: 'black' })
    host.submit({ type: 'pick', side: 'red', augmentId: hs.draft!.sides.red.options[1] })
    await flush()
    const gOpts = snap(guest).state!.draft!.sides.black.options
    guest.submit({ type: 'pick', side: 'black', augmentId: gOpts[0] })
    await flush()
    expect(snap(host).state!.phase).toBe('play')
    expect(snap(guest).state).toEqual(snap(host).state)
  })

  it('不能替对方操作', async () => {
    const { host, guest } = await setup('red')
    const opts = snap(host).state!.draft!.sides.red.options
    guest.submit({ type: 'pick', side: 'red', augmentId: opts[0] })
    await flush()
    expect(snap(host).state!.draft!.sides.red.done).toBe(false)
  })

  it('走棋同步，断线重连后恢复完整对局', async () => {
    const { net, host, guest } = await setup('black')
    for (const s of [host, guest]) {
      const side = snap(s).mySide!
      s.submit({ type: 'pick', side, augmentId: snap(s).state!.draft!.sides[side].options[0] })
    }
    await flush()
    const red = snap(host).mySide === 'red' ? host : guest
    const black = red === host ? guest : host
    for (let i = 0; i < 6; i++) {
      playOne(red, black)
      await flush()
    }
    expect(snap(guest).state).toEqual(snap(host).state)

    net.links[0].drop()
    await flush()
    expect(snap(host).opponentOnline).toBe(false)
    expect(snap(guest).reconnecting).toBe(true)

    // 断线期间房主继续走（如果轮到房主）
    if (snap(host).state!.turn === snap(host).mySide) {
      playOne(red, black)
      await flush()
    }
    await new Promise((r) => setTimeout(r, 2700))
    expect(snap(host).opponentOnline).toBe(true)
    expect(snap(guest).reconnecting).toBe(false)
    expect(snap(guest).state).toEqual(snap(host).state)
  })

  it('房间已满时拒绝第三人', async () => {
    const { net, code } = await setup()
    const intruder = OnlineSession.join(net.transport, code, 'other-token')
    await flush()
    await flush()
    expect(snap(intruder).status).toBe('error')
    expect(snap(intruder).error).toBe('房间已满')
  })

  it('双方都同意才再来一局，并交换先后手', async () => {
    const { host, guest } = await setup('red')
    host.submit({ type: 'resign', side: 'red' })
    await flush()
    expect(snap(guest).state!.phase).toBe('over')
    guest.requestRematch()
    await flush()
    expect(snap(host).rematchVotes).toEqual(['black'])
    expect(snap(host).state!.phase).toBe('over')
    host.requestRematch()
    await flush()
    expect(snap(host).mySide).toBe('black')
    expect(snap(guest).mySide).toBe(other('black'))
    expect(snap(guest).state).toEqual(snap(host).state)
    expect(snap(host).state!.phase).toBe('draft')
  })

  it('悔棋：对方同意后撤回申请方的上一步；对方已应的一步也一起撤回', async () => {
    const { host, guest } = await setup('red')
    for (const s of [host, guest]) {
      const side = snap(s).mySide!
      s.submit({ type: 'pick', side, augmentId: snap(s).state!.draft!.sides[side].options[0] })
    }
    await flush()
    expect(guest.canRequestUndo()).toBe(false) // 还没走过棋
    playOne(host, guest) // 红（房主）走
    await flush()
    const beforeBlack = snap(host).state!
    playOne(host, guest) // 黑（客人）走
    await flush()
    const afterBlack = snap(host).state!

    // 客人申请，房主拒绝：局面不变
    guest.requestUndo()
    await flush()
    expect(snap(host).undoRequester).toBe('black')
    host.answerUndo(false)
    await flush()
    expect(snap(guest).undoRequester).toBeNull()
    expect(snap(guest).undoResult?.result).toBe('declined')
    expect(snap(host).state).toEqual(afterBlack)

    // 客人再申请，房主同意：回到黑方走棋之前
    guest.requestUndo()
    await flush()
    host.answerUndo(true)
    await flush()
    await flush()
    expect(snap(host).state).toEqual(beforeBlack)
    expect(snap(guest).state).toEqual(beforeBlack)
    expect(snap(guest).undoResult?.result).toBe('accepted')

    // 房主申请：黑方已经应了一步，两步一起撤回
    playOne(host, guest)
    await flush()
    host.requestUndo()
    await flush()
    expect(snap(guest).undoRequester).toBe('red')
    guest.answerUndo(true)
    await flush()
    await flush()
    expect(snap(host).state!.turn).toBe('red')
    expect(snap(guest).state).toEqual(snap(host).state)
  })

  it('房主刷新页面后恢复房间，客人自动重连回来', async () => {
    const { net, host, guest } = await setup('red')
    for (const s of [host, guest]) {
      const side = snap(s).mySide!
      s.submit({ type: 'pick', side, augmentId: snap(s).state!.draft!.sides[side].options[0] })
    }
    await flush()
    playOne(host, guest)
    await flush()
    const save = host.hostSave()!
    const before = snap(host).state
    host.leave() // 相当于房主刷新页面：房间和连接都没了
    await flush()
    expect(snap(guest).reconnecting).toBe(true)

    const resumed = OnlineSession.resumeHost(net.transport, save)
    await flush()
    expect(snap(resumed).state).toEqual(before)
    await new Promise((r) => setTimeout(r, 1700))
    expect(snap(resumed).opponentOnline).toBe(true)
    expect(snap(guest).reconnecting).toBe(false)
    expect(snap(guest).state).toEqual(before)
  })

  it('房间不存在时报错', async () => {
    const net = new MemoryNetwork()
    const guest = OnlineSession.join(net.transport, '999999', 't')
    await flush()
    expect(snap(guest).status).toBe('error')
  })
})
