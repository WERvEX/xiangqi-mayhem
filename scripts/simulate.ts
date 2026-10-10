/**
 * AI 自我对战，统计锦囊强度与对局节奏。
 *
 *   npm run sim -- --games 400 --depth 2
 *   npm run sim -- --games 200 --no-augments     # 对照组：纯象棋（吃将获胜）
 *   npm run sim -- --threads 2                   # 并发线程数，默认 3
 *   npm run sim -- --comeback                    # 开启逆风补偿（默认关闭，以便单独衡量锦囊强度）
 *
 * 默认只用少量线程并以最低优先级运行，避免占满 CPU 影响电脑正常使用。
 *
 * 锦囊随机选择（不刷新），这样"拥有某锦囊时的胜率"可以直接反映它的强度。
 */
import { availableParallelism, constants, setPriority } from 'node:os'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { chooseAction } from '../src/ai/bot'
import { AUGMENTS, CONFIG, createGame, applyAction, roundOf, type GameState, type Side } from '../src/engine'

interface GameResult {
  winner: Side | null
  rounds: number
  reason: string
  augments: Record<Side, string[]>
  /** 每次发放时的回合 */
  draftRounds: number[]
  /** 第一次吃子发生的回合 */
  firstCaptureRound: number | null
}

function playGame(seed: string, depth: number, noAugments: boolean): GameResult {
  let rngState = [...seed].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0
  const rng = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0
    return rngState / 4294967296
  }
  let s: GameState = createGame(seed)
  const draftRounds: number[] = []
  let firstCaptureRound: number | null = null
  for (let step = 0; step < 2000 && s.phase !== 'over'; step++) {
    if (s.phase === 'draft') {
      if (s.draft!.sides.red.rerollNo === 0 && !s.draft!.sides.red.done && !s.draft!.sides.black.done) {
        draftRounds.push(roundOf(s))
      }
      for (const side of ['red', 'black'] as Side[]) {
        if (s.draft!.sides[side].done) continue
        if (noAugments) {
          s.draft!.sides[side].done = true
          if (s.draft!.sides.red.done && s.draft!.sides.black.done) {
            s.draft = null
            s.draftsDone++
            s.phase = 'play'
          }
          continue
        }
        s = applyAction(s, chooseAction(s, side, { depth, rng, pick: 'random' })!)
        if (s.phase !== 'draft') break
      }
      continue
    }
    const before = s.pieces.filter((p) => p.alive).length
    s = applyAction(s, chooseAction(s, s.turn, { depth, rng })!)
    if (firstCaptureRound === null && s.pieces.filter((p) => p.alive).length < before) firstCaptureRound = roundOf(s)
  }
  return {
    winner: s.winner,
    rounds: roundOf(s),
    reason: s.phase === 'over' ? s.endReason!.replace(/[红黑]方/g, 'X方') : '步数上限',
    augments: { red: s.augments.red.map((a) => a.id), black: s.augments.black.map((a) => a.id) },
    draftRounds,
    firstCaptureRound,
  }
}

