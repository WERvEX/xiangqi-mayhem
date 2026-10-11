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
npm run llm-match  # 大模型对规则 AI，用于调提示词（见「大模型」）
npm run llm-proxy  # 本地转发，供不允许网页直连的模型服务商使用
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
  llm/               # 大模型对手（不依赖 UI，浏览器和命令行共用）
    client.ts        # 接入层：Anthropic / OpenAI 兼容接口，fetch 手写，错误分类
    settings.ts      # 模型配置的本地存储、服务商预设
    notation.ts      # 给模型看的坐标（UCCI：a–i 列，0–9 行从红方底线数）
    prompt.ts        # 系统提示词、局面、走法列表、选锦囊与发言的提示词
    annotate.ts      # 辅助标注：送将、将军、走后可被吃等客观事实
    parse.ts         # 解析模型回复（JSON、代码块、正则兜底）
    player.ts        # decide()、comment()：重试与失败处理
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
    AiGame.tsx       # 挑战 AI（设置与规则 AI 对局）
    LlmGame.tsx      # 大模型对局：发言与走棋、兜底、复盘
    LlmSettings.tsx  # 模型配置界面
    Notes.tsx        # 大模型的发言气泡与思考
    OnlineGame.tsx   # 联机大厅与房间
    Replay.tsx       # 回放的分享、导入与播放
    useLocalGame.ts  # 本机对局的历史记录（悔棋、回放）
    savedGame.ts     # 本机对局的自动存档（刷新后继续上一局）
scripts/simulate.ts  # 自我对战统计
scripts/llm-match.ts # 大模型对规则 AI（命令行）
scripts/llm-proxy*.ts # 大模型请求转发（本地工具 + 开发服务器中间件）
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

**加护盾请用 `grantShield(piece)`**（`board.ts`），不要直接 `piece.shield++`：每个子最多 `MAX_SHIELD`（目前为 1）层护盾。另外，带护盾的子主动吃子会消耗一层护盾，这条规则在 `game.ts` 的走子逻辑里统一处理。

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
- **快速走子**：搜索里用 `applyTrustedMove`，跳过合法性查找和"无棋可走"检查，并共享重复局面表（只读，判断真实对局里的重复）
- **走法缓存**：同一局面的棋盘网格和双方走法缓存在 `WeakMap` 里，正常搜索、静态搜索和评估共用
- **静态搜索只看真正能吃掉的子**：被护盾挡下的"吃子"不展开，否则护盾多时会连锁爆炸
- **评估函数**（`evalVersion`，默认 3）：
  - v1：子力、推进奖励、靠近对方将帅、护盾、士象。只用于对比
  - v2：子力 + 位置分（车出动、马居中、中炮、过河兵等）+ 灵活性（可走步数，来自规则引擎，所以会自动反映锦囊）+ 悬子（被攻击且无保护、被更便宜的子攻击）+ 将帅安全（安全出口数、附近敌方攻击子）
  - v3：v2 + 开局出子评分（车马仍在开局原位时扣分，第 13 回合起归零），用来纠正"一子多动、车马不出"
- **难度**（`DIFFICULTIES`）：最大深度、思考时间、是否静态搜索、根节点随机扰动、随手乱走的概率
- **性格**（`PERSONALITIES`）：评估中进攻和防守因素的权重、和棋的评分，以及挑锦囊的偏好（`AUGMENT_AI` 中每个锦囊的经验价值和进攻 / 防守标签）

界面通过 `BotClient` 在 Web Worker 里调用 AI。新的请求或 `cancel()` 会作废未返回的结果；如果 Worker 正在计算，会直接换一个新的 Worker，所以悔棋不用等上一次搜索结束。

新增锦囊后，记得在 `AUGMENT_AI` 里给它一个价值和标签。

### 调整评估函数的流程

1. 新写法做成新的 `evalVersion`，旧版本保留
2. 用 `npm run sim -- --compare --new <新> --old <旧> --time 300` 在相同思考时间下对战，双方轮流执红
3. 可以再用 `--depth 3` 固定深度对比，单独衡量评估本身（不计速度）
4. 新版本不弱于旧版本、且风格符合预期后，再改为默认

## 回放

`src/replay/replay.ts`。一局棋由"种子 + 操作序列"完整决定，回放只存这两样：

- 走子编码为它在 `legalMoves(当前局面)` 中的序号（36 进制）；选锦囊、刷新、跳过、认输用大写字母开头的记号，避免和序号混淆
- 一整局通常只有几百个字符，放进链接的 `#replay=` 后面即可分享，不需要服务器
- 因为依赖走法生成的顺序，回放记录了 `RULES_VERSION`；版本不同时仍会尝试播放，失败则提示

回放文件可以带上大模型的发言与思考（`notes`，按操作序号对应）。链接放不下这么多文字，所以只有文件里有。

## 大模型

