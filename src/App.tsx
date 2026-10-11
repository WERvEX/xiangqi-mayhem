import { useEffect, useState } from 'react'
import { parseReplay, ReplayError, type LoadedReplay } from './replay/replay'
import { AiGame } from './ui/AiGame'
import { HotseatGame } from './ui/HotseatGame'
import { EveGame } from './ui/EveGame'
import { Home, PvpMenu } from './ui/Home'
import { LlmSettingsPage } from './ui/LlmSettings'
import { OnlineGame } from './ui/OnlineGame'
import { ReplayImport, ReplayView } from './ui/Replay'
import './App.css'

type Screen =
  | { name: 'home' }
  | { name: 'pvp' }
  | { name: 'pve'; opponent?: 'rule' | 'llm'; resume?: boolean }
  | { name: 'eve'; resume?: boolean }
  /** back：设置页返回到哪里 */
  | { name: 'settings'; back: Screen }
  | { name: 'hotseat'; resume?: boolean }
  | { name: 'online'; invite: string | null; host?: string }
  | { name: 'replay-import'; error?: string }
  | { name: 'replay'; replay: LoadedReplay }

/** 根据链接决定首屏：…/#room=123456 是联机邀请，…/#replay=… 是回放 */
function initialScreen(): Screen {
  const room = /room=(\d{6})/.exec(location.hash)?.[1]
  if (room) return { name: 'online', invite: room }
  // 房主刷新了页面：恢复房间
  const host = /host=(\d{6})/.exec(location.hash)?.[1]
  if (host) return { name: 'online', invite: null, host }
  if (location.hash.includes('replay=')) {
    try {
      return { name: 'replay', replay: parseReplay(location.hash) }
    } catch (e) {
      return { name: 'replay-import', error: e instanceof ReplayError ? e.message : '无法打开这个回放' }
    }
  }
  return { name: 'home' }
}

const clearHash = () => {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search)
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(initialScreen)

  // 页面已经打开时，在同一个标签页里打开回放或邀请链接只会改变 # 后面的部分，不会重新加载，
  // 所以要监听变化。游戏自己用 history.replaceState 改链接，不会触发这个事件。
  useEffect(() => {
    const onHashChange = () => {
      if (/room=|replay=/.test(location.hash)) setScreen(initialScreen())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  const home = () => {
    clearHash()
    setScreen({ name: 'home' })
  }
  const settings = (back: Screen) => () => setScreen({ name: 'settings', back })

  return (
    <main className="app">
      {screen.name === 'home' && (
        <Home
          onPvp={() => setScreen({ name: 'pvp' })}
          onPve={() => setScreen({ name: 'pve' })}
          onEve={() => setScreen({ name: 'eve' })}
          onReplay={() => setScreen({ name: 'replay-import' })}
          onSettings={settings({ name: 'home' })}
          onResume={(slot) =>
            setScreen(
              slot === 'ai'
                ? { name: 'pve', resume: true }
                : slot === 'eve'
                  ? { name: 'eve', resume: true }
                  : { name: 'hotseat', resume: true },
            )
          }
        />
      )}
      {screen.name === 'pvp' && (
        <PvpMenu
          onOnline={() => setScreen({ name: 'online', invite: null })}
          onHotseat={() => setScreen({ name: 'hotseat' })}
          onBack={home}
        />
      )}
      {screen.name === 'pve' && (
        <AiGame
          initialOpponent={screen.opponent}
          resume={screen.resume}
          onExit={home}
          onOpenSettings={settings({ name: 'pve', opponent: 'llm' })}
        />
      )}
      {screen.name === 'eve' && (
        <EveGame onExit={home} onOpenSettings={settings({ name: 'eve' })} resume={screen.resume} />
      )}
      {screen.name === 'settings' && <LlmSettingsPage onBack={() => setScreen(screen.back)} />}
      {screen.name === 'hotseat' && <HotseatGame onExit={home} resume={screen.resume} />}
      {screen.name === 'online' && <OnlineGame onExit={home} initialCode={screen.invite} hostCode={screen.host} />}
      {screen.name === 'replay-import' && (
        <>
          {screen.error && <p className="error-text center">{screen.error}</p>}
          <ReplayImport onLoad={(replay) => setScreen({ name: 'replay', replay })} onBack={home} />
        </>
      )}
      {screen.name === 'replay' && <ReplayView replay={screen.replay} onExit={home} />}
    </main>
  )
}
