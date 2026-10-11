// 在后台线程里运行 AI，思考时不阻塞界面
import type { GameState, Side } from '../engine'
import { chooseAction, scoreMoves, type BotOptions } from './bot'

export type BotRequest =
  | { id: number; kind: 'choose'; state: GameState; side: Side; options: BotOptions }
  /** 给每个走法打分（大模型的战术标注） */
  | { id: number; kind: 'score'; state: GameState; options: { maxDepth?: number; timeMs?: number } }

self.onmessage = (e: MessageEvent<BotRequest>) => {
  const req = e.data
  const result = req.kind === 'choose' ? chooseAction(req.state, req.side, req.options) : scoreMoves(req.state, req.options)
  self.postMessage({ id: req.id, result })
}
