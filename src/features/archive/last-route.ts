import AsyncStorage from '@react-native-async-storage/async-storage';

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
 * 3. 恢复——读后清除（consumeLastRoute，防重复恢复）；
 * 4. 保存门——「启动周期收口前不写缓存」的跨上下文鲁棒门控（持久标志
 *    BOOT_COMPLETED_KEY + saveLastRoute 内部门，见该段注）。
 * 恢复流程的接线与守卫在 app/_layout.tsx（本模块只管存取与合法性判断）。
 */

/** H8 key 命名：<domain>.<purpose>；cache-store 的 KEY_PATTERN 允许 '.' 段。 */
export const LAST_ROUTE_KEY = 'archive.lastRoute';

/**
 * 启动周期完成持久标志（AsyncStorage 直连：先例 = theme.ts 的 E2E 修复守卫
 * 'archive.e2e-repair-guard'——运行时门控状态不属 cache-store 的「派生数据缓存」
 * 语义域，且必须在 Activity 重建（新 JS 上下文）之后仍可读，这正是本标志存在的
 * 目的）。
 *
 * 语义：'1' = 某个 JS 上下文已完整走完「恢复周期」（consume → replace / 各无动作
 * 结论收口）。写点 = markLastRouteBootCompleted（周期各收口分支）；清点 =
 * consumeLastRoute（新周期开始，先于缓存读取）。
 *
 * 跨上下文（Android 主题双翻 = Activity 重建 = 新 JS 上下文，模块级状态全部
 * 重置，theme.ts:215-219 实测口径）可区分三种局面：
 * - 读得 '1'：上一上下文 / 上一冷启的周期已收口 → 放行保存（老口径）；
 * - 读得缺失：本冷启从未收口过（首次安装，或**上一上下文中途死亡**——双翻链里
 *   consume 之后、收口之前被重建击杀的典型态）→ 本上下文保存门保持关闭直至
 *   自身周期收口：重建后新上下文的播种路径 '/' 无法覆盖真实上次页面（宁可少存
 *   不可存错，少存的代价是下次冷启回首页，可接受）；
 * - 读取失败：降级放行（存储层自身故障时，长期完全不存比偶发存错更伤）。
 */
export const BOOT_COMPLETED_KEY = 'archive.boot.completed';

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
 *   再度命中 not-found（旧版本缓存的历史遗留也在此挡下）；
 * - 空 / 非紧致段（'//'、尾斜杠、首尾空白段）不可恢复——缓存属不可信外部
 *   输入（旧版本 / 脏数据残留），此类路径 replace 只会落到 +not-found 死局；
 *   正常序列化（ownSegments 空段即判无效）不可能产出，此处挡历史脏值。
 */
export function isRestorablePath(path: unknown): path is string {
    if (typeof path !== 'string' || !path.startsWith('/') || path.length === 0) return false;
    if (path === '/viewer' || path.startsWith('/viewer/')) return false;
    if (path === '/') return true;
    // 去掉根 '/' 后逐段校验：空段 / 首尾含空白段 / '+' 段一律拒绝
    return !path.slice(1).split('/').some(
        (segment) => segment === '' || segment.trim() !== segment || segment.startsWith('+'),
    );
}

// ---------------------------------------------------------------------------
// 存取：节流写入 / 读取 / 读后清除
// ---------------------------------------------------------------------------

/**
 * 保存门（模块级 = 单 JS 上下文粒度；Activity 重建产生的新上下文从关闭起步，
 * 跨上下文记忆由 BOOT_COMPLETED_KEY 持久标志接力）：
 * - 关闭时 saveLastRoute 一律丢弃：上下文启动后按 anchor 重新播种的初始路径
 *   '/'、以及恢复 replace 前的转场中间态，都不得覆盖真实上次页面；持久标志
 *   异步读完成前的首拍事件同样丢弃（读竞态窗口，宁可少存不可存错）。
 * - 开启点仅两个：① initLastRouteSaveGate 读得 '1'（或读取失败降级放行）；
 *   ② markLastRouteBootCompleted（本上下文恢复周期收口，同步置位）。
 */
