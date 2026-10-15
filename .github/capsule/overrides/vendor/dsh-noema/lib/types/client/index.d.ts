import type { JSX } from 'react';
// ⚠️ 来源随 rc.6 更新：原为 `@deepseek-ai/dsh-client-runtime/client`，
//    该包在 DSH 0.2.1 引擎树里**不存在**（实测），rc.6 已改为从 `@deepseek-ai/cordis` 取 Context。
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** Client services required by this plugin. */
export declare const inject: string[];
interface PanelProps {
    ctx: ClientContext;
}
/** The settings section body. */
export declare function NoemaMemorySettingsPanel({ ctx }: PanelProps): JSX.Element;
/** Register the settings section slot. */
export declare function apply(ctx: ClientContext): void;
export {};
