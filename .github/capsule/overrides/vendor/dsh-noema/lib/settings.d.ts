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
import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Memory configuration as resolved for the running plugin. */
export interface NoemaMemorySettings {
    /** Master switch. When false every tool fails fast with a clear message. */
    enabled: boolean;
    /** Launch command/path for the Noema MCP stdio server (whitespace-split). */
    command: string;
    /** Working directory for the server process (e.g. the noema repo for cargo). */
    workingDirectory: string;
    /** NOEMA_ROOT override; empty keeps Noema's default (~/.agent-memory). */
    noemaRoot: string;
    /** Spawn the server when the plugin mounts instead of on first use. */
    autoStart: boolean;
    /** Stop the server after this many idle milliseconds (0 = never). */
    idleTimeoutMs: number;
    /** Restart the server in the background when it crashes or exits. */
    keepAlive: boolean;
    /** Minimum interval between keep-alive health checks. */
    keepAliveIntervalMs: number;
    /** Per-tool-call deadline in milliseconds. */
    callTimeoutMs: number;
    /** Minimum delay between a crash/stop and the next auto-restart. */
    restartDelayMs: number;
    /** Default token budget applied to noema_recall when omitted. */
    recallBudgetTokens: number;
    /** noema_remember auto-accepts candidates into durable memory by default. */
    acceptByDefault: boolean;
    /** Include the memory-usage guidance section in the system prompt. */
    guidance: boolean;
    /** Master switch for the foreign-agent memory import feature. */
    importEnabled: boolean;
    /** Run an import pass automatically when the plugin mounts. */
    importOnStartup: boolean;
    /** Include the session workspace's AGENTS.md/CLAUDE.md/rules files. */
    importWorkspaceFiles: boolean;
    /** Per-file byte cap applied while reading foreign memory files. */
    importMaxBytes: number;
    /** Enabled importer ids (Codex, Claude Code, opencode, Cursor, Grok, WorkBuddy). */
    importSources: string[];
}
/** Schema defaults — the single source of truth the schema is built from. */
export declare const NOEMA_MEMORY_SETTINGS_DEFAULTS: NoemaMemorySettings;
/**
 * Settings namespace passed to `settings.register`. Since DSH 0.1.5 the
 * provider takes the plain literal and validates it itself (the exported
 * `settingsNamespace` brand helper was removed), so this stays a `const`
 * literal that older hosts accept as-is.
 */
export declare const NOEMA_MEMORY_SETTINGS_NS = "noema-memory";
/** Field map resolved by DSH 0.2.0: stable references read fresh with `.get()`. */
export type VolatileNoemaMemorySettings = {
    [K in keyof NoemaMemorySettings]: Volatile<NoemaMemorySettings[K]>;
};
/**
 * Entry-config face in either host shape: plain values on DSH 0.1.5,
 * volatile references on DSH 0.2.0.
 */