let saveGateOpen = false;

/** 标志读取一次性闸门（模块级）：本上下文只读一次，effect 重跑 / 重挂幂等。 */
let saveGateInitDone = false;

/**
 * 上下文启动时装填保存门（fire-and-forget，每上下文一次）：异步读持久标志——
 * 读完成前保存门保持关闭（首拍 state 事件丢弃）；读得 '1' 放行；读得缺失则
 * 等待本上下文 markLastRouteBootCompleted 收口开启；读取失败降级放行。
 * 由 app/_layout 恢复 effect 顶部调用（先于轮询启动）。
 */
export function initLastRouteSaveGate(): void {
    if (saveGateInitDone) return;
    saveGateInitDone = true;
    AsyncStorage.getItem(BOOT_COMPLETED_KEY)
        .then((raw) => {
            if (raw === '1') saveGateOpen = true;
        })
        .catch((e: unknown) => {
            // 降级放行：门控依赖的存储层自身故障时退回「无门」老行为——长期
            // 完全不存（每次冷启回默认页）比偶发存错更伤。
            console.warn('[last-route] boot flag read failed, degrade to open gate:', e);
            saveGateOpen = true;
        });
}

/**
 * 恢复周期收口（app/_layout 各结论分支调用：replace 完成 / 无可恢复 / 深链
 * 入口 / 同屏短路 / 轮询超时 / 恢复异常降级）：写持久标志（后继上下文据此
 * 放行）+ 同步开启本上下文保存门。写失败仅告警：本上下文已同步开启，损失
 * 只落在后继上下文多关一门（少存方向，可接受）。
 */
export function markLastRouteBootCompleted(): void {
    saveGateOpen = true;
    AsyncStorage.setItem(BOOT_COMPLETED_KEY, '1').catch((e: unknown) => {
        console.warn('[last-route] mark boot completed failed:', e);
    });
}

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
 * 已知过渡路由（save 侧拒绝）：'viewer' 是 transparentModal 透明路由（root
 * Stack 级瞬时覆盖层，见 _layout 的 Stack.Screen 配置），脱离请求上下文无
 * 意义——用户停在 viewer 时进程被杀，缓存应保留 viewer 底下的内容页（打开
 * viewer 之前那次 state 事件的落盘值），而不是存入 /viewer 令下次恢复被
 * isRestorablePath 拒掉回落首页。'+' 特殊段由 pathFromNavigationState 序列化
 * 期挡下（返回 null → 调用方不写），此处仅防御性兜底。
 */
function isTransientSavePath(path: string): boolean {
    return path === '/viewer' || path.startsWith('/viewer/');
}

/**
 * 缓存上一次停留路径（trailing 节流：窗口内重复调用只落盘最终值）。
 * 调用方约定：仅在路径序列化成功（非 null）后调用——无效路由不覆盖上次缓存。
 * 门控：保存门开启前一律丢弃（播种 / 中间态不得入缓存，见 saveGateOpen 注）；
 * 恢复 replace 完成后由收口置位开启，恢复目标经 state 事件正常记录。
 */
export function saveLastRoute(path: string): void {
    if (!saveGateOpen) return;
    if (isTransientSavePath(path)) return;
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
 *
 * 顺序保证（覆盖窗口消除的关键）：先清 boot 完成标志、再读缓存——本上下文
 * 若在 consume 与周期收口之间被 Activity 重建击杀（双翻链典型死法），盘上
 * 标志为缺失态，后继上下文读到后保存门保持关闭直至自身收口，其播种路径
 * 无法覆盖真实路径。清除失败不阻断主流程（标志残留 '1' 的后果 = 后继上下文
 * 按放行口径，退回老行为，可接受）。
 */
export async function consumeLastRoute(): Promise<string | null> {
    await AsyncStorage.removeItem(BOOT_COMPLETED_KEY).catch(() => {
        // 静默降级：清除失败不阻断主流程（标志残留 '1' = 后继上下文按放行口径）
    });
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
