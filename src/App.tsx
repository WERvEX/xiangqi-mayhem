import { useState } from 'react'
import { parseReplay, ReplayError, type LoadedReplay } from './replay/replay'
import { AiGame } from './ui/AiGame'
import { HotseatGame } from './ui/HotseatGame'
import { Home } from './ui/Home'
import { OnlineGame } from './ui/OnlineGame'
import { ReplayImport, ReplayView } from './ui/Replay'
import './App.css'

type Screen =
  | { name: 'home' }
  | { name: 'hotseat' }
  | { name: 'ai' }
  | { name: 'online'; invite: string | null }
  | { name: 'replay-import'; error?: string }
  | { name: 'replay'; replay: LoadedReplay }

/** 根据链接决定首屏：…/#room=123456 是联机邀请，…/#replay=… 是回放 */
function initialScreen(): Screen {
  const room = /room=(\d{6})/.exec(location.hash)?.[1]
  if (room) return { name: 'online', invite: room }
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
  const home = () => {
    clearHash()
    setScreen({ name: 'home' })
  }

  return (
    <main className="app">
      {screen.name === 'home' && (
        <Home
          onHotseat={() => setScreen({ name: 'hotseat' })}
          onAi={() => setScreen({ name: 'ai' })}
          onOnline={() => setScreen({ name: 'online', invite: null })}
          onReplay={() => setScreen({ name: 'replay-import' })}
        />
      )}
      {screen.name === 'hotseat' && <HotseatGame onExit={home} />}
      {screen.name === 'ai' && <AiGame onExit={home} />}
      {screen.name === 'online' && <OnlineGame onExit={home} initialCode={screen.invite} />}
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
