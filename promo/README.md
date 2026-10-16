# 宣传视频

象棋大乱斗的宣传视频：横屏版（B 站 / YouTube）和竖屏版（抖音）。真实游戏画面 + Edge TTS 配音（晓伊）+ 中文字幕，不加背景音乐。

成片：`out/final/象棋大乱斗-横屏.mp4`（2:20，1920×1080）、`out/final/象棋大乱斗-竖屏.mp4`（0:40，1080×1920）

## 目录

```
promo/
├─ script.md            分镜稿（画面 + 旁白）
├─ narration.json       旁白文本，"|" 表示停顿（列举锦囊时给画面留时间）
├─ tts.py               生成旁白音频和句级时间轴 → out/tts/
├─ compose.py           剪辑表 + 合成：镜头、标题、字幕、旁白 → out/final/
├─ rec/
│  ├─ recorder.mjs      录屏工具（CDP 逐帧截取页面，不录声音）
│  ├─ scene.mjs         把找好的局面作为同屏对战存档载入、按棋盘坐标点击
│  ├─ shots.mjs         不需要大模型的镜头 → out/clips/
│  ├─ llm-shots.mjs     大模型镜头（挑战大模型、模型斗蛐蛐）→ out/clips/
│  ├─ llm-setup.mjs     打开录屏专用浏览器，由本人填写大模型 API 密钥
│  ├─ proxy.ts          录屏用的大模型转发（连接超时自动重试）
│  └─ readme-shots.mjs  仓库 README 里的截图
├─ scenes/
│  ├─ find.ts           规则 AI 自对弈，找锦囊特效的演示局面
│  └─ found/            找到的局面（种子 + 操作序列）
└─ out/                 不进仓库
   ├─ clips/            录好的原始素材（.marks.json 是镜头内的时间标记）
   ├─ tts/              旁白音频
   ├─ llm-profile/      录屏专用浏览器配置，存着大模型 API 密钥
   └─ final/            成片
```

## 用法

先准备环境：`npm install`（playwright-core，用本机 Chrome）、`python -m venv .venv && .venv/Scripts/pip install edge-tts`、本机装好 ffmpeg。录制前游戏开发服务器要在 5173 端口运行。

```bash
.venv/Scripts/python tts.py              # 改了 narration.json 后重新生成旁白（可只传段落 id）
node rec/shots.mjs L-huoshao P-intro     # 重录指定镜头，不带参数录全部
npm run find -- huoshao                  # 重新找某个锦囊的演示局面
.venv/Scripts/python compose.py all      # 合成两版（landscape / portrait / all）
```

大模型镜头：先运行 `node rec/llm-setup.mjs` 在弹出的窗口里配置模型（密钥由本人粘贴），再启动 `.claude/launch.json` 里的 `promo-proxy`（8788 端口），然后 `node rec/llm-shots.mjs L-llm L-eve P-llm P-eve`。斗蛐蛐双方用哪个配置由环境变量 `RED` / `BLACK`（配置序号）指定。

画面里的邀请链接、回放链接显示正式网址：录屏浏览器打开的是 `wervex.github.io/xiangqi-mayhem`，请求被转给本地开发服务器。
