/**
 * 闹钟优先级阶梯（v0.4.7 用户指令 #2/#3）——纯函数决策层。
 *
 * 阶梯语义（一句话）：先尽力走系统原生精确闹钟（Android AlarmManager
 * setExactAndAllowWhileIdle，到点全屏 intent 直跳 app 内全屏闹钟屏）；
 * 做不到的档位（Android 12+ SCHEDULE_EXACT_ALARM 被拒 → 非精确兜底仍必达；
 * iOS/web 无第三方闹钟 API）→ 到点拉起 app 内全屏闹钟 UI（循环提示音 +
 * 手动确认停止），Android 以常驻通知/前台服务维持存活，确认后移除。
 *
 * 本文件不 import 任何运行时（expo/react-native/db）——node 测试直接 import；
 * 屏层/store/原生模块消费这里的决策与路径构造，保证「平台能力边界」只有一处
 * 事实源。深链一律路径参数（AGENTS.md 偏差表：web push 丢 query，三端统一）。
 */

export type AlarmPlatform = 'android' | 'ios' | 'web';

/** core/alarm permission() 的三态（Android 12+ SCHEDULE_EXACT_ALARM 管制）。 */
export type ExactPermission = 'granted' | 'denied' | 'unsupported';

/** 阶梯档位，按优先级从高到低排列在 AlarmLadder.tiers 内。 */
export type AlarmTier =
    /** Android 精确闹钟（AlarmManager setExactAndAllowWhileIdle + 全屏 intent）。 */
    | 'system-exact'
    /** Android 非精确兜底（setAndAllowWhileIdle，SCHEDULE_EXACT_ALARM 被拒时；延迟可到分钟级但必达）。 */
    | 'system-inexact'
    /** 本地通知（expo-notifications 链，iOS timeSensitive 强提醒档）。 */
    | 'system-notification'
    /** app 内全屏闹钟 UI（循环音 + 手动确认；Android 经全屏 intent/通知 tap 冷拉起，iOS 仅前台可达）。 */
    | 'in-app-fullscreen';

export interface AlarmLadderInput {
    platform: AlarmPlatform;
    /** 精确闹钟权限（Android 语义；iOS/web 恒 'unsupported'）。 */
    exact: ExactPermission;
    /** 系统通知权限是否已授予（决定 system-notification 档是否真实在场）。 */
    notificationsGranted: boolean;
}

export interface AlarmLadder {
    /** 可用档位（优先级降序）。 */
    tiers: AlarmTier[];
    /**
     * v0.5.1 令 3 拉回尝试档：到点是否**尝试把 app 拉回前台呈现**
     * （Android = 接收器挂 full-screen intent；iOS 无该 API = false，
     * 进 app 的通道只剩「用户点通知深链 / 回前台 watcher」）。
     */
    pullback: boolean;
    /**
     * v0.5.1 令 2 本地通知兜底档：**拉回不可得时必有通知**（卡片内容 =
     * 行程项内容 + 时间，文案同 alarmCardContent 契约）——Android = 接收器
     * 与通知权限在场时的常驻通知（含 heads-up）；iOS = timeSensitive 本地
     * 通知。web 无任何系统面 = false。
     */
    notificationFallback: boolean;
    /** 到点是否应拉起 app 内全屏闹钟屏（在场呈现形态；三端路由面都在，
     *  触达通道分平台：Android pullback/通知 tap、iOS 通知 tap/前台 watcher）。 */
    fullscreen: boolean;
    /** 到点后是否用常驻通知维持存活（Android = ongoing notification + FGS；确认后移除）。 */
    keepAlive: boolean;
    /** 系统级可呈现面是否完整（Android 通知权限被拒时 false：闹钟仍注册、到点数据不丢，但息屏/后台场景只能靠 app 已存活 + 常驻通知）。 */
    presentable: boolean;
}

/**
 * 阶梯决策树（v0.5.1 令 3 重构语义 = **一条统一产品阶梯，双端同构**：
 * 「拉回尝试 → 本地通知兜底 → 前台呈现」，任何一档可达即该档真实在场，
 * 拉回失败必然落进通知兜底，不留静默洞）：
 * - android + exact granted → [system-exact(拉回尝试), system-notification(兜底),
 *   in-app-fullscreen(前台呈现)]，pullback ✓ keepAlive ✓；
 * - android + exact denied → [system-inexact, system-notification, in-app-fullscreen]
 *   ——非精确到点仍走同一接收器：常驻通知 + 全屏 intent，精度降级不丢呈现与兜底；
 * - android + unsupported（原生模块未链接，理论不该出现）→ 无拉回通道，只剩
 *   expo 通知链兜底 + 前台呈现，无 keepAlive；
 * - ios → 无后台强拉 API（平台上限如实）：pullback=false，到点呈现 =
 *   timeSensitive 本地通知（critical sound 不可得，默认通知声 + 震动档），
 *   用户点通知经 data.path 深链进全屏屏；前台到点由 watcher 直呈全屏屏；
 * - web → 仅路由面 [in-app-fullscreen]（无系统通知、无拉回）。
 */