if (!isMainThread) {
  const { seeds, depth, noAugments, comeback } = workerData as {
    seeds: string[]
    depth: number
    noAugments: boolean
    comeback: boolean
  }
  // 默认关闭逆风补偿：否则落后方更容易拿到高品质锦囊，会把高品质锦囊的胜率拉低
  if (!comeback) CONFIG.comebackThreshold = Infinity
  for (const seed of seeds) parentPort!.postMessage(playGame(seed, depth, noAugments))
} else {
  const args = process.argv.slice(2)
  const arg = (name: string, def: number) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? Number(args[i + 1]) : def
  }
  const games = arg('games', 200)
  const depth = arg('depth', 2)
  const noAugments = args.includes('--no-augments')
  const comeback = args.includes('--comeback')
  const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : 'sim'
  const threads = Math.max(1, Math.min(arg('threads', 3), availableParallelism() - 1, games))
  try {
    setPriority(constants.priority.PRIORITY_LOW)
  } catch {
    // 某些系统不允许调整优先级，忽略即可
  }
  console.error(`使用 ${threads} 个线程，低优先级运行`)

  const seeds = Array.from({ length: games }, (_, i) => `${tag}-${i}`)
  const results: GameResult[] = []
  const start = Date.now()
  await Promise.all(
    Array.from({ length: threads }, (_, t) => {
      const chunk = seeds.filter((_, i) => i % threads === t)
      return new Promise<void>((resolve, reject) => {
        const w = new Worker(new URL(import.meta.url), {
          workerData: { seeds: chunk, depth, noAugments, comeback },
          execArgv: ['--import', 'tsx'],
        })
        w.on('message', (r: GameResult) => {
          results.push(r)
          if (results.length % 50 === 0) process.stderr.write(`  ${results.length}/${games}\n`)
        })
        w.on('error', reject)
        w.on('exit', () => resolve())
      })
    }),
  )
  report(results, games, depth, noAugments, (Date.now() - start) / 1000)
}

function report(results: GameResult[], games: number, depth: number, noAugments: boolean, secs: number) {
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '-')
  const red = results.filter((r) => r.winner === 'red').length
  const black = results.filter((r) => r.winner === 'black').length
  const draws = results.length - red - black
  const rounds = results.map((r) => r.rounds).sort((a, b) => a - b)
  const median = (a: number[]) => (a.length ? a[Math.floor(a.length / 2)] : NaN)
  const fc = results.map((r) => r.firstCaptureRound).filter((x): x is number => x !== null).sort((a, b) => a - b)

  console.log(`\n=== ${games} 局，搜索深度 ${depth}${noAugments ? '，无锦囊' : ''}，用时 ${secs.toFixed(0)}s ===`)
  console.log(`红胜 ${pct(red, results.length)}  黑胜 ${pct(black, results.length)}  和 ${pct(draws, results.length)}`)
  console.log(
    `回合数：中位 ${median(rounds)}，P25 ${rounds[Math.floor(rounds.length * 0.25)]}，P75 ${rounds[Math.floor(rounds.length * 0.75)]}，平均 ${(rounds.reduce((a, b) => a + b, 0) / rounds.length).toFixed(1)}`,
  )
  console.log(`首次吃子回合中位：${median(fc)}`)
  const drafts = results.map((r) => r.draftRounds.length)
  console.log(
    `每局实际发放次数：${[0, 1, 2, 3, 4].map((n) => `${n}次 ${pct(drafts.filter((d) => d === n).length, drafts.length)}`).join('  ')}`,
  )
  const reasons: Record<string, number> = {}
  for (const r of results) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1
  console.log('结束原因：' + Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('，'))

  if (noAugments) return
  console.log(`\n抽到锦囊时 ${CONFIG.draftRounds.join('/')} 回合发放；胜率 = 拥有者得分率（和棋算半分）`)
  const stats: Record<string, { n: number; score: number }> = {}
  for (const r of results) {
    for (const side of ['red', 'black'] as Side[]) {
      for (const id of new Set(r.augments[side])) {
        const st = (stats[id] ??= { n: 0, score: 0 })
        st.n++
        st.score += r.winner === side ? 1 : r.winner === null ? 0.5 : 0
      }
    }
  }
  const rows = Object.entries(stats)
    .map(([id, st]) => ({ id, ...st, rate: st.score / st.n }))
    .sort((a, b) => b.rate - a.rate)
  for (const row of rows) {
    const def = AUGMENTS[row.id]
    const ci = 1.96 * Math.sqrt((row.rate * (1 - row.rate)) / row.n)
    console.log(
      `${def.tier.padEnd(6)} ${def.name.padEnd(8, '　')} ${(row.rate * 100).toFixed(1).padStart(5)}% ±${(ci * 100).toFixed(0).padStart(2)}  (n=${row.n})`,
    )
  }
}
