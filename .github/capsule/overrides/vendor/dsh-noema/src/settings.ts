/**
 * Memory configuration namespace: schema, defaults, validation, and the
 * optional-settings wiring shared by the plugin root.
 *
 * While a settings service exists the user layer is read and written live;
 * without one the composition entry stays in force and remains read-only.
 *
 * Two settings-service generations are supported through runtime feature
 * detection: DSH 0.1.5's register/scope service, and DSH 0.2.0's
 * SettingsForms (`update` + `configure`) over the plugin's own volatile
 * Config fields.
 * @module @zseven-w/dsh-noema/settings
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { IMPORTER_IDS } from './importers.js'
import { NOEMA_MEMORY_SETTINGS_NAMESPACE } from './names.js'

/** Memory configuration as resolved for the running plugin. */
export interface NoemaMemorySettings {
  /** Master switch. When false every tool fails fast with a clear message. */
  enabled: boolean
  /** Launch command/path for the Noema MCP stdio server (whitespace-split). */
  command: string
  /** Working directory for the server process (e.g. the noema repo for cargo). */
  workingDirectory: string
  /** NOEMA_ROOT override; empty keeps Noema's default (~/.agent-memory). */
  noemaRoot: string
  /** Spawn the server when the plugin mounts instead of on first use. */
  autoStart: boolean
  /** Stop the server after this many idle milliseconds (0 = never). */
  idleTimeoutMs: number
  /** Restart the server in the background when it crashes or exits. */
  keepAlive: boolean
  /** Minimum interval between keep-alive health checks. */
  keepAliveIntervalMs: number
  /** Per-tool-call deadline in milliseconds. */
  callTimeoutMs: number
  /** Minimum delay between a crash/stop and the next auto-restart. */
  restartDelayMs: number
  /** Default token budget applied to noema_recall when omitted. */
  recallBudgetTokens: number
  /** noema_remember auto-accepts candidates into durable memory by default. */
  acceptByDefault: boolean
  /** Include the memory-usage guidance section in the system prompt. */
  guidance: boolean
  /** Master switch for the foreign-agent memory import feature. */
  importEnabled: boolean
  /** Run an import pass automatically when the plugin mounts. */
  importOnStartup: boolean
  /** Include the session workspace's AGENTS.md/CLAUDE.md/rules files. */
  importWorkspaceFiles: boolean
  /** Per-file byte cap applied while reading foreign memory files. */
  importMaxBytes: number
  /** Enabled importer ids (Codex, Claude Code, opencode, Cursor, Grok, WorkBuddy). */
  importSources: string[]
}

/** Schema defaults — the single source of truth the schema is built from. */
export const NOEMA_MEMORY_SETTINGS_DEFAULTS: NoemaMemorySettings = {
  enabled: false,
  command: 'bundled',
  workingDirectory: '',
  noemaRoot: '',
  autoStart: false,
  idleTimeoutMs: 0,
  // ⚠️ 手机版决策（2026-10-15）：`enabled`/`autoStart` 保持 false —— 记忆默认不自动
  //    开启，需用户显式同意（与 DSH 的「记忆隔离」措辞一致：不自动跨项目/窗口召回）。
  //    但 `keepAlive` 改为 **true**：一旦用户开启过记忆，崩溃/被 stop 后应能自动拉起，
  //    否则表现为用户报障的「记忆服务器每次启动都是停止的，只能手动重启」。
  //    注意：本文件的 keepAlive 判据已同步修复（原判据在 client===undefined 时永不重试）。
  keepAlive: true,
  keepAliveIntervalMs: 5_000,
  callTimeoutMs: 30_000,
  restartDelayMs: 1_000,
  recallBudgetTokens: 1_200,
  acceptByDefault: false,
  guidance: false,
  importEnabled: false,
  importOnStartup: false,
  importWorkspaceFiles: false,
  importMaxBytes: 65_536,
  importSources: ['codex', 'claude-code', 'opencode', 'cursor', 'grok', 'workbuddy', 'antigravity', 'trae', 'qoder', 'hermes'],
}

/**
 * Settings namespace passed to `settings.register`. Since DSH 0.1.5 the
 * provider takes the plain literal and validates it itself (the exported
 * `settingsNamespace` brand helper was removed), so this stays a `const`
 * literal that older hosts accept as-is.
 */