export function decideAlarmLadder(input: AlarmLadderInput): AlarmLadder {
    const presentable = input.platform !== 'web' && input.notificationsGranted;
    if (input.platform === 'android') {
        if (input.exact === 'unsupported') {
            // 原生模块未链接（理论不该出现的 Android 形态）：闹钟注册表/
            // 接收器都不在场，拉回通道随之消失；通知链 + 前台全屏屏仍在
            return {
                tiers: ['system-notification', 'in-app-fullscreen'],
                pullback: false,
                notificationFallback: presentable,
                fullscreen: true,
                keepAlive: false,
                presentable,
            };
        }
        const lead: AlarmTier = input.exact === 'granted' ? 'system-exact' : 'system-inexact';
        return {
            tiers: [lead, 'system-notification', 'in-app-fullscreen'],
            // Android 到点必走全屏 intent（fullScreen 传参链见 AlarmFireReceiver/
            // AlarmKeepAliveService v0.5.1 注）；拉回不成（heads-up 场景/ROM 吞
            // intent）→ 常驻通知 + 铃声震动兜底，两档同时在场、无静默洞
            pullback: true,
            notificationFallback: presentable,
            fullscreen: true,
            keepAlive: true,
            presentable,
        };
    }
    if (input.platform === 'ios') {
        return {
            tiers: ['system-notification', 'in-app-fullscreen'],
            pullback: false,
            notificationFallback: presentable,
            fullscreen: true,
            keepAlive: false,
            presentable,
        };
    }
    return {
        tiers: ['in-app-fullscreen'],
        pullback: false,
        notificationFallback: false,
        fullscreen: true,
        keepAlive: false,
        presentable: false,
    };
}

/**
 * 提醒内容卡文案双端同构（v0.5.1 令 2/3：卡片内容 = 行程项内容 + 时间）。
 * title = 「HH:mm 标题」（空标题只显时刻，禁兜底文字——v0.5.1 卡面禁词纪律
 * 同源）；body = 描述 → 退标题 → 空。Android 注册表 title/body 快照与 iOS
 * expo-notifications content 都应按本函数产出（消费点：store 调度接线处；
 * 全屏屏呈现用行数据直读，同字段同事实源）。
 */
export function alarmCardContent(item: {
    time: string;
    title: string;
    description?: string;
}): { title: string; body: string } {
    const trimmedTitle = item.title.trim();
    return {
        title: trimmedTitle ? `${item.time} ${trimmedTitle}` : item.time,
        body: item.description?.trim() || trimmedTitle,
    };
}

// ─── 深链路径构造（唯一事实源：路由壳 / 原生接收器 / watcher 共用）──────────

/** 全屏闹钟屏路由名（app/alarm/[id].tsx，id = 行程项 id）。 */
export const ALARM_ROUTE = '/alarm';

/** 通知 identifier 前缀（与 store 既有 `trip-item-<id>` 约定对齐；watcher 在 iOS 侧按前缀回收）。 */
export const TRIP_ITEM_NOTIFICATION_PREFIX = 'trip-item-';

/** app scheme 深链前缀（app.json expo.scheme = 'archive'；三端一致）。 */
export const APP_SCHEME = 'archive';

/** 行程项闹钟 id 的 URL 段编码（id 是 uuid 天然安全，仍统一编码防御特殊字符）。 */
function encodeId(id: string): string {
    return encodeURIComponent(id);
}

/** expo-router 应用内路径（router.push/replace 用；路径参数，勿 query）。 */
export function alarmRoutePath(itemId: string): string {
    return `${ALARM_ROUTE}/${encodeId(itemId)}`;
}

/** 原生侧 full-screen intent / 通知 tap 深链（Android Uri、iOS widgetURL 同构）。 */
export function alarmDeepLink(itemId: string, scheme: string = APP_SCHEME): string {
    return `${scheme}://alarm/${encodeId(itemId)}`;
}

/** 行程深链（widget 点卡既有语义 `archive://trip/<id>` 的单一构造点）。 */
export function tripDeepLink(tripId: string, scheme: string = APP_SCHEME): string {
    return `${scheme}://trip/${encodeId(tripId)}`;
}

