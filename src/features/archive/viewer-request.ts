import { useSyncExternalStore } from 'react';
import { router } from 'expo-router';

/**
 * 全屏查看器请求通道（中立层，模式同 data-revision.ts）：
 *
 * 全屏媒体查看从「屏内条件渲染覆盖层」改为「透明模态路由 /viewer」（根治
 * tab 屏内覆盖层盖不住 tabBar 条带：expo-router BottomTabView 的 screens
 * 容器 overflow:hidden + tabBar 后绘，任何屏内覆盖层都压不到 tab 条带，
 * Android 尤甚）。本模块是请求侧（ui/media-view、deck 封面）与路由屏
 * （app/viewer.tsx）之间的汇点：
 *
 * - 请求侧调 requestViewer(payload)：记录载荷 + 导航到 /viewer（合在一处
 *   是刻意的——双击/连点的去重握手、typedRoutes 的 `as never` 妥协都只
 *   存在一个收口点，调用方一行完成，没有「请求了忘了 push」的半程态）；
 * - 路由屏用 useViewerRequest()（useSyncExternalStore 直连）取当前请求渲染。
 *
 * 本模块不得 import 任何业务模块（store/db/ui 全禁），只依赖 react 与
 * expo-router 的命令式 router——它是依赖图的「汇点」，谁引它都不会成环。
 */

/** 全屏查看载荷：kind 分发图片/视频查看器，元数据随行（查看器当前未消费，预留）。 */
export interface ViewerRequestPayload {
    kind: 'image' | 'video';
    fileKey: string;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
}

/** 带序号的请求快照（useViewerRequest 返回；seq 供调试追踪，渲染可忽略）。 */
export interface ViewerRequest extends ViewerRequestPayload {
    seq: number;
}

let current: ViewerRequest | null = null;
let seq = 0;
/**
 * push 去重握手：requestViewer 发起后、viewer 路由挂载回执前为 true——
 * 期间的重复请求（快速连点，底层屏在手势上仍可能命中一拍）只刷新载荷不叠
 * 路由，杜绝透明模态叠两层。viewer 挂载即回执解锁；GRACE 定时器兜底防
 * 「push 未落地导致通道永久卡死」（极端时序下 1.2s 后自动恢复可导航）。
 */
let awaitingMount = false;
let mountGraceTimer: ReturnType<typeof setTimeout> | null = null;

const VIEWER_MOUNT_GRACE_MS = 1200;

const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

/** 请求全屏查看 + 导航到 /viewer（media-view 各入口、deck 封面的统一收口）。 */
export function requestViewer(payload: ViewerRequestPayload): void {
    current = { ...payload, seq: (seq += 1) };
    emit();
    // 已在打开途中（viewer 未回执挂载）：只换载荷，不重复 push（防模态叠层）
    if (awaitingMount) return;
    awaitingMount = true;
    // typedRoutes：/viewer 为新路由字面量，.expo/types 生成物未含（本组不跑
    // Metro，先例见 me-screen.tsx '/search'）——`as never` 最小妥协，类型生成后可删
    router.push('/viewer' as never);
    if (mountGraceTimer != null) clearTimeout(mountGraceTimer);
    mountGraceTimer = setTimeout(() => {
        mountGraceTimer = null;
        awaitingMount = false;
    }, VIEWER_MOUNT_GRACE_MS);
}

/** viewer 路由屏挂载回执：解除 push 去重（app/viewer.tsx 挂载 effect 调用）。 */
export function notifyViewerMounted(): void {
    awaitingMount = false;
    if (mountGraceTimer != null) {
        clearTimeout(mountGraceTimer);
        mountGraceTimer = null;
    }
}

/** useSyncExternalStore 订阅契约（快照为不可变对象，引用比较天然稳定）。 */
function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getSnapshot(): ViewerRequest | null {
    return current;
}

/**
 * 当前查看请求（app/viewer.tsx 用）：快照在两次 requestViewer 之间保持不变；
 * 请求为 null（深链直连 /viewer、JS 冷启动后无请求）时由路由屏立即 back。
 * 载荷不随查看结束清空：下一次 requestViewer 必然整体覆写，残留只影响
 * 「无请求直连」这一种边缘深链（渲染上次查看的媒体，无害）。
 */
export function useViewerRequest(): ViewerRequest | null {
    return useSyncExternalStore(subscribe, getSnapshot);
}