export const NOEMA_MEMORY_SETTINGS_NS = NOEMA_MEMORY_SETTINGS_NAMESPACE

/** Field map resolved by DSH 0.2.0: stable references read fresh with `.get()`. */
export type VolatileNoemaMemorySettings = {
  [K in keyof NoemaMemorySettings]: Volatile<NoemaMemorySettings[K]>
}

/**
 * Entry-config face in either host shape: plain values on DSH 0.1.5,
 * volatile references on DSH 0.2.0.
 */
export type NoemaMemoryConfig = NoemaMemorySettings | VolatileNoemaMemorySettings

/**
 * Mark one schema field volatile when the running schemastery supports it.
 * DSH 0.1.5's schemastery has no `.volatile` method and calling it would
 * crash boot, so the marker is applied only when the method exists.
 */
function liveField(schema: z): z {
  const node = schema as z & { volatile?: () => z }
  return typeof node.volatile === 'function' ? node.volatile() : schema
}

/** One settings field whose parsed output is plain on 0.1.5 and a live reference on 0.2.0. */
type NoemaMemoryField<K extends keyof NoemaMemorySettings> =
  z<NoemaMemorySettings[K], NoemaMemorySettings[K] | Volatile<NoemaMemorySettings[K]>>

/** Field map of the settings schema, declared so the exported schema keeps precise types. */
const NOEMA_MEMORY_SETTINGS_FIELDS: { [K in keyof NoemaMemorySettings]: NoemaMemoryField<K> } = {
  enabled: liveField(z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.enabled)),
  command: liveField(z.string().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.command)),
  workingDirectory: liveField(z.string().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.workingDirectory)),
  noemaRoot: liveField(z.string().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.noemaRoot)),
  autoStart: liveField(z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.autoStart)),
  idleTimeoutMs: liveField(z.number().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.idleTimeoutMs)),
  keepAlive: liveField(z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.keepAlive)),
  keepAliveIntervalMs: liveField(z.number().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.keepAliveIntervalMs)),
  callTimeoutMs: liveField(z.number().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.callTimeoutMs)),
  restartDelayMs: liveField(z.number().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.restartDelayMs)),
  recallBudgetTokens: liveField(z.number().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.recallBudgetTokens)),
  acceptByDefault: liveField(z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.acceptByDefault)),
  guidance: liveField(z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.guidance)),
  importEnabled: liveField(z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.importEnabled)),
  importOnStartup: liveField(z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.importOnStartup)),
  importWorkspaceFiles: liveField(z.boolean().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.importWorkspaceFiles)),
  importMaxBytes: liveField(z.number().default(NOEMA_MEMORY_SETTINGS_DEFAULTS.importMaxBytes)),
  importSources: liveField(z.array(z.string()).default(NOEMA_MEMORY_SETTINGS_DEFAULTS.importSources)),
}

/** Schemastery schema of the settings section. */
export const NOEMA_MEMORY_SETTINGS_SCHEMA = z.object(NOEMA_MEMORY_SETTINGS_FIELDS)

/**
 * Entry-config face accepted by the cordis loader for this plugin.
 * ⚠️ 本地修复（手机版）：原实现在此对根 schema 再调一次 .volatile()，而各字段已由 liveField()
 *    标记为 volatile；schemastery 3.18.5 会以 "volatile fields require a fixed object path
 *    without an enclosing volatile field" 拒绝这种嵌套，dsh-noema 条目因此整体不激活，
 *    设置页只剩「当前浏览器会话中记忆设置不可用」。字段级 volatile 才是 DSH 0.2.x 的契约，
 *    与上游 rc.6/main 的 `export const Config = NOEMA_MEMORY_SETTINGS_SCHEMA` 一致。
 */
export const Config = NOEMA_MEMORY_SETTINGS_SCHEMA

type NumericSettingField = 'idleTimeoutMs' | 'callTimeoutMs' | 'restartDelayMs'

const NON_NEGATIVE_FIELDS: ReadonlyArray<readonly [NumericSettingField, string]> = [
  ['idleTimeoutMs', 'idle timeout'],
  ['callTimeoutMs', 'call timeout'],
  ['restartDelayMs', 'restart delay'],
] as const

