import type { Action, GameState, Side } from '../engine'
import type { BotOptions, MoveScore } from './bot'
import type { BotRequest } from './worker'

/** 让 AI 至少"想"这么久，避免落子太快看不清 */
const MIN_THINK_MS = 450

type Payload = BotRequest extends infer R ? (R extends BotRequest ? Omit<R, 'id'> : never) : never

/**
 * 主线程这边的 AI 句柄。每次请求都会作废之前尚未返回的请求，
 * 所以悔棋、重开时直接再发请求或 cancel 即可。
 */
export class BotClient {
  private worker: Worker | null = null
  private seq = 0
  private pending: ((r: unknown) => void) | null = null

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<{ id: number; result: unknown }>) => {
        if (e.data.id !== this.seq) return // 过期的结果
        const resolve = this.pending
        this.pending = null
        resolve?.(e.data.result)
      }
    }
    return this.worker
  }

  /** 发出请求；被取消或被新的请求覆盖时返回 null */
  private async run<T>(payload: Payload): Promise<T | null> {
    this.cancel()
    const id = ++this.seq
    const result = await new Promise<unknown>((resolve) => {
      this.pending = resolve
      this.ensureWorker().postMessage({ ...payload, id } as BotRequest)
    })
    return id === this.seq ? (result as T | null) : null
  }

  /** 返回 AI 的操作；如果期间被取消或被新的请求覆盖，返回 null */
  async think(state: GameState, side: Side, options: BotOptions): Promise<Action | null> {
    const started = performance.now()
    const action = await this.run<Action>({ kind: 'choose', state, side, options })
    if (action === null) return null
    const id = this.seq
    const wait = MIN_THINK_MS - (performance.now() - started)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    return id === this.seq ? action : null
  }

  /** 给当前行动方的每个走法打分；被取消时返回 null */
  score(state: GameState, options: { maxDepth?: number; timeMs?: number } = {}): Promise<MoveScore[] | null> {
    return this.run<MoveScore[]>({ kind: 'score', state, options })
  }

  cancel() {
    this.seq++
    const resolve = this.pending
    if (resolve) {
      // 后台线程里的搜索无法中途打断，直接换一个新线程，避免悔棋后还要等上一次算完
      this.worker?.terminate()
      this.worker = null
    }
    this.pending = null
    resolve?.(null)
  }

  dispose() {
    this.cancel()
    this.worker?.terminate()
    this.worker = null
  }
}
