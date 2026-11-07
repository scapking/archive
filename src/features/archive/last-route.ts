import { cacheStore } from '@/core/cache-store';

/**
 * 上一次停留界面的跨启动缓存（需求：「app 打开直接回到上次的界面」）。
 *
 * 落位决策（H3 数据落位）：cache-store 的语义 =「可随时丢弃、可从源头重建的
 * 派生数据的跨启动存放」，last-route 正是此类临时状态（冷启读一次即弃，丢了
 * 也无损，大不了回默认页）；且其 TTL 是可选参数（不传 = 永不过期，get 只在
 * 显式设置 ttlMs 时才判过期），不存在「TTL 强制过期语义不符」的问题。
 * 故落 cache-store 而非 AsyncStorage 直连；依赖方向 features → core（H4）。
 *
 * 模块职责：
 * 1. 序列化——根 navigation state → 可恢复路径（纯函数 pathFromNavigationState）；
 * 2. 写入——节流落盘（转场期 state 事件风暴防护，卸载可 flush）；
 * 3. 恢复——读后清除（consumeLastRoute，防重复恢复）。
 * 恢复流程的接线与守卫在 app/_layout.tsx（本模块只管存取与合法性判断）。
 */

/** H8 key 命名：<domain>.<purpose>；cache-store 的 KEY_PATTERN 允许 '.' 段。 */
export const LAST_ROUTE_KEY = 'archive.lastRoute';

/**
 * 写节流窗口（ms）：路由转场期根容器 'state' 事件高频触发（嵌套 navigator 的
 * 每次变化都会上抛），逐事件直写 SQLite 是写风暴。300ms trailing 合并：窗口
 * 内反复变化的最终值胜出（即用户真实停留屏），落盘频率 ≤ 3.3 次/秒。
 */
const SAVE_THROTTLE_MS = 300;

/**
 * 递归深度上限：正常导航树最多 3~4 层（root stack → (tabs) → tab → 内嵌 stack），
 * 16 层兜底防御异常 / 意外循环结构，超深一律判无效路径。
 */
const MAX_STATE_DEPTH = 16;

/**
 * 序列化所需的最小结构类型（react-navigation NavigationState / Route 的结构子集，
 * 全部字段可选化以兼容 PartialState 等变体）。声明为独立接口而非直接引用
 * react-navigation 类型：本文件保持纯逻辑、便于脱离 RN 环境自验。
 */
export interface RouteLike {
    /** 路由名 = 文件路径模式（如 'trip/[id]/write/[date]'、'(tabs)'、'index'） */
    name: string;
    /** params 动态段取值源（含 query 参数，但 query 不参与路径构建） */
    params?: unknown;
    /** 嵌套 navigator（tabs / stack）的子状态 */
    state?: NavigatorStateLike;
}

export interface NavigatorStateLike {
    /** 激活路由下标；缺失时按惯例取最后一个（stack push 语义） */
    index?: number;
    routes?: readonly RouteLike[];
}

// ---------------------------------------------------------------------------
// 序列化：根 navigation state → 路径
// ---------------------------------------------------------------------------

/** params 字段收窄：非普通对象视为异常（null/数组/原始值 → 无 params 可用） */
function paramsOf(route: RouteLike): Record<string, unknown> {
    const p = route.params;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return {};
    return p as Record<string, unknown>;
}

/**
 * expo-router 路由名 → 该路由自身的 URL 段（不含嵌套子路由）。
 * 规则（均为 expo-router 的文件路由约定）：
 * - 'index' → 空段（index 屏 = 父路径本身，如 (tabs)/index → '/'）；
 * - 括号组段 '(tabs)' → 不进 URL；
 * - '[x]' → params.x 填充（string / 有限 number）；缺失或空值 → 该路由无效；
 * - '[...x]' catch-all → params.x（段数组）展开；缺失 → 无效；
 * - '+' 前缀段（+not-found / +html 等特殊文件）→ 无 URL 语义，无效。
 */
function ownSegments(route: RouteLike): string[] | null {
    const name = route.name;
    if (typeof name !== 'string' || name === '') return null;
    if (name === 'index') return [];

    const params = paramsOf(route);
    const own: string[] = [];
    for (const part of name.split('/')) {
        if (part === '') return null; // 空段：异常路由名
        if (/^\([^()]*\)$/.test(part)) continue; // 路由组不进 URL
        if (part.startsWith('+')) return null; // 特殊文件无 URL 语义 → 无效
        if (part.startsWith('[...') && part.endsWith(']')) {
            const value = params[part.slice(4, -1)];
            if (!Array.isArray(value) || value.length === 0) return null;
            for (const item of value) {
                if (typeof item !== 'string' || item === '') return null;
                own.push(item);
            }
        } else if (part.startsWith('[') && part.endsWith(']')) {
            // 动态段 params 缺失 → 该路由跳过 = 无效路径（不可重建）
            const value = params[part.slice(1, -1)];
            if (typeof value === 'string' && value !== '') own.push(value);
            else if (typeof value === 'number' && Number.isFinite(value)) own.push(String(value));
            else return null;
        } else {
            own.push(part);
        }
    }
    return own;
}