/**
 * Cross-field validation the schema cannot express: numeric ranges and the
 * recall budget floor. Throwing here refuses the write before anything is
 * persisted (dsh-settings contract). Accepts a partial section because the
 * settings register hook validates resolved candidates of any shape.
 */
export function validateNoemaMemorySettings(value: Partial<NoemaMemorySettings>): void {
  for (const [field, label] of NON_NEGATIVE_FIELDS) {
    const current = value[field]
    if (current !== undefined && (!Number.isFinite(current) || current < 0)) {
      throw new Error('Noema memory: ' + label + ' (' + String(field) + ') must be a non-negative number of milliseconds')
    }
  }
  if (value.recallBudgetTokens !== undefined && (!Number.isInteger(value.recallBudgetTokens) || value.recallBudgetTokens < 1)) {
    throw new Error('Noema memory: recall budget must be a positive integer number of tokens')
  }
  if (value.command !== undefined && value.command.trim() === '') {
    throw new Error('Noema memory: server command must not be empty')
  }
  if (value.keepAliveIntervalMs !== undefined && (!Number.isInteger(value.keepAliveIntervalMs) || value.keepAliveIntervalMs < 1000)) {
    throw new Error('Noema memory: keep-alive interval must be at least 1000 milliseconds')
  }
  if (value.importMaxBytes !== undefined && (!Number.isInteger(value.importMaxBytes) || value.importMaxBytes < 1024)) {
    throw new Error('Noema memory: import file cap must be at least 1024 bytes')
  }
  if (value.importSources !== undefined) {
    const known = new Set(IMPORTER_IDS)
    for (const source of value.importSources) {
      if (!known.has(source)) {
        throw new Error('Noema memory: unknown import source ' + JSON.stringify(source))
      }
    }
  }
}

/** Read one entry value in either shape: plain on 0.1.5, a `.get()` reference on 0.2.0. */
function readNoemaConfigValue(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): unknown }).get()
  }
  return value
}

/**
 * Resolve an entry config against the schema defaults, reading volatile
 * references fresh so 0.2.0 hosts always observe the current live values.
 */
export function resolveNoemaMemorySettings(entry: Partial<NoemaMemoryConfig> | undefined): NoemaMemorySettings {
  const resolved: NoemaMemorySettings = { ...NOEMA_MEMORY_SETTINGS_DEFAULTS }
  const target = resolved as Record<keyof NoemaMemorySettings, NoemaMemorySettings[keyof NoemaMemorySettings]>
  for (const [key, fallback] of Object.entries(NOEMA_MEMORY_SETTINGS_DEFAULTS) as ReadonlyArray<readonly [keyof NoemaMemorySettings, NoemaMemorySettings[keyof NoemaMemorySettings]]>) {
    const value = readNoemaConfigValue((entry ?? {})[key])
    target[key] = (Array.isArray(value) ? [...value] : value === undefined ? fallback : value) as NoemaMemorySettings[keyof NoemaMemorySettings]
  }
  return resolved
}

/** Scope returned by the DSH 0.1.5 settings provider's `register()`. */
export interface NoemaSettingsScope {
  get(): NoemaMemorySettings
  update(patch: Partial<NoemaMemorySettings>): Promise<void>
  watch(callback: () => void): () => void
}

/** DSH 0.1.5 settings provider face used by the legacy branch. */
export interface LegacySettingsProvider {
  register(namespace: string, schema: unknown, options?: {
    base?: Partial<NoemaMemoryConfig>
    validate?: (value: Partial<NoemaMemorySettings>) => void
  }): NoemaSettingsScope
}

/** DSH 0.2.0 SettingsForms face used by the new branch. */
export interface HostSettingsForms {
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  configure(presentation: { auto?: boolean }): () => void
}

/** Settings wiring hooks owned by the plugin root. */
interface NoemaSettingsHooks {
  setSource: (source: () => NoemaMemorySettings) => void
  setWriter: (writer: ((patch: Partial<NoemaMemorySettings>) => Promise<void>) | undefined) => void
  onChange: () => void
}

interface LegacySettingsContext extends Context {
  settings: LegacySettingsProvider
}

