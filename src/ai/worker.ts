// 在后台线程里运行 AI，思考时不阻塞界面
import type { GameState, Side } from '../engine'
import { chooseAction, type BotOptions } from './bot'

export interface BotRequest {
  id: number
  state: GameState
  side: Side
  options: BotOptions
}

self.onmessage = (e: MessageEvent<BotRequest>) => {
  const { id, state, side, options } = e.data
  const action = chooseAction(state, side, options)
  self.postMessage({ id, action })
}
