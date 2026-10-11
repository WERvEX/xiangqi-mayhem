import { useSyncExternalStore } from 'react'
import type { LlmProfile, Protocol } from './client'

/**
 * 大模型配置的保存：只存在本机浏览器里，不会上传。
 * 默认存 localStorage；勾选「只在本次打开时有效」的配置存 sessionStorage，关闭标签页即清除。
 */

export interface StoredProfile extends LlmProfile {
  sessionOnly?: boolean
}

const KEY = 'xqm-llm-profiles'

function read(storage: Storage): StoredProfile[] {
  try {
    const list = JSON.parse(storage.getItem(KEY) ?? '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

let cache: StoredProfile[] | null = null
const listeners = new Set<() => void>()

function load(): StoredProfile[] {
  cache ??= [...read(localStorage), ...read(sessionStorage).map((p) => ({ ...p, sessionOnly: true }))]
  return cache
}

function persist(list: StoredProfile[]) {
  localStorage.setItem(KEY, JSON.stringify(list.filter((p) => !p.sessionOnly)))
  sessionStorage.setItem(KEY, JSON.stringify(list.filter((p) => p.sessionOnly)))
  cache = list
  for (const l of listeners) l()
}

export function saveProfile(p: StoredProfile) {
  const list = load()
  const i = list.findIndex((q) => q.id === p.id)
  persist(i >= 0 ? list.map((q) => (q.id === p.id ? p : q)) : [...list, p])
}

export function removeProfile(id: string) {
  persist(load().filter((p) => p.id !== id))
}

export function useProfiles(): StoredProfile[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    load,
  )
}

export const newProfileId = () => Math.random().toString(36).slice(2, 10)

/** 配置的简短说明，如"DeepSeek · deepseek-chat" */
export const profileLabel = (p: LlmProfile) => `${p.name || '未命名'} · ${p.model || '未填模型'}`

// ───────────── 服务商预设 ─────────────

export interface Preset {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  /** 推荐的模型名（能自动获取列表的服务商也会列出全部） */
  models: string[]
  /** 不支持浏览器直连，需要填写转发地址 */
  needsProxy?: boolean
  note?: string
}

export const PRESETS: Preset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic（Claude）',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: [],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [],
  },
  {
    id: 'qwen',
    name: '通义千问（阿里云百炼）',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [],
    note: '一个密钥可以用各家的模型，包括不支持浏览器直连的 Kimi 等',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [],
  },
  {
    id: 'ark',
    name: '火山方舟（豆包等）',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [],
    needsProxy: true,
  },
  {
    id: 'ark-plan',
    name: '火山方舟 Coding Plan',
    protocol: 'anthropic',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan',
    models: ['ark-code-latest'],
    needsProxy: true,
    note: '这个接口默认开启深度思考，每步要等几十秒，建议把思考强度设为「关闭」。OpenAI 兼容格式的地址是 https://ark.cn-beijing.volces.com/api/plan/v3',
  },
]
