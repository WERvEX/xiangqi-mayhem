import { useState } from 'react'
import { complete, errorText, listModels, thinkingOffRejected, type Reasoning } from '../llm/client'
import { extractJson } from '../llm/parse'
import {
  newProfileId,
  PRESETS,
  profileLabel,
  removeProfile,
  saveProfile,
  useProfiles,
  type StoredProfile,
} from '../llm/settings'

const REASONING_NAMES: Record<Reasoning, string> = {
  default: '默认（由服务商决定）',
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
}

const DEV_PROXY = import.meta.env.DEV ? `${location.origin}/__llm_proxy` : null

function blankProfile(): StoredProfile {
  const p = PRESETS[0]
  return {
    id: newProfileId(),
    name: p.name,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    apiKey: '',
    model: p.models[0] ?? '',
    reasoning: 'default',
  }
}

// ───────────── 配置列表 ─────────────

export function LlmSettingsPage({ onBack }: { onBack: () => void }) {
  const profiles = useProfiles()
  const [editing, setEditing] = useState<StoredProfile | null>(null)

  if (editing) {
    return (
      <div className="lobby">
        <ProfileEditor
          initial={editing}
          onDone={() => setEditing(null)}
          onDelete={profiles.some((p) => p.id === editing.id) ? () => removeProfile(editing.id) : undefined}
        />
      </div>
    )
  }

  return (
    <div className="lobby">
      <h2>设置</h2>
      <section className="lobby-card">
        <h3>大模型 API</h3>
        <p className="muted left">
          用于「挑战 AI」里的大模型对手和「模型斗蛐蛐」。密钥只保存在这台设备的浏览器里，请求由你的浏览器直接发给模型服务商，不经过我们的任何服务器。
        </p>
        {profiles.length === 0 && <p className="muted">还没有配置模型</p>}
        <ul className="profile-list">
          {profiles.map((p) => (
            <li key={p.id}>
              <span className="profile-name">
                {profileLabel(p)}
                {p.sessionOnly && <span className="tag">仅本次</span>}
              </span>
              <button type="button" onClick={() => setEditing(p)}>
                编辑
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="primary" onClick={() => setEditing(blankProfile())}>
          ＋ 添加模型
        </button>
      </section>
      <section className="lobby-card">
        <h3>安全提示</h3>
        <ul className="muted left tips">
          <li>能使用这台设备和这个浏览器的人都能读到你保存的密钥，公用电脑请勾选「只在本次打开时有效」</li>
          <li>建议在服务商后台单独创建一个设有额度上限的密钥</li>
          <li>密钥不会出现在回放和分享链接里</li>
        </ul>
      </section>
      <button type="button" onClick={onBack}>
        返回
      </button>
    </div>
  )
}

// ───────────── 编辑一个配置 ─────────────

type TestState = { status: 'idle' } | { status: 'running' } | { status: 'ok'; text: string } | { status: 'fail'; text: string }

export function ProfileEditor({
  initial,
  onDone,
  onDelete,
}: {
  initial: StoredProfile
  /** saved：是否保存了 */
  onDone: (saved: StoredProfile | null) => void
  onDelete?: () => void
}) {
  const [p, setP] = useState(initial)
  const [presetId, setPresetId] = useState(() => PRESETS.find((x) => x.baseUrl === initial.baseUrl)?.id ?? 'custom')
  const [showKey, setShowKey] = useState(false)
  /** 从服务商获取到的模型列表 */
  const [models, setModels] = useState<string[]>([])
  const [modelsMsg, setModelsMsg] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const preset = PRESETS.find((x) => x.id === presetId)
  const set = (patch: Partial<StoredProfile>) => {
    setP((cur) => ({ ...cur, ...patch }))
    setTest({ status: 'idle' })
  }

  const applyPreset = (id: string) => {
    setPresetId(id)
    const pr = PRESETS.find((x) => x.id === id)
    if (!pr) return
    setModels([])
    setModelsMsg(null)
    set({
      name: pr.name,
      protocol: pr.protocol,
      baseUrl: pr.baseUrl,
      model: pr.models[0] ?? '',
      reasoning: pr.id === 'ark-plan' ? 'off' : 'default',
    })
  }

  const fetchModels = async () => {
    setFetching(true)
    setModelsMsg(null)
    try {
      const list = await listModels(p)
      setModels(list)
      setFilter('')
      setPickerOpen(true)
    } catch (e) {
      setModelsMsg(`获取失败（${errorText(e)}），请手动填写模型名`)
    } finally {
      setFetching(false)
    }
  }
  const keyword = filter.trim().toLowerCase()
  const shownModels = keyword ? models.filter((m) => m.toLowerCase().includes(keyword)) : models
  const suggestions = (preset?.models ?? []).filter((m) => m !== p.model)

  const runTest = async () => {
    setTest({ status: 'running' })
    const t0 = performance.now()
    try {
      const res = await complete(p, {
        system: '你是一个测试助手。',
        user: '这是一次连接测试。请只输出这个 JSON 对象，不要输出其他内容：{"move": 3}',
        maxTokens: 2048,
        json: true,
      })
      const sec = ((performance.now() - t0) / 1000).toFixed(1)
      const offNote = thinkingOffRejected(p) ? '。注意：这个服务商不接受关闭思考的参数，已自动忽略' : ''
      const thinkNote = res.reasoning.trim() ? `。模型思考了 ${res.reasoning.length} 字，嫌慢可以把思考强度设为「关闭」` : ''
      const json = extractJson(res.text)
      if (json?.move === 3 || json?.move === '3') setTest({ status: 'ok', text: `连接成功，${sec} 秒${offNote}${thinkNote}` })
      else if (res.truncated && !res.text.trim()) {
        setTest({ status: 'fail', text: `能连上，但模型思考太长、没给出答案（${sec} 秒）。建议把思考强度调低或关闭` })
      } else setTest({ status: 'ok', text: `能连上（${sec} 秒），但回复格式不太规范，对局中可能偶尔需要兜底：${res.text.slice(0, 60)}` })
    } catch (e) {
      setTest({ status: 'fail', text: errorText(e) })
    }
  }

  const complete_ = p.baseUrl.trim() && p.apiKey.trim() && p.model.trim()
  const reasoningOptions: Reasoning[] =
    p.protocol === 'anthropic' ? ['default', 'off', 'low', 'medium', 'high'] : ['default', 'off', 'low', 'medium', 'high']

  return (
    <section className="lobby-card profile-editor">
      <h3>{onDelete ? '编辑模型' : '添加模型'}</h3>

      <label>
        <span>服务商</span>
        <select value={presetId} onChange={(e) => applyPreset(e.target.value)}>
          {PRESETS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
          <option value="custom">自定义</option>
        </select>
      </label>
      {preset?.note && <p className="field-note">{preset.note}</p>}
      {preset?.needsProxy && !p.proxy && (
        <p className="field-note warn">
          这个服务商不允许网页直接调用，需要在「高级」里填写转发地址。
        </p>
      )}

      <label>
        <span>名称</span>
        <input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="随便起个名字" />
      </label>

      <div className="field">
        <span>接口格式</span>
        <div className="segmented">
          {(['anthropic', 'openai'] as const).map((proto) => (
            <button
              key={proto}
              type="button"
              className={p.protocol === proto ? 'on' : ''}
              onClick={() =>
                set({ protocol: proto })
              }
            >
              {proto === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}
            </button>
          ))}
        </div>
      </div>

      <label>
        <span>接口地址（Base URL）</span>
        <input
          value={p.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
          placeholder={p.protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'}
          spellCheck={false}
        />
      </label>

      <label>
        <span>API 密钥</span>
        <span className="row">
          <input
            type={showKey ? 'text' : 'password'}
            value={p.apiKey}
            onChange={(e) => set({ apiKey: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" onClick={() => setShowKey((v) => !v)}>
            {showKey ? '隐藏' : '显示'}
          </button>
        </span>
      </label>

      <div className="field">
        <span>模型</span>
        <span className="row">
          <input
            value={p.model}
            onChange={(e) => set({ model: e.target.value })}
            placeholder="模型名，如 deepseek-chat"
            spellCheck={false}
            aria-label="模型名"
          />
          {models.length > 0 && !pickerOpen ? (
            <button type="button" onClick={() => setPickerOpen(true)}>
              选择（{models.length}）
            </button>
          ) : (
            <button
              type="button"
              onClick={fetchModels}
              disabled={fetching || !p.baseUrl.trim() || !p.apiKey.trim()}
              title={!p.apiKey.trim() ? '先填写接口地址和密钥' : '从服务商获取可用的模型'}
            >
              {fetching ? '获取中…' : '获取列表'}
            </button>
          )}
        </span>
      </div>
      {pickerOpen && models.length > 0 && (
        <div className="model-picker">
          <div className="model-picker-head">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`搜索 ${models.length} 个模型`}
              spellCheck={false}
              aria-label="搜索模型"
            />
            <button type="button" onClick={() => setPickerOpen(false)}>
              收起
            </button>
          </div>
          <ul>
            {shownModels.map((m) => (
              <li key={m}>
                <button
                  type="button"
                  className={m === p.model ? 'on' : ''}
                  onClick={() => {
                    set({ model: m })
                    setPickerOpen(false)
                  }}
                >
                  {m}
                </button>
              </li>
            ))}
          </ul>
          {shownModels.length === 0 && <p className="muted">没有匹配的模型，也可以直接在上面的输入框里填写</p>}
        </div>
      )}
      {!pickerOpen && models.length === 0 && suggestions.length > 0 && (
        <div className="model-chips">
          <span className="muted">常用：</span>
          {suggestions.map((m) => (
            <button key={m} type="button" onClick={() => set({ model: m })}>
              {m}
            </button>
          ))}
        </div>
      )}
      {modelsMsg && <p className="field-note warn">{modelsMsg}</p>}

      <label>
        <span>思考强度</span>
        <select value={p.reasoning} onChange={(e) => set({ reasoning: e.target.value as Reasoning })}>
          {reasoningOptions.map((r) => (
            <option key={r} value={r}>
              {REASONING_NAMES[r]}
            </option>
          ))}
        </select>
      </label>
      <p className="field-note">
        思考越多下得越好，但每步也越慢（可能要几十秒），部分模型默认就会深度思考。追求节奏的话可以关闭思考，配合「战术检查」辅助，棋力不会差太多。
        OpenAI 兼容接口的「关闭」会按服务商自动选择参数；「低 / 中 / 高」对部分模型不起作用。
      </p>

      <details className="advanced">
        <summary>高级</summary>
        <label>
          <span>转发地址（可选）</span>
          <input
            value={p.proxy ?? ''}
            onChange={(e) => set({ proxy: e.target.value })}
            placeholder="http://127.0.0.1:8787"
            spellCheck={false}
          />
        </label>
        <p className="field-note">
          给不允许网页直接调用的服务商用。在电脑上运行 <code>npm run llm-proxy</code> 启动本地转发，然后填 http://127.0.0.1:8787 。
          {DEV_PROXY && (
            <button type="button" className="link" onClick={() => set({ proxy: DEV_PROXY })}>
              使用开发服务器转发
            </button>
          )}
        </p>
        <label>
          <span>额外参数（JSON，可选）</span>
          <textarea
            rows={2}
            value={p.extraBody ?? ''}
            onChange={(e) => set({ extraBody: e.target.value })}
            placeholder='{"enable_thinking": false}'
            spellCheck={false}
          />
        </label>
        <p className="field-note">会合并进每次请求的请求体，用于各家特有的开关。</p>
        <label>
          <span>单次请求超时（秒）</span>
          <input
            type="number"
            min={10}
            max={600}
            value={p.timeoutSec ?? 120}
            onChange={(e) => set({ timeoutSec: Number(e.target.value) || 120 })}
          />
        </label>
      </details>

      <label className="check">
        <input type="checkbox" checked={!!p.sessionOnly} onChange={(e) => set({ sessionOnly: e.target.checked })} />
        只在本次打开时有效（关闭页面后清除，适合公用电脑）
      </label>

      <button type="button" onClick={runTest} disabled={!complete_ || test.status === 'running'}>
        {test.status === 'running' ? '测试中…' : '测试连接'}
      </button>
      {test.status === 'ok' && <p className="field-note ok">✓ {test.text}</p>}
      {test.status === 'fail' && <p className="field-note warn">✗ {test.text}</p>}

      <div className="modal-actions">
        {onDelete && (
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (confirm(`删除「${profileLabel(p)}」？`)) {
                onDelete()
                onDone(null)
              }
            }}
          >
            删除
          </button>
        )}
        <button type="button" onClick={() => onDone(null)}>
          取消
        </button>
        <button
          type="button"
          className="primary"
          disabled={!complete_}
          onClick={() => {
            saveProfile(p)
            onDone(p)
          }}
        >
          保存
        </button>
      </div>
    </section>
  )
}
