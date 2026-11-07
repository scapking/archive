import { useSyncExternalStore } from 'react';

/**
 * 数据版本广播（中立层，v5 require cycle 修复的核心反转点）：
 *
 * 旧依赖：ui/use-file-url → store（useArchiveRevision）——叠加上 store → ui/index
 * 的 barrel 依赖，形成 store → ui → use-file-url → store 的 require cycle
 * （真机 WARN：Require cycle: store.ts -> ui/index.ts -> editor.tsx -> ... -> store.ts）。
 *
 * 新依赖：store 与 ui 都只指向本模块，二者互不相见：
 * - store.ts：mutation 成功后 bump zustand revision 时经 notifyDataRevision() 广播；
 * - ui 层（use-file-url 等）：useDataRevision() 订阅（useSyncExternalStore 直连），
 *   ui 组件文件不再 import store。
 *
 * 本模块不得 import 任何业务模块（store/db/ui 全禁），只依赖 react——
 * 它是依赖图的「汇点」，谁引它都不会成环。
 */

let revision = 0;
const listeners = new Set<() => void>();

/** mutation 落库后的广播入口（仅 store 层调用）。 */
export function notifyDataRevision(): void {
    revision += 1;
    for (const listener of listeners) listener();
}

/** useSyncExternalStore 订阅契约（快照恒为 number，比较天然稳定）。 */
function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getSnapshot(): number {
    return revision;
}

/**
 * 数据版本订阅（ui 层用）：任何 store mutation（落库/删除/媒体上传）后自增，
 * 与 store.revision 同源同步（store.ts 内 subscribe 转发，单一事实源仍是 zustand）。
 */
export function useDataRevision(): number {
    return useSyncExternalStore(subscribe, getSnapshot);
}
