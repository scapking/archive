/**
 * web 端持久存储降级状态（内存库兜底的单一事实源）。
 *
 * core/database 的 connect() 在 web 打开持久库失败、且错误被
 * classifyWebStorageFailure 判为 'storage-unavailable' 时，以 ':memory:'
 * （SQLite 内核魔法文件名 → 每连接独立私有内存库）重建库连接并在此登记降级：
 * - 数据面：内存库在本页面会话内完全可用（含事务/迁移），刷新即失；
 * - 业务面：db/store 层无感知（连接仍由 openDatabase 门面返回）；
 * - 用户面：degradation-banner（本模块状态订阅）常驻提示，不渲染为失败态。
 *
 * 降级按会话粘滞：降级后即使持久层恢复（如另一标签页关闭）也不再切回——
 * 中途换库会让会话内已写数据消失；刷新页面重新评估即可回到持久库。
 */

/** expo-sqlite web 的内存库路径约定（worker 按 `=== ':memory:'` 选 MemoryVFS）。 */
export const MEMORY_DB_PATH = ':memory:' as const;

/** 降级提示文案（banner 展示；与要求口径一致）。 */
export const WEB_STORAGE_DEGRADED_NOTICE = '当前浏览器无法持久化数据，本次记录仅保留在会话中' as const;

export interface WebStorageDegradation {
    /** 已降级为内存库的逻辑库名（各库独立登记，各自降级）。 */
    readonly databaseNames: readonly string[];
    /** 用户可读提示（固定文案，见 WEB_STORAGE_DEGRADED_NOTICE）。 */
    readonly reason: string;
}

const degradedNames = new Set<string>();
const listeners = new Set<() => void>();
// 快照缓存（useSyncExternalStore 契约：getSnapshot 必须返回稳定引用——每次
// 调用新建对象会让 React 判定状态恒变、陷入重渲循环）；仅在降级集合变化时重建。
let snapshot: WebStorageDegradation | null = null;

/** 登记某库降级为内存库；首个降级事件触发一次订阅通知（banner 无重渲风暴）。 */
export function markWebStorageDegraded(name: string): void {
    if (degradedNames.has(name)) return;
    degradedNames.add(name);
    snapshot = { databaseNames: [...degradedNames], reason: WEB_STORAGE_DEGRADED_NOTICE };
    for (const listener of listeners) listener();
}

/** 当前降级状态；未降级返回 null。 */
export function getWebStorageDegradation(): WebStorageDegradation | null {
    return snapshot;
}

/** 订阅降级状态变化（banner 用 useSyncExternalStore 消费）；返回退订函数。 */
export function subscribeWebStorageDegradation(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