/** The loader-owned volatile-update event (DSH 0.2.0), declared locally so the
 * plugin compiles without the `@deepseek-ai/cordis-plugin-loader` types. */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

interface HostSettingsContext extends Context {
  settings: HostSettingsForms
}

/**
 * Install the DSH 0.1.5 settings wiring, unchanged from the legacy behavior:
 * register the namespace and read/write/watch the returned scope.
 */
function installLegacyNoemaMemorySettings(
  settingsCtx: LegacySettingsContext,
  entry: Partial<NoemaMemoryConfig>,
  hooks: NoemaSettingsHooks,
  fallback: NoemaMemorySettings,
): void {
  try {
    const scope = settingsCtx.settings.register(NOEMA_MEMORY_SETTINGS_NS, NOEMA_MEMORY_SETTINGS_SCHEMA, {
      base: entry,
      validate: validateNoemaMemorySettings,
    })
    hooks.setSource(() => scope.get())
    hooks.setWriter(patch => scope.update(patch))
    hooks.onChange()
    const unwatch = scope.watch(() => hooks.onChange())
    settingsCtx.effect(() => () => {
      unwatch()
      hooks.setWriter(undefined)
      hooks.setSource(() => fallback)
    })
  } catch (error) {
    settingsCtx.logger.warn('dsh-noema: settings registration failed: ' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * Install the DSH 0.2.0 settings wiring: live values come from the volatile
 * Config refs, writes go through `settings.update` into the profile's
 * cordis.patch.yml, changes arrive via `loader/volatile-update`, and the
 * host's auto-generated page is disabled because noema ships its own panel.
 */
function installHostNoemaMemorySettings(
  settingsCtx: HostSettingsContext,
  entryId: string | undefined,
  entry: Partial<NoemaMemoryConfig>,
  hooks: NoemaSettingsHooks,
  fallback: () => NoemaMemorySettings,
): void {
  try {
    const disposePresentation = settingsCtx.settings.configure({ auto: false })
    hooks.setSource(() => resolveNoemaMemorySettings(entry))
    if (entryId !== undefined) {
      hooks.setWriter(async patch => {
        const candidate = { ...resolveNoemaMemorySettings(entry), ...patch }
        validateNoemaMemorySettings(candidate)
        await settingsCtx.settings.update(entryId, patch)
      })
    }
    const stop = settingsCtx.on('loader/volatile-update', () => hooks.onChange())
    settingsCtx.effect(() => () => {
      stop()
      disposePresentation()
      hooks.setWriter(undefined)
      hooks.setSource(fallback)
    })
  } catch (error) {
    settingsCtx.logger.warn('dsh-noema: settings wiring failed: ' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * Install the optional-settings wiring. `entry` is the plugin's composition
 * entry config, used as the `base` layer on 0.1.5 and read as live volatile
 * refs on 0.2.0; `setSource` points the caller's resolution thunk at the
 * live resolved value and `onChange` fires when it moves.
 */
export function installNoemaMemorySettings(
  ctx: Context,
  entry: Partial<NoemaMemoryConfig>,
  hooks: {
    setSource: (source: () => NoemaMemorySettings) => void
    setWriter: (writer: ((patch: Partial<NoemaMemorySettings>) => Promise<void>) | undefined) => void
    onChange: () => void
  },
): void {
  // Read fresh on every call: on 0.2.0 the entry holds volatile references
  // that move even when no settings service is mounted.
  const fallback = (): NoemaMemorySettings => resolveNoemaMemorySettings(entry)
  // The profile entry belongs to the plugin's own fiber, not to the child
  // fiber that `ctx.inject` creates for the settings callback.
  const entryId = (ctx.fiber as { entry?: { options?: { id?: string } } } | undefined)?.entry?.options?.id
  hooks.setSource(fallback)
  hooks.setWriter(undefined)
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = (settingsCtx as Context & { settings: unknown }).settings
    if (typeof (settings as LegacySettingsProvider).register === 'function') {
      installLegacyNoemaMemorySettings(settingsCtx as LegacySettingsContext, entry, hooks, fallback())
    } else {
      installHostNoemaMemorySettings(settingsCtx as HostSettingsContext, entryId, entry, hooks, fallback)
    }
  })
}

export { IMPORTER_IDS } from './importers.js'
