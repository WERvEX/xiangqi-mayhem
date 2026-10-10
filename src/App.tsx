import { useState } from 'react'
import { HotseatGame } from './ui/HotseatGame'
import { Home } from './ui/Home'
import { OnlineGame } from './ui/OnlineGame'
import './App.css'

type Screen = 'home' | 'hotseat' | 'online'

/** 邀请链接形如 …/#room=123456 */
const roomFromHash = () => /room=(\d{6})/.exec(location.hash)?.[1] ?? null

export default function App() {
  const [inviteCode, setInviteCode] = useState(roomFromHash)
  const [screen, setScreen] = useState<Screen>(inviteCode ? 'online' : 'home')
  const home = () => {
    setInviteCode(null)
    setScreen('home')
  }

  return (
    <main className="app">
      {screen === 'home' && <Home onHotseat={() => setScreen('hotseat')} onOnline={() => setScreen('online')} />}
      {screen === 'hotseat' && <HotseatGame onExit={home} />}
      {screen === 'online' && <OnlineGame onExit={home} initialCode={inviteCode} />}
    </main>
  )
}
