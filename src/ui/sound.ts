import { useSyncExternalStore } from 'react'
import type { SoundName } from './soundEvents'

/**
 * 音效：全部用 Web Audio 现场合成，不需要音频文件。
 * 浏览器要求用户操作过页面之后才能出声，所以第一次点击时才真正启用。
 */

const KEY = 'xqm-sound'

let enabled = (() => {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
})()
const listeners = new Set<() => void>()

export function setSoundEnabled(on: boolean) {
  enabled = on
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // 无痕模式等存不了，只在本次有效
  }
  listeners.forEach((l) => l())
  if (on && userActed) unlock()
}

export function useSoundEnabled(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => enabled,
  )
}

/** 用户操作过页面了（之前创建声音会被浏览器拦下并报警告） */
let userActed = false
let ctx: AudioContext | null = null
let master: GainNode | null = null
let noiseBuf: AudioBuffer | null = null

function audio(): { c: AudioContext; out: GainNode } | null {
  if (typeof window === 'undefined' || !window.AudioContext) return null
  if (!ctx) {
    ctx = new AudioContext()
    // 压一下峰值，几个声音叠在一起也不会爆音
    const comp = ctx.createDynamicsCompressor()
    comp.connect(ctx.destination)
    master = ctx.createGain()
    master.gain.value = 0.45
    master.connect(comp)
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const d = noiseBuf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  return { c: ctx, out: master! }
}

function unlock() {
  const a = audio()
  if (a && a.c.state === 'suspended') void a.c.resume()
}

// 用户第一次操作页面时启用声音
if (typeof window !== 'undefined') {
  const once = () => {
    userActed = true
    if (enabled) unlock()
    window.removeEventListener('pointerdown', once)
    window.removeEventListener('keydown', once)
  }
  window.addEventListener('pointerdown', once)
  window.addEventListener('keydown', once)
}

interface ToneOpts {
  freq: number
  /** 滑到这个频率 */
  to?: number
  type?: OscillatorType
  at?: number
  dur: number
  gain?: number
  attack?: number
}

function tone(c: AudioContext, out: AudioNode, t0: number, o: ToneOpts) {
  const start = t0 + (o.at ?? 0)
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = o.type ?? 'sine'
  osc.frequency.setValueAtTime(o.freq, start)
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, start + o.dur)
  const attack = o.attack ?? 0.005
  g.gain.setValueAtTime(0.0001, start)
  g.gain.exponentialRampToValueAtTime(o.gain ?? 0.3, start + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, start + o.dur)
  osc.connect(g).connect(out)
  osc.start(start)
  osc.stop(start + o.dur + 0.02)
}

interface NoiseOpts {
  at?: number
  dur: number
  gain?: number
  filter?: BiquadFilterType
  freq: number
  to?: number
  q?: number
  attack?: number
}

function noise(c: AudioContext, out: AudioNode, t0: number, o: NoiseOpts) {
  const start = t0 + (o.at ?? 0)
  const src = c.createBufferSource()
  src.buffer = noiseBuf
  const f = c.createBiquadFilter()
  f.type = o.filter ?? 'bandpass'
  f.frequency.setValueAtTime(o.freq, start)
  if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, start + o.dur)
  f.Q.value = o.q ?? 1
  const g = c.createGain()
  const attack = o.attack ?? 0.002
  g.gain.setValueAtTime(0.0001, start)
  g.gain.exponentialRampToValueAtTime(o.gain ?? 0.3, start + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, start + o.dur)
  src.connect(f).connect(g).connect(out)
  src.start(start, Math.random() * 0.5)
  src.stop(start + o.dur + 0.02)
}

/**
 * 木头棋子落在木棋盘上的"嗒"：极短的撞击声 + 几个很快衰减的木头共振。
 * 不用往下滑的低频音（那样像打鼓）；每次音高略有不同，连续落子不会像复读。
 * pitch：整体音高倍数，吃子时棋子撞棋子更脆一些
 */
function clack(c: AudioContext, out: AudioNode, t: number, loud = 1, pitch = 1) {
  const v = pitch * (1 + (Math.random() - 0.5) * 0.08)
  // 撞击的瞬间
  noise(c, out, t, { dur: 0.012, gain: 0.65 * loud, filter: 'highpass', freq: 2500 * v })
  // 木头共振：窄带噪声听起来像敲木块
  noise(c, out, t, { dur: 0.055, gain: 1.4 * loud, freq: 1150 * v, q: 9 })
  tone(c, out, t, { freq: 1720 * v, dur: 0.03, gain: 0.1 * loud, attack: 0.001 })
  // 棋盘的一点闷响，很短、不滑音
  tone(c, out, t, { freq: 520 * v, dur: 0.04, gain: 0.12 * loud, attack: 0.001 })
}

const arpeggio = (c: AudioContext, out: AudioNode, t: number, notes: number[], step: number, o: Partial<ToneOpts> = {}) =>
  notes.forEach((freq, i) => tone(c, out, t, { freq, at: i * step, dur: 0.35, gain: 0.16, type: 'triangle', ...o }))