export type NoemaMemoryConfig = NoemaMemorySettings | VolatileNoemaMemorySettings;
/** One settings field whose parsed output is plain on 0.1.5 and a live reference on 0.2.0. */
type NoemaMemoryField<K extends keyof NoemaMemorySettings> = z<NoemaMemorySettings[K], NoemaMemorySettings[K] | Volatile<NoemaMemorySettings[K]>>;
/** Schemastery schema of the settings section. */
export declare const NOEMA_MEMORY_SETTINGS_SCHEMA: z<Schemastery.ObjectS<NoInfer<{
    enabled: NoemaMemoryField<"enabled">;
    command: NoemaMemoryField<"command">;
    workingDirectory: NoemaMemoryField<"workingDirectory">;
    noemaRoot: NoemaMemoryField<"noemaRoot">;
    autoStart: NoemaMemoryField<"autoStart">;
    idleTimeoutMs: NoemaMemoryField<"idleTimeoutMs">;
    keepAlive: NoemaMemoryField<"keepAlive">;
    keepAliveIntervalMs: NoemaMemoryField<"keepAliveIntervalMs">;
    callTimeoutMs: NoemaMemoryField<"callTimeoutMs">;
    restartDelayMs: NoemaMemoryField<"restartDelayMs">;
    recallBudgetTokens: NoemaMemoryField<"recallBudgetTokens">;
    acceptByDefault: NoemaMemoryField<"acceptByDefault">;
    guidance: NoemaMemoryField<"guidance">;
    importEnabled: NoemaMemoryField<"importEnabled">;
    importOnStartup: NoemaMemoryField<"importOnStartup">;
    importWorkspaceFiles: NoemaMemoryField<"importWorkspaceFiles">;
    importMaxBytes: NoemaMemoryField<"importMaxBytes">;
    importSources: NoemaMemoryField<"importSources">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: NoemaMemoryField<"enabled">;
    command: NoemaMemoryField<"command">;
    workingDirectory: NoemaMemoryField<"workingDirectory">;
    noemaRoot: NoemaMemoryField<"noemaRoot">;
    autoStart: NoemaMemoryField<"autoStart">;
    idleTimeoutMs: NoemaMemoryField<"idleTimeoutMs">;
    keepAlive: NoemaMemoryField<"keepAlive">;
    keepAliveIntervalMs: NoemaMemoryField<"keepAliveIntervalMs">;
    callTimeoutMs: NoemaMemoryField<"callTimeoutMs">;
    restartDelayMs: NoemaMemoryField<"restartDelayMs">;
    recallBudgetTokens: NoemaMemoryField<"recallBudgetTokens">;
    acceptByDefault: NoemaMemoryField<"acceptByDefault">;
    guidance: NoemaMemoryField<"guidance">;
    importEnabled: NoemaMemoryField<"importEnabled">;
    importOnStartup: NoemaMemoryField<"importOnStartup">;
    importWorkspaceFiles: NoemaMemoryField<"importWorkspaceFiles">;
    importMaxBytes: NoemaMemoryField<"importMaxBytes">;
    importSources: NoemaMemoryField<"importSources">;
}>>, "plain">;
/** Entry-config face accepted by the cordis loader for this plugin. */
export declare const Config: z<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: NoemaMemoryField<"enabled">;
    command: NoemaMemoryField<"command">;
    workingDirectory: NoemaMemoryField<"workingDirectory">;
    noemaRoot: NoemaMemoryField<"noemaRoot">;
    autoStart: NoemaMemoryField<"autoStart">;
    idleTimeoutMs: NoemaMemoryField<"idleTimeoutMs">;
    keepAlive: NoemaMemoryField<"keepAlive">;
    keepAliveIntervalMs: NoemaMemoryField<"keepAliveIntervalMs">;
    callTimeoutMs: NoemaMemoryField<"callTimeoutMs">;
    restartDelayMs: NoemaMemoryField<"restartDelayMs">;
    recallBudgetTokens: NoemaMemoryField<"recallBudgetTokens">;
    acceptByDefault: NoemaMemoryField<"acceptByDefault">;
    guidance: NoemaMemoryField<"guidance">;
    importEnabled: NoemaMemoryField<"importEnabled">;
    importOnStartup: NoemaMemoryField<"importOnStartup">;
    importWorkspaceFiles: NoemaMemoryField<"importWorkspaceFiles">;
    importMaxBytes: NoemaMemoryField<"importMaxBytes">;
    importSources: NoemaMemoryField<"importSources">;
}>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: NoemaMemoryField<"enabled">;
    command: NoemaMemoryField<"command">;
    workingDirectory: NoemaMemoryField<"workingDirectory">;
    noemaRoot: NoemaMemoryField<"noemaRoot">;
    autoStart: NoemaMemoryField<"autoStart">;
    idleTimeoutMs: NoemaMemoryField<"idleTimeoutMs">;
    keepAlive: NoemaMemoryField<"keepAlive">;
    keepAliveIntervalMs: NoemaMemoryField<"keepAliveIntervalMs">;
    callTimeoutMs: NoemaMemoryField<"callTimeoutMs">;
    restartDelayMs: NoemaMemoryField<"restartDelayMs">;
    recallBudgetTokens: NoemaMemoryField<"recallBudgetTokens">;
    acceptByDefault: NoemaMemoryField<"acceptByDefault">;
    guidance: NoemaMemoryField<"guidance">;
    importEnabled: NoemaMemoryField<"importEnabled">;
    importOnStartup: NoemaMemoryField<"importOnStartup">;
    importWorkspaceFiles: NoemaMemoryField<"importWorkspaceFiles">;
    importMaxBytes: NoemaMemoryField<"importMaxBytes">;
    importSources: NoemaMemoryField<"importSources">;
}>>>, "volatile">;
/**
 * Cross-field validation the schema cannot express: numeric ranges and the
 * recall budget floor. Throwing here refuses the write before anything is
 * persisted (dsh-settings contract). Accepts a partial section because the
 * settings register hook validates resolved candidates of any shape.
 */
export declare function validateNoemaMemorySettings(value: Partial<NoemaMemorySettings>): void;
/**
 * Resolve an entry config against the schema defaults, reading volatile
 * references fresh so 0.2.0 hosts always observe the current live values.
 */
export declare function resolveNoemaMemorySettings(entry: Partial<NoemaMemoryConfig> | undefined): NoemaMemorySettings;
/** Scope returned by the DSH 0.1.5 settings provider's `register()`. */
export interface NoemaSettingsScope {
    get(): NoemaMemorySettings;
    update(patch: Partial<NoemaMemorySettings>): Promise<void>;
    watch(callback: () => void): () => void;
}
/** DSH 0.1.5 settings provider face used by the legacy branch. */
export interface LegacySettingsProvider {
    register(namespace: string, schema: unknown, options?: {
        base?: Partial<NoemaMemoryConfig>;
        validate?: (value: Partial<NoemaMemorySettings>) => void;
    }): NoemaSettingsScope;
}
/** DSH 0.2.0 SettingsForms face used by the new branch. */
export interface HostSettingsForms {
    update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
    configure(presentation: {
        auto?: boolean;
    }): () => void;
}
/** The loader-owned volatile-update event (DSH 0.2.0), declared locally so the
 * plugin compiles without the `@deepseek-ai/cordis-plugin-loader` types. */
declare module '@deepseek-ai/cordis' {
    interface Events {
        'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
    }
}
/**
 * Install the optional-settings wiring. `entry` is the plugin's composition
 * entry config, used as the `base` layer on 0.1.5 and read as live volatile
 * refs on 0.2.0; `setSource` points the caller's resolution thunk at the
 * live resolved value and `onChange` fires when it moves.
 */
export declare function installNoemaMemorySettings(ctx: Context, entry: Partial<NoemaMemoryConfig>, hooks: {
    setSource: (source: () => NoemaMemorySettings) => void;
    setWriter: (writer: ((patch: Partial<NoemaMemorySettings>) => Promise<void>) | undefined) => void;
    onChange: () => void;
}): void;
export { IMPORTER_IDS } from './importers.js';
