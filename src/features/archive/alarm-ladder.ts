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
    /** 到点是否应拉起 app 内全屏闹钟屏（阶梯里所有「非精确/系统不可达」兜底都指向它）。 */
    fullscreen: boolean;
    /** 到点后是否用常驻通知维持存活（Android = ongoing notification + FGS；确认后移除）。 */
    keepAlive: boolean;
    /** 系统级可呈现面是否完整（Android 通知权限被拒时 false：闹钟仍注册、到点数据不丢，但息屏/后台场景只能靠 app 已存活 + 常驻通知）。 */
    presentable: boolean;
}

/**
 * 阶梯决策树：
 * - android + exact granted → [system-exact, system-notification, in-app-fullscreen]，keepAlive ✓；
 * - android + exact denied → [system-inexact, system-notification, in-app-fullscreen]，keepAlive ✓
 *   （非精确到点仍走同一接收器：常驻通知 + 全屏 intent，精度降级不丢呈现）；
 * - android + unsupported（原生模块未链接，理论不该出现）→ 通知 + 全屏，无 keepAlive；
 * - ios → [system-notification, in-app-fullscreen]，无 keepAlive（iOS 无法后台拉起全屏，
 *   前台到点由 watcher/全屏屏承接——能力边界已如实注释于 core/alarm）；
 * - web → 仅 [in-app-fullscreen]（无任何系统面）。
 */
export function decideAlarmLadder(input: AlarmLadderInput): AlarmLadder {
    const presentable = input.platform !== 'web' && input.notificationsGranted;
    if (input.platform === 'android') {
        if (input.exact === 'unsupported') {
            // 原生模块未链接（理论不该出现的 Android 形态）：闹钟注册表/
            // 接收器都不在场，只剩通知链 + 前台全屏屏，不承诺 keepAlive
            return {
                tiers: ['system-notification', 'in-app-fullscreen'],
                fullscreen: true,
                keepAlive: false,
                presentable,
            };
        }
        const lead: AlarmTier = input.exact === 'granted' ? 'system-exact' : 'system-inexact';
        return {
            tiers: [lead, 'system-notification', 'in-app-fullscreen'],
            fullscreen: true,
            keepAlive: true,
            presentable,
        };
    }
    if (input.platform === 'ios') {
        return {
            tiers: ['system-notification', 'in-app-fullscreen'],
            fullscreen: true,
            keepAlive: false,
            presentable,
        };
    }
    return {
        tiers: ['in-app-fullscreen'],
        fullscreen: true,
        keepAlive: false,
        presentable: false,
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
