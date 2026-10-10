# 开发文档

## 环境与命令

需要 Node.js 20 以上（开发时使用 24）。

```bash
npm install
npm run dev      # 本地开发 http://localhost:5173
npm test         # 单元测试（规则引擎 + 联机会话）
npm run build    # 类型检查并构建到 dist/
npm run lint     # oxlint
npm run sim      # AI 自我对战，统计锦囊强度（见下文）
```

## 目录结构

```
src/
  engine/            # 规则引擎：纯逻辑，不依赖 UI，可在 Node 中运行
    types.ts         # 数据类型（棋子、走法、锦囊状态、操作 Action）
    board.ts         # 棋盘常量、初始局面、工具函数
    movegen.ts       # 走法生成，读取锦囊的 RuleMods
    augments.ts      # 全部锦囊定义
    game.ts          # 对局状态机：走子、保护判定、锦囊发放、胜负判定、CONFIG
    rng.ts           # 种子哈希随机数
  ai/
    bot.ts           # 对弈 AI：搜索、评估、难度与性格、选锦囊
    worker.ts        # 在 Web Worker 中运行 AI
    client.ts        # 主线程调用 AI 的句柄（可取消）
  replay/replay.ts   # 回放的编码、解码与序列化
  net/               # 联机
    protocol.ts      # 消息格式与协议版本
    transport.ts     # 传输层接口
    peerTransport.ts # PeerJS（WebRTC P2P）实现
    memoryTransport.ts # 进程内实现，测试用
    session.ts       # 联机会话：房主权威、断线重连、再来一局
  ui/                # React 界面
    GameView.tsx     # 通用对局界面（同屏、联机共用）
    Board.tsx        # SVG 棋盘、棋子与特效
    HotseatGame.tsx  # 同屏对战
    AiGame.tsx       # 人机对战（设置与对局）
    OnlineGame.tsx   # 联机大厅与房间
    Replay.tsx       # 回放的分享、导入与播放
    useLocalGame.ts  # 本机对局的历史记录（悔棋、回放）
scripts/simulate.ts  # 自我对战统计
```

## 规则引擎

- 坐标：`x` 0–8 从左到右，`y` 0–9，`y = 0` 为黑方底线，`y = 9` 为红方底线
- 胜负：**吃掉对方将帅获胜**。走法生成不过滤送将，所以引擎里没有"将军/将死"的概念
- 状态不可变：`applyAction(state, action)` 返回新状态，原状态不变。界面的悔棋、AI 搜索、联机重放都依赖这一点
- 所有可调数值集中在 `game.ts` 的 `CONFIG`：发放回合、品质概率、刷新次数、回合上限、逆风补偿阈值

### 确定性

所有随机都由 `rngFor(种子, 用途, ...)` 哈希得到，**与调用顺序无关**。联机时双方只同步操作，各自在本地运行引擎，结果必然一致。

因此：

- 引擎中不要使用 `Math.random()`
- **任何会改变规则结果的改动（包括锦囊数值、走法生成的顺序）都要把 `src/engine/game.ts` 的 `RULES_VERSION` 加一**。联机协议版本直接使用它，版本不同的双方会被拒绝连接；回放也会记录它，打开旧版回放时会提示

## 添加锦囊

在 `src/engine/augments.ts` 的 `AUGMENT_LIST` 中加一项：

```ts
{
  id: 'example',        // 唯一 id，参与存档与联机，发布后不要改
  name: '示例',
  tier: 'gold',         // silver | gold | prism
  glyph: '例',          // 图标上的单字
  desc: '……',
  mods: { horseNoLeg: true },
  onPick(s, side, data) {},
}
```

可用的扩展点：

| 字段 | 时机 | 用途示例 |
|---|---|---|
| `mods` | 生成走法时 | 马不蹩腿、炮隔两子、车可越子（见 `RuleMods`） |
| `onPick` | 选中时 | 加护盾、召唤棋子、策反兵卒 |
| `onAfterMove` | 拥有者每走一步后 | 升变、额外行动、溅射伤害 |
| `onOwnCaptured` | 拥有者的棋子被吃后 | 复活、给将帅加护盾 |
| `protects` / `onProtect` | 拥有者的棋子将被吃时 | 金蝉脱壳、空城计。`protects` 必须是纯函数，`onProtect` 负责实际效果 |
| `status` | 界面显示 | 计数器、剩余次数（也参与重复局面判定） |

`data` 是每个锦囊实例自己的数字状态（如计数器），会随状态一起克隆。

日志可以带特效：`addLog(s, 文本, side, { kind: 'revive', pos })`，界面会在对应格子播放动画，`kind` 见 `FxKind`。

新增锦囊后：

