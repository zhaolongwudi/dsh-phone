import z from '@deepseek-ai/schemastery';
import { IMPORTER_IDS } from './importers.js';
import { NOEMA_MEMORY_SETTINGS_NAMESPACE } from './names.js';
/** Schema defaults — the single source of truth the schema is built from. */
export const NOEMA_MEMORY_SETTINGS_DEFAULTS = {
    enabled: false,
    command: 'bundled',
    workingDirectory: '',
    noemaRoot: '',
    autoStart: false,
    idleTimeoutMs: 0,
    keepAlive: false,
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
};
/**
 * Settings namespace passed to `settings.register`. Since DSH 0.1.5 the
 * provider takes the plain literal and validates it itself (the exported
 * `settingsNamespace` brand helper was removed), so this stays a `const`
 * literal that older hosts accept as-is.
 */
export const NOEMA_MEMORY_SETTINGS_NS = NOEMA_MEMORY_SETTINGS_NAMESPACE;
/**
 * Mark one schema field volatile when the running schemastery supports it.
 * DSH 0.1.5's schemastery has no `.volatile` method and calling it would
 * crash boot, so the marker is applied only when the method exists.
 */
function liveField(schema) {
    const node = schema;
    return typeof node.volatile === 'function' ? node.volatile() : schema;
}
/** Field map of the settings schema, declared so the exported schema keeps precise types. */
const NOEMA_MEMORY_SETTINGS_FIELDS = {
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
};
/** Schemastery schema of the settings section. */
export const NOEMA_MEMORY_SETTINGS_SCHEMA = z.object(NOEMA_MEMORY_SETTINGS_FIELDS);
/**
 * Entry-config face accepted by the cordis loader for this plugin.
 * ⚠️ 本地修复（手机版）：原实现在此对根 schema 再调一次 .volatile()，而各字段已由 liveField()
 *    标记为 volatile；schemastery 3.18.5 会以 "volatile fields require a fixed object path
 *    without an enclosing volatile field" 拒绝这种嵌套，dsh-noema 条目因此整体不激活，
 *    设置页只剩「当前浏览器会话中记忆设置不可用」。字段级 volatile 才是 DSH 0.2.x 的契约，
 *    与上游 rc.6/main 的 `export const Config = NOEMA_MEMORY_SETTINGS_SCHEMA` 一致。
 */
export const Config = NOEMA_MEMORY_SETTINGS_SCHEMA;
const NON_NEGATIVE_FIELDS = [
    ['idleTimeoutMs', 'idle timeout'],
    ['callTimeoutMs', 'call timeout'],
    ['restartDelayMs', 'restart delay'],
];
/**
 * Cross-field validation the schema cannot express: numeric ranges and the
 * recall budget floor. Throwing here refuses the write before anything is
 * persisted (dsh-settings contract). Accepts a partial section because the
 * settings register hook validates resolved candidates of any shape.
 */
