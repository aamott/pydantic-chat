/**
 * API Keys settings: per-provider credential rows.
 *
 * Keys write through `PUT /api/settings/secrets/{provider}` (stored in the
 * chmod-600 secrets.json — never returned by the API) and Clear issues the
 * matching DELETE; both refresh the shared provider-status list because
 * sibling prefixes share credentials (openai/openai-chat, google/google-cloud).
 * Ollama takes no key — its row edits the base URL instead, and
 * openai-compatible combines a base URL with an optional key.
 *
 * Note: `openai-compatible` has no display-name field — the backend's
 * `SecretSetIn` schema forbids unknown keys (`extra="forbid"`), so only
 * `key`/`base_url` can be written today (the provider name defaults to
 * "custom" server-side).
 */
import { useState } from 'react'
import { CheckCircle2, KeyRound } from 'lucide-react'
import type { ProviderStatus } from '@pydantic-chat/shared'
import { useSettingsStore } from '../../../stores/settings'
import {
  Field,
  SectionHeading,
  chipClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '../components'

/** Display metadata per provider prefix, in the backend's registry order. */
const PROVIDER_INFO: Record<string, { name: string; note?: string }> = {
  anthropic: { name: 'Anthropic' },
  openai: {
    name: 'OpenAI — Responses API',
    note: 'Shares the OpenAI key with Chat Completions below.',
  },
  'openai-chat': {
    name: 'OpenAI — Chat Completions',
    note: 'Shares the OpenAI key with Responses above.',
  },
  google: {
    name: 'Google — Gemini',
    note: 'Shares the Google key with Vertex AI below.',
  },
  'google-cloud': {
    name: 'Google Cloud — Vertex AI',
    note: 'Shares the Google key with Gemini above; Application Default Credentials work too.',
  },
  ollama: { name: 'Ollama', note: 'Local server — no API key needed.' },
  'openai-compatible': {
    name: 'OpenAI-compatible',
    note: 'Any endpoint speaking the OpenAI chat API (e.g. LM Studio, vLLM).',
  },
}

/** Error.message or a generic fallback for row-level failures. */
function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function ApiKeysSection(): React.JSX.Element | null {
  const providers = useSettingsStore((s) => s.providers)
  if (!providers.length) return null

  return (
    <div className="space-y-5">
      <SectionHeading
        title="API Keys"
        description="Keys are stored locally in the app's data directory (owner-only file permissions), take effect on the next run, and are never sent anywhere but the matching provider. Environment variables still work — a saved key takes precedence over them."
      />
      {providers.map((provider) => (
        <ProviderField key={provider.provider} provider={provider} />
      ))}
    </div>
  )
}

/** Search-aware Field wrapper picking the right row control per provider. */
function ProviderField({
  provider,
}: Readonly<{
  provider: ProviderStatus
}>): React.JSX.Element {
  const info = PROVIDER_INFO[provider.provider] ?? { name: provider.provider }
  // URL-bearing providers get extra terms so "base url" finds their rows.
  const urlTerms =
    provider.provider === 'ollama' || provider.provider === 'openai-compatible'
      ? ' base url endpoint server'
      : ''
  return (
    <Field
      label={info.name}
      hint={info.note}
      keywords={`api key keys secret credential credentials ${provider.provider} ${info.name}${urlTerms}`}
    >
      {provider.provider === 'ollama' ? (
        <OllamaRow provider={provider} />
      ) : provider.provider === 'openai-compatible' ? (
        <CompatibleRow provider={provider} />
      ) : (
        <KeyRow provider={provider} />
      )}
    </Field>
  )
}

/** file/env/not-set badge driven by the ProviderOut credential status. */
function StatusBadge({ provider }: Readonly<{ provider: ProviderStatus }>): React.JSX.Element {
  if (provider.has_key) {
    return (
      <span className={`inline-flex items-center gap-1 ${chipClass('success')}`}>
        <KeyRound className="h-3 w-3" />
        {provider.source === 'env' ? 'From environment' : 'Key saved'}
      </span>
    )
  }
  if (provider.provider === 'ollama' || provider.configured) {
    return (
      <span className={`inline-flex items-center gap-1 ${chipClass('accent')}`}>
        No key needed
      </span>
    )
  }
  return (
    <span className={`inline-flex items-center gap-1 ${chipClass('neutral')}`}>
      Not set
    </span>
  )
}

/** Standard key row: password input + Save/Clear, status badge, per-row error. */
function KeyRow({ provider }: Readonly<{ provider: ProviderStatus }>): React.JSX.Element {
  const saveSecret = useSettingsStore((s) => s.saveSecret)
  const clearSecret = useSettingsStore((s) => s.clearSecret)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const run = async (action: () => Promise<void>, done: string): Promise<void> => {
    setBusy(true)
    setError(null)
    setFlash(null)
    try {
      await action()
      setFlash(done)
    } catch (err) {
      setError(errorText(err, 'Something went wrong.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder={provider.has_key ? 'Replace saved key' : 'Paste API key'}
          spellCheck={false}
          autoComplete="off"
          className={`${inputClass} flex-1 font-mono`}
        />
        <button
          type="button"
          disabled={busy || !key.trim()}
          onClick={() =>
            void run(async () => {
              await saveSecret(provider.provider, { key: key.trim() })
              setKey('')
            }, 'Saved')
          }
          className={primaryButtonClass}
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy || !provider.has_key}
          onClick={() => void run(() => clearSecret(provider.provider), 'Cleared')}
          className={secondaryButtonClass}
        >
          Clear
        </button>
        <StatusBadge provider={provider} />
      </div>
      <RowFeedback error={error} flash={flash} />
    </div>
  )
}

/** Ollama: no key — just the server base URL via the secrets route. */
function OllamaRow({ provider }: Readonly<{ provider: ProviderStatus }>): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const saveSecret = useSettingsStore((s) => s.saveSecret)
  const [baseUrl, setBaseUrl] = useState(settings?.ollama_base_url ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setFlash(null)
    try {
      await saveSecret('ollama', { base_url: baseUrl.trim() })
      setFlash('Saved')
    } catch (err) {
      setError(errorText(err, 'Something went wrong.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="http://localhost:11434"
          spellCheck={false}
          className={`${inputClass} flex-1 font-mono`}
        />
        <button
          type="button"
          disabled={busy || !baseUrl.trim()}
          onClick={() => void save()}
          className={primaryButtonClass}
        >
          Save
        </button>
        <StatusBadge provider={provider} />
      </div>
      <RowFeedback error={error} flash={flash} />
    </div>
  )
}

/** OpenAI-compatible: base URL (required to use it) plus an optional key. */
function CompatibleRow({ provider }: Readonly<{ provider: ProviderStatus }>): React.JSX.Element {
  const saveSecret = useSettingsStore((s) => s.saveSecret)
  const clearSecret = useSettingsStore((s) => s.clearSecret)
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setFlash(null)
    try {
      const body: { base_url?: string; key?: string } = {}
      if (baseUrl.trim()) body.base_url = baseUrl.trim()
      if (key.trim()) body.key = key.trim()
      await saveSecret('openai-compatible', body)
      setKey('')
      setFlash('Saved')
    } catch (err) {
      setError(errorText(err, 'Something went wrong.'))
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setFlash(null)
    try {
      await clearSecret('openai-compatible')
      setBaseUrl('')
      setKey('')
      setFlash('Cleared')
    } catch (err) {
      setError(errorText(err, 'Something went wrong.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <input
        type="text"
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
        placeholder="Base URL, e.g. http://localhost:1234/v1"
        spellCheck={false}
        className={`${inputClass} font-mono`}
      />
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="API key (optional for local servers)"
          spellCheck={false}
          autoComplete="off"
          className={`${inputClass} flex-1 font-mono`}
        />
        <button
          type="button"
          disabled={busy || (!baseUrl.trim() && !key.trim())}
          onClick={() => void save()}
          className={primaryButtonClass}
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void clear()}
          className={secondaryButtonClass}
        >
          Clear
        </button>
        <StatusBadge provider={provider} />
      </div>
      <RowFeedback error={error} flash={flash} />
    </div>
  )
}

/** Per-row error line / transient success tick. */
function RowFeedback({
  error,
  flash,
}: Readonly<{
  error: string | null
  flash: string | null
}>): React.JSX.Element | null {
  if (error) {
    return <p className="text-xs text-danger">{error}</p>
  }
  if (flash) {
    return (
      <p className="flex items-center gap-1 text-xs text-success">
        <CheckCircle2 className="h-3 w-3" />
        {flash}
      </p>
    )
  }
  return null
}