1. 在 `src/engine/engine.test.ts` 加测试
2. 运行 `npm run sim` 看强度是否在合理区间
3. 把 `RULES_VERSION` 加一

## AI

`src/ai/bot.ts` 的 `chooseAction(state, side, options)` 是唯一入口，模拟脚本、测试和界面共用。

- **搜索**：迭代加深的 negamax + alpha-beta，按思考时间截止；置换表（键为 `positionKey`）；走法排序依次为置换表最佳走法、吃子（先吃大子）、杀手走法
- **静态搜索**：叶子节点继续只看吃子，直到局面平稳，避免"吃一个子、下一步被吃回大子"的误判。吃将也是吃子，所以叶子能发现对方的吃将威胁
- **额外行动**：子局面仍是同一方行动时不取反分数
- **快速走子**：搜索里用 `applyTrustedMove`，跳过合法性查找
- **难度**（`DIFFICULTIES`）：最大深度、思考时间、是否静态搜索、根节点随机扰动、随手乱走的概率
- **性格**（`PERSONALITIES`）：评估中进攻和防守因素的权重、和棋的评分，以及挑锦囊的偏好（`AUGMENT_AI` 中每个锦囊的经验价值和进攻 / 防守标签）

界面通过 `BotClient` 在 Web Worker 里调用 AI。新的请求或 `cancel()` 会作废未返回的结果；如果 Worker 正在计算，会直接换一个新的 Worker，所以悔棋不用等上一次搜索结束。

新增锦囊后，记得在 `AUGMENT_AI` 里给它一个价值和标签。

## 回放

`src/replay/replay.ts`。一局棋由"种子 + 操作序列"完整决定，回放只存这两样：

- 走子编码为它在 `legalMoves(当前局面)` 中的序号（36 进制）；选锦囊、刷新、跳过、认输用大写字母开头的记号，避免和序号混淆
- 一整局通常只有几百个字符，放进链接的 `#replay=` 后面即可分享，不需要服务器
- 因为依赖走法生成的顺序，回放记录了 `RULES_VERSION`；版本不同时仍会尝试播放，失败则提示

## 平衡性模拟

`scripts/simulate.ts` 让 AI 互相对战，统计每个锦囊拥有者的得分率（和棋算半分）：

```bash
npm run sim -- --games 400              # 默认 3 个线程、最低优先级
npm run sim -- --games 200 --no-augments  # 对照组：不发锦囊
npm run sim -- --threads 2              # 调整并发
npm run sim -- --comeback               # 开启逆风补偿（默认关闭，以便单独衡量锦囊强度）
```

> ⚠️ 模拟很吃 CPU。默认只开 3 个线程并以最低优先级运行，400 局大约 7 分钟。不要把线程数开到接近核心数，会让电脑卡顿。

解读时注意：

- AI 只搜索 2 层，防守能力弱，所以**保护将帅、加护盾类锦囊在模拟中会被高估**；需要长远规划的走法类锦囊会被低估
- 同一档内各锦囊得分率在 45%–58% 之间算正常；±值是 95% 置信区间
- 目标：同档锦囊强度接近，而不是所有锦囊都正好 50%

## 联机

### 架构

- **房主权威**：客人的操作先发给房主，房主用规则引擎校验，按顺序编号后广播；双方按同一顺序应用
- 客人收到的编号出现缺口时会请求完整同步（`resync`）
- 客人身份保存在 `sessionStorage`，刷新页面后用同一身份重连；不同身份的第三人会被拒绝
- 心跳每 4 秒一次，13 秒没有消息视为断线

### 传输层

会话逻辑只依赖 `Transport` 接口：

```ts
interface Transport {
  host(): Promise<HostHandle>          // 创建房间
  join(roomCode: string): Promise<Connection>
}
```

目前的实现是 `peerTransport`（PeerJS，信令走 PeerJS 公共服务器，STUN 优先用国内可用的地址，并保留 PeerJS 的公共 TURN 兜底）。

如果以后要提高国内连通率，可以新增一个 WebSocket 中转实现：服务器只需要按房间号转发消息，不需要理解游戏规则。然后在 `OnlineGame.tsx` 中替换传输层即可。

### 测试

`src/net/session.test.ts` 用 `MemoryNetwork` 模拟网络，覆盖加入、并发选锦囊、越权操作、断线重连、房间已满、再来一局。

## 部署

推送到 `main` 后，GitHub Actions 会依次运行测试、构建，并发布到 GitHub Pages（`.github/workflows/deploy.yml`）。`vite.config.ts` 中 `base: './'`，所以部署在子路径下也能正常加载。

开发模式下，同屏对战会把 `window.__xq = { state, dispatch }` 暴露给控制台，方便调试；生产构建中不会包含。