export function validateNoemaMemorySettings(value) {
    for (const [field, label] of NON_NEGATIVE_FIELDS) {
        const current = value[field];
        if (current !== undefined && (!Number.isFinite(current) || current < 0)) {
            throw new Error('Noema memory: ' + label + ' (' + String(field) + ') must be a non-negative number of milliseconds');
        }
    }
    if (value.recallBudgetTokens !== undefined && (!Number.isInteger(value.recallBudgetTokens) || value.recallBudgetTokens < 1)) {
        throw new Error('Noema memory: recall budget must be a positive integer number of tokens');
    }
    if (value.command !== undefined && value.command.trim() === '') {
        throw new Error('Noema memory: server command must not be empty');
    }
    if (value.keepAliveIntervalMs !== undefined && (!Number.isInteger(value.keepAliveIntervalMs) || value.keepAliveIntervalMs < 1000)) {
        throw new Error('Noema memory: keep-alive interval must be at least 1000 milliseconds');
    }
    if (value.importMaxBytes !== undefined && (!Number.isInteger(value.importMaxBytes) || value.importMaxBytes < 1024)) {
        throw new Error('Noema memory: import file cap must be at least 1024 bytes');
    }
    if (value.importSources !== undefined) {
        const known = new Set(IMPORTER_IDS);
        for (const source of value.importSources) {
            if (!known.has(source)) {
                throw new Error('Noema memory: unknown import source ' + JSON.stringify(source));
            }
        }
    }
}
/** Read one entry value in either shape: plain on 0.1.5, a `.get()` reference on 0.2.0. */
function readNoemaConfigValue(value) {
    if (typeof value === 'object' && value !== null && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
/**
 * Resolve an entry config against the schema defaults, reading volatile
 * references fresh so 0.2.0 hosts always observe the current live values.
 */
export function resolveNoemaMemorySettings(entry) {
    const resolved = { ...NOEMA_MEMORY_SETTINGS_DEFAULTS };
    const target = resolved;
    for (const [key, fallback] of Object.entries(NOEMA_MEMORY_SETTINGS_DEFAULTS)) {
        const value = readNoemaConfigValue((entry ?? {})[key]);
        target[key] = (Array.isArray(value) ? [...value] : value === undefined ? fallback : value);
    }
    return resolved;
}
/**
 * Install the DSH 0.1.5 settings wiring, unchanged from the legacy behavior:
 * register the namespace and read/write/watch the returned scope.
 */
function installLegacyNoemaMemorySettings(settingsCtx, entry, hooks, fallback) {
    try {
        const scope = settingsCtx.settings.register(NOEMA_MEMORY_SETTINGS_NS, NOEMA_MEMORY_SETTINGS_SCHEMA, {
            base: entry,
            validate: validateNoemaMemorySettings,
        });
        hooks.setSource(() => scope.get());
        hooks.setWriter(patch => scope.update(patch));
        hooks.onChange();
        const unwatch = scope.watch(() => hooks.onChange());
        settingsCtx.effect(() => () => {
            unwatch();
            hooks.setWriter(undefined);
            hooks.setSource(() => fallback);
        });
    }
    catch (error) {
        settingsCtx.logger.warn('dsh-noema: settings registration failed: ' + (error instanceof Error ? error.message : String(error)));
    }
}
/**
 * Install the DSH 0.2.0 settings wiring: live values come from the volatile
 * Config refs, writes go through `settings.update` into the profile's
 * cordis.patch.yml, changes arrive via `loader/volatile-update`, and the
 * host's auto-generated page is disabled because noema ships its own panel.
 */
function installHostNoemaMemorySettings(settingsCtx, entryId, entry, hooks, fallback) {
    try {
        const disposePresentation = settingsCtx.settings.configure({ auto: false });
        hooks.setSource(() => resolveNoemaMemorySettings(entry));
        if (entryId !== undefined) {
            hooks.setWriter(async (patch) => {
                const candidate = { ...resolveNoemaMemorySettings(entry), ...patch };
                validateNoemaMemorySettings(candidate);
                await settingsCtx.settings.update(entryId, patch);
            });
        }
        const stop = settingsCtx.on('loader/volatile-update', () => hooks.onChange());
        settingsCtx.effect(() => () => {
            stop();
            disposePresentation();
            hooks.setWriter(undefined);
            hooks.setSource(fallback);
        });
    }
    catch (error) {
        settingsCtx.logger.warn('dsh-noema: settings wiring failed: ' + (error instanceof Error ? error.message : String(error)));
    }
}
/**
 * Install the optional-settings wiring. `entry` is the plugin's composition
 * entry config, used as the `base` layer on 0.1.5 and read as live volatile
 * refs on 0.2.0; `setSource` points the caller's resolution thunk at the
 * live resolved value and `onChange` fires when it moves.
 */
export function installNoemaMemorySettings(ctx, entry, hooks) {
    // Read fresh on every call: on 0.2.0 the entry holds volatile references
    // that move even when no settings service is mounted.
    const fallback = () => resolveNoemaMemorySettings(entry);
    // The profile entry belongs to the plugin's own fiber, not to the child
    // fiber that `ctx.inject` creates for the settings callback.
    const entryId = ctx.fiber?.entry?.options?.id;
    hooks.setSource(fallback);
    hooks.setWriter(undefined);
    ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx.settings;
        if (typeof settings.register === 'function') {
            installLegacyNoemaMemorySettings(settingsCtx, entry, hooks, fallback());
        }
        else {
            installHostNoemaMemorySettings(settingsCtx, entryId, entry, hooks, fallback);
        }
    });
}
export { IMPORTER_IDS } from './importers.js';