/**
 * `/alarm/<id>` 路由路径 → 闹钟 id（alarmRoutePath 的逆运算，v0.5.1 令 2/3
 * 「点通知进 app 呈现」接驳用：通知 content.data.path 即由 alarmRoutePath
 * 写入，tap 后由 watcher 解析回收）。非闹钟路径 / 空段 / 非法编码 = null。
 */
export function itemIdFromAlarmPath(path: string): string | null {
    const prefix = `${ALARM_ROUTE}/`;
    if (!path.startsWith(prefix)) return null;
    const segment = path.slice(prefix.length);
    if (segment.length === 0 || segment.includes('/')) return null;
    try {
        return decodeURIComponent(segment);
    } catch {
        // 非法百分号编码（外部伪造路径）：按非闹钟路径处理
        return null;
    }
}

// ─── 到点判定（watcher 软计时与原生注册表共用）────────────────────────────

/** 原生闹钟注册表条目（AlarmScheduler SharedPreferences 形态；listScheduled 回传）。 */
export interface ScheduledAlarmEntry {
    id: string;
    at: number;
    title: string;
    body: string;
}

/** 已到点（at <= now）的条目，按到点时间升序——watcher 每拍取第一条拉起。 */
export function pickDueEntries(
    entries: ScheduledAlarmEntry[],
    now: number,
): ScheduledAlarmEntry[] {
    return entries.filter((entry) => entry.at <= now).sort((a, b) => a.at - b.at);
}

/** 通知 identifier → 行程项 id（前缀不匹配返回 null）。 */
export function itemIdFromNotificationId(identifier: string): string | null {
    return identifier.startsWith(TRIP_ITEM_NOTIFICATION_PREFIX)
        ? identifier.slice(TRIP_ITEM_NOTIFICATION_PREFIX.length)
        : null;
}

// ─── v0.5.1 真机纠错的可测判定（watcher 拉起去重 / 全屏屏外部停铃收账）──────

/**
 * 「本会话已把该闹钟拉进全屏屏（或被用户停掉）」共享账（v0.5.1）：
 * id → 处理时的**计划触发时刻**指纹。三通道（watcher 软计时 / 页内到点检查
 * / 全屏屏出口）必须共用这本账——各持会话集时，任一通道 replace 导航卸载
 * 另一通道的屏后，卸载会带走其局部集，回页对同一 ongoing 项二次跳屏 =
 * 「关掉又响」复响回路（v0.5.1 纠错实测推演）。以 at 为指纹：同一行程项被
 * 重排（updateTripItem → 新 at）后天然重新在场，不会被陈旧账吞掉。
 * 纯运行时 Set/Map（本文件仍零 import，node 测试可直接驱动）。
 */
const handledAlarms = new Map<string, number>();

/** 记入账：id 在该计划时刻已被处理（拉起确认/停止/页内跳过）。 */
export function markAlarmHandled(id: string, at: number): void {
    handledAlarms.set(id, at);
}

/** 查询：id 的**该次**计划是否已处理（重排后 at 不同 → 未处理）。 */
export function isAlarmHandled(id: string, at: number): boolean {
    return handledAlarms.get(id) === at;
}

/**
 * watcher 是否应把该到点闹钟拉进全屏屏（v0.5.1 起为可测纯函数——原内联于
 * alarm-watcher 的 pushAlarm，两处「关不掉/重复弹」根因都落在这个判定上）：
 * - 会话账已记（同 at 已拉起/已处理）→ false；
 * - 已在 /alarm 路由（含 /alarm/<id>）→ false：全屏屏在场，不叠第二张。
 */
export function shouldPresentAlarm(
    id: string,
    at: number,
    pathname: string,
    handled: (id: string, at: number) => boolean = isAlarmHandled,
): boolean {
    if (handled(id, at)) return false;
    if (pathname.startsWith(ALARM_ROUTE)) return false;
    return true;
}

/**
 * 该闹钟是否已被「外部停铃」出账（v0.5.1 用户反馈『关闭后依然有声音』之二）：
 * 通知动作「停止」/删除行程项走原生 AlarmScheduler.cancel——注册表条目移除，
 * 但正在响的 app 内全屏屏（expo-audio loop）收不到任何 JS 侧信号（不加新原生
 * 事件面，保守约束），由全屏屏低频回读 listScheduled：id 不在注册表 = 已被
 * 停掉 → 屏自取静音离场。语义前提：到点未确认的条目**留在**注册表（fire 只
 * 落 fired 账，出账唯一入口是 cancel/confirm，见 AlarmScheduler 注），
 * 所以「不在」只可能是停止，不会是「还没响」。
 */
export function isAlarmSettled(id: string, scheduled: readonly ScheduledAlarmEntry[]): boolean {
    return !scheduled.some((entry) => entry.id === id);
}
