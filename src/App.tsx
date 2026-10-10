import { useState } from 'react'
import { GameView } from './ui/GameView'
import { Home } from './ui/Home'
import './App.css'

export default function App() {
  const [screen, setScreen] = useState<'home' | 'game'>('home')
  return (
    <main className="app">
      {screen === 'home' ? <Home onStart={() => setScreen('game')} /> : <GameView onExit={() => setScreen('home')} />}
    </main>
  )
}