const SOUNDS: Record<SoundName, (c: AudioContext, out: AudioNode, t: number) => void> = {
  select: (c, out, t) => noise(c, out, t, { dur: 0.025, gain: 0.12, freq: 3200, q: 3 }),
  move: (c, out, t) => clack(c, out, t),
  // "啪嗒"：先撞上对方的棋子（更脆），紧接着落在棋盘上
  capture: (c, out, t) => {
    clack(c, out, t, 1.2, 1.35)
    clack(c, out, t + 0.05, 1.1)
  },
  // 玻璃似的"叮"：攻击被护盾弹开
  shieldBlock: (c, out, t) => {
    noise(c, out, t, { dur: 0.03, gain: 0.25, freq: 4000, q: 2 })
    tone(c, out, t, { freq: 1320, dur: 0.7, gain: 0.18 })
    tone(c, out, t, { freq: 1985, dur: 0.5, gain: 0.1 })
    tone(c, out, t, { freq: 2650, dur: 0.35, gain: 0.06 })
  },
  shieldUp: (c, out, t) => {
    tone(c, out, t, { freq: 520, to: 1400, dur: 0.3, gain: 0.14, attack: 0.04 })
    tone(c, out, t, { freq: 2100, at: 0.22, dur: 0.4, gain: 0.07 })
  },
  protect: (c, out, t) => {
    for (const [f, g] of [
      [880, 0.14],
      [1108, 0.1],
      [1320, 0.1],
      [1760, 0.05],
    ])
      tone(c, out, t, { freq: f, dur: 0.9, gain: g, attack: 0.01 })
  },
  revive: (c, out, t) => arpeggio(c, out, t, [523, 659, 784, 1046], 0.07),
  promote: (c, out, t) => arpeggio(c, out, t, [392, 523, 659, 784, 1046], 0.06, { type: 'square', gain: 0.07 }),
  // 呼的一下烧起来
  burn: (c, out, t) => {
    noise(c, out, t, { dur: 0.6, gain: 0.35, filter: 'lowpass', freq: 3500, to: 250, attack: 0.03 })
    tone(c, out, t, { freq: 90, to: 45, dur: 0.5, gain: 0.25 })
  },
  summon: (c, out, t) => {
    noise(c, out, t, { dur: 0.45, gain: 0.15, freq: 300, to: 2500, q: 2, attack: 0.15 })
    tone(c, out, t, { freq: 180, to: 720, dur: 0.45, gain: 0.15, type: 'triangle', attack: 0.1 })
    clack(c, out, t + 0.42)
  },
  convert: (c, out, t) => {
    tone(c, out, t, { freq: 440, to: 880, dur: 0.18, gain: 0.12, type: 'triangle' })
    tone(c, out, t, { freq: 880, to: 440, at: 0.16, dur: 0.18, gain: 0.12, type: 'triangle' })
    tone(c, out, t, { freq: 660, at: 0.32, dur: 0.3, gain: 0.12, type: 'triangle' })
  },
  swap: (c, out, t) => {
    tone(c, out, t, { freq: 700, dur: 0.08, gain: 0.12, type: 'triangle' })
    tone(c, out, t, { freq: 940, at: 0.08, dur: 0.1, gain: 0.12, type: 'triangle' })
  },
  extra: (c, out, t) => {
    tone(c, out, t, { freq: 880, dur: 0.08, gain: 0.1, type: 'triangle' })
    tone(c, out, t, { freq: 1320, at: 0.07, dur: 0.14, gain: 0.1, type: 'triangle' })
  },
  // 嘀嘀：将帅可以被直接吃掉
  check: (c, out, t) => {
    tone(c, out, t, { at: 0.12, freq: 988, dur: 0.1, gain: 0.07, type: 'square' })
    tone(c, out, t, { at: 0.26, freq: 988, dur: 0.12, gain: 0.07, type: 'square' })
  },
  // 发锦囊：一串闪光
  draft: (c, out, t) =>
    [1046, 1318, 1568, 2093, 1568, 2637].forEach((f, i) =>
      tone(c, out, t, { freq: f, at: i * 0.05, dur: 0.3, gain: 0.07 }),
    ),
  pick: (c, out, t) => tone(c, out, t, { freq: 1046, dur: 0.12, gain: 0.08, type: 'triangle' }),
  reveal: (c, out, t) => {
    for (const f of [523, 659, 784, 1046]) tone(c, out, t, { freq: f, dur: 0.9, gain: 0.08, attack: 0.08 })
    noise(c, out, t, { dur: 0.4, gain: 0.06, freq: 6000, q: 0.7, attack: 0.05 })
  },
  win: (c, out, t) => {
    arpeggio(c, out, t, [523, 659, 784], 0.12)
    for (const f of [523, 659, 784, 1046]) tone(c, out, t, { freq: f, at: 0.36, dur: 1.2, gain: 0.08, type: 'triangle' })
  },
  lose: (c, out, t) => arpeggio(c, out, t, [440, 392, 349, 294], 0.18, { dur: 0.5, gain: 0.12 }),
  draw: (c, out, t) => {
    tone(c, out, t, { freq: 523, dur: 0.4, gain: 0.12, type: 'triangle' })
    tone(c, out, t, { freq: 392, at: 0.25, dur: 0.6, gain: 0.12, type: 'triangle' })
  },
}

/** 同时出现的几个音效稍微错开，不挤成一团 */
const STAGGER = 0.09

export function playSounds(names: SoundName[]) {
  if (!enabled || !userActed || !names.length) return
  const a = audio()
  if (!a || a.c.state !== 'running') return
  const t = a.c.currentTime + 0.01
  names.forEach((n, i) => SOUNDS[n](a.c, a.out, t + i * STAGGER))
}

export const playSound = (name: SoundName) => playSounds([name])