设计和取舍见 [LLM-DESIGN.md](LLM-DESIGN.md)。要点：

- **每步独立请求**，不累积对话：系统提示词（规则 + 全部锦囊）整局不变，可以命中缓存；用户消息放局面、最近几步、带编号的合法走法和模型自己留的备忘。备忘由调用方保存，悔棋时随记录一起撤回
- **发言与走棋两个请求同时发出**。发言请求里没有走法列表，模型说话时还没决定走哪步，不会剧透
- 模型只回编号，所以不会走出违规棋。格式不对时带着错误原因重试一次，仍失败返回 `ok: false`，由界面用规则 AI（困难）代走并标出；密钥、余额、网络等错误直接抛出，界面暂停对局让玩家处理
- 不用官方 SDK：SDK 附带的 `x-stainless-*` 请求头会被很多第三方兼容接口的跨域设置拦截
- 改了提示词，用 `llm-match` 实际跑几局看合法率、兜底率和棋步质量。模型配置从环境变量读取，密钥不要写进文件：

```bash
XQM_LLM_PROTOCOL=openai XQM_LLM_BASE=https://api.deepseek.com XQM_LLM_KEY=... XQM_LLM_MODEL=deepseek-chat   npm run llm-match -- --bot beginner --side red --max-steps 40
```

  可选参数：`--no-annotate`（关辅助标注）、`--no-comment`（不发言）、`--seed`；环境变量 `XQM_LLM_REASONING` 设思考强度。回放（含发言与思考）写到 `.sim/`，可以在网页的「观看回放」里打开
- **跨域**：开发服务器自带转发 `/__llm_proxy/<目标地址>`，设置界面「高级」里有一键填写按钮；网页版用户运行 `npm run llm-proxy`。转发只接受本机页面和正式站点的请求，只转发到 https 地址
- 单元测试（`src/llm/llm.test.ts`）用假的 fetch，不调用真实接口

## 平衡性模拟

`scripts/simulate.ts` 让 AI 互相对战，统计每个锦囊拥有者的得分率（和棋算半分）：

`npm run sim` 会先用 esbuild 打包再运行：tsx 为保留函数名插入的辅助调用会明显拖慢走法生成，打包后的速度更接近浏览器。

```bash
npm run sim -- --games 400              # 默认 3 个线程、最低优先级
npm run sim -- --games 200 --no-augments  # 对照组：不发锦囊
npm run sim -- --threads 2              # 调整并发
npm run sim -- --comeback               # 开启逆风补偿（默认关闭，以便单独衡量锦囊强度）
npm run sim -- --compare --new 3 --old 2 --time 300   # AI 评估版本对比（见上文 AI 一节）
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

目前的实现是 `peerTransport`（PeerJS），用到三种服务器：

- **信令**：PeerJS 公共服务器，只在建立连接时交换连接信息
- **STUN**（打洞）：优先用国内可用的地址，见 `src/net/iceServers.ts`
- **TURN**（中转）：部署在我们自己的云服务器上（coturn）。双方都在运营商级 NAT 后面（手机流量、很多家庭宽带）时打洞会失败，就走中转。PeerJS 原来的公共 TURN 已经停止服务（域名不再解析）

连上之后，联机状态条会显示「直连」或「经中转」；联机大厅有「网络检测」，逐项检查信令、打洞和中转。

### 中转服务器

- 安装：在一台 Ubuntu 云服务器上运行 `bash scripts/turn-setup.sh <公网IP>`，然后在云服务商控制台放行 UDP 3478、TCP 3478、UDP 49152-49999，把脚本输出的地址和密码填进 `src/net/iceServers.ts`
- 用户名密码写在前端代码里，是公开的。服务器端做了限制，被拿去当通用中转也没什么用：
  - 每个会话最多 16 KB/s，总共约 2.4 Mbps
  - 只做 UDP 中转
  - 禁止中转到内网地址
- 检查中转：在浏览器控制台执行 `localStorage.xqmForceRelay = 1` 后刷新，这个浏览器就只会走中转；开两个标签页联机，状态条应显示「经中转」。用完执行 `localStorage.removeItem('xqmForceRelay')`

如果以后要做排位等需要服务器权威的模式，可以新增一个 WebSocket 传输实现，在 `OnlineGame.tsx` 中替换传输层即可。

### 测试

`src/net/session.test.ts` 用 `MemoryNetwork` 模拟网络，覆盖加入、并发选锦囊、越权操作、断线重连、房间已满、再来一局。

## 部署

推送到 `main` 后，GitHub Actions 会依次运行测试、构建，并发布到 GitHub Pages（`.github/workflows/deploy.yml`）。`vite.config.ts` 中 `base: './'`，所以部署在子路径下也能正常加载。

开发模式下，人机对战和大模型对战会把 `window.__xq = { state, dispatch }` 暴露给控制台，方便调试；生产构建中不会包含。