/** 取 state 的激活路由并递归序列化（嵌套 tabs/stack 逐层拼段） */
function collectActiveSegments(state: NavigatorStateLike, depth: number): string[] | null {
    if (depth > MAX_STATE_DEPTH) return null;
    const routes = state.routes;
    if (!routes || routes.length === 0) return null;
    const index =
        typeof state.index === 'number' && state.index >= 0 && state.index < routes.length
            ? state.index
            : routes.length - 1;
    const active = routes[index];
    if (!active) return null;

    const own = ownSegments(active);
    if (own === null) return null;
    if (active.state) {
        const child = collectActiveSegments(active.state, depth + 1);
        if (child === null) return null;
        own.push(...child);
    }
    return own;
}

/**
 * 根 navigation state → 可恢复路径。
 * - 根 stack 的路由名即文件路径模式（如 'trip/[id]/write/[date]'），用 params
 *   填充动态段；(tabs) 组内 index/me 映射 '/' / '/me'（见 (tabs)/_layout 的
 *   Tabs.Screen name：'index' | 'me'，index 屏按约定映射为空段）。
 * - query 参数不进路径（仓库偏差：web push 丢 query，路径参数为准）。
 * - 无效 / 未知路由（动态段缺 params、+特殊文件、空结构）返回 null。
 */
export function pathFromNavigationState(
    state: NavigatorStateLike | null | undefined,
): string | null {
    if (!state) return null;
    const segments = collectActiveSegments(state, 0);
    if (segments === null) return null;
    if (segments.length === 0) return '/';
    return `/${segments.join('/')}`;
}

// ---------------------------------------------------------------------------
// 恢复目标合法性（守卫在 _layout 侧调用；放这里与序列化规则同源、可自验）
// ---------------------------------------------------------------------------

/**
 * 缓存路径是否可作为恢复目标：
 * - 必须以 '/' 开头且非空；
 * - '/viewer'（transparentModal 透明路由）不可作恢复目标——脱离请求上下文
 *   恢复它只会得到一个空的全屏查看器；
 * - 含 '+' 前缀段（+not-found 等）不可恢复——特殊文件无 URL 语义，恢复只会
 *   再度命中 not-found（旧版本缓存的历史遗留也在此挡下）。
 */
export function isRestorablePath(path: unknown): path is string {
    if (typeof path !== 'string' || !path.startsWith('/') || path.length === 0) return false;
    if (path === '/viewer' || path.startsWith('/viewer/')) return false;
    return !path.split('/').some((segment) => segment.startsWith('+'));
}

// ---------------------------------------------------------------------------
// 存取：节流写入 / 读取 / 读后清除
// ---------------------------------------------------------------------------

let pendingPath: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 节流的实际落盘：写 cache-store，失败静默降级（缓存不是关键路径） */
function writePath(path: string): void {
    cacheStore.set(LAST_ROUTE_KEY, path).catch((e: unknown) => {
        console.warn('[last-route] save failed:', e);
    });
}

/** 节流窗口到点：把窗口内最新一次的路径落盘 */
function flushPending(): void {
    saveTimer = null;
    const path = pendingPath;
    pendingPath = null;
    if (path !== null) writePath(path);
}

/**
 * 缓存上一次停留路径（trailing 节流：窗口内重复调用只落盘最终值）。
 * 调用方约定：仅在路径序列化成功（非 null）后调用——无效路由不覆盖上次缓存。
 */
export function saveLastRoute(path: string): void {
    pendingPath = path;
    if (saveTimer !== null) return;
    saveTimer = setTimeout(flushPending, SAVE_THROTTLE_MS);
}

/**
 * 卸载 flush：把仍在节流窗口内、尚未落盘的路径立即写掉（Fast Refresh /
 * 导航容器卸载时由 _layout cleanup 调用）。幂等：无 pending 时为 no-op。
 */
export async function flushLastRoute(): Promise<void> {
    if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    const path = pendingPath;
    pendingPath = null;
    if (path !== null) writePath(path);
}

/** 读取缓存路径（不清除）；缺失 / 类型异常 / 读取失败返回 null。 */
export async function readLastRoute(): Promise<string | null> {
    try {
        const value = await cacheStore.get<string>(LAST_ROUTE_KEY);
        return typeof value === 'string' && value !== '' ? value : null;
    } catch (e) {
        console.warn('[last-route] read failed:', e);
        return null;
    }
}

/**
 * 读取并清除缓存路径（消费语义，防重复恢复——第二次读到必为 null）。
 * 清除失败仅告警不吞结果：重复恢复由调用方的一次性守卫兜底。
 */
export async function consumeLastRoute(): Promise<string | null> {
    try {
        const value = await cacheStore.get<string>(LAST_ROUTE_KEY);
        const path = typeof value === 'string' && value !== '' ? value : null;
        if (value !== null) {
            try {
                await cacheStore.remove(LAST_ROUTE_KEY);
            } catch (e) {
                console.warn('[last-route] clear failed:', e);
            }
        }
        return path;
    } catch (e) {
        console.warn('[last-route] consume failed:', e);
        return null;
    }
}
