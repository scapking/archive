import { useEffect, useRef } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { alarm } from '@/core/alarm';
import { notifications } from '@/core/notifications';
import {
    ALARM_ROUTE,
    isAlarmConfirmed,
    isAlarmSettled,
    itemIdFromAlarmPath,
    itemIdFromNotificationId,
    markAlarmHandled,
    pickDueEntries,
    shouldPresentAlarm,
} from './alarm-ladder';
import { refreshAlarmMonitor } from './store';

/**
 * 闹钟提醒 watcher（v0.4.7 令 #2/#3 JS 侧薄层；v0.5.1 令 2/3 扩为统一阶梯
 * 「拉回尝试 → 本地通知兜底 → 前台呈现」的 JS 半边；接线由主控在
 * app/_layout.tsx 挂载——一行 hook）。
 *
 * 职责 = 「把该响的闹钟拉/推进全屏闹钟屏，一条都不静默」：
 * - Android：冷启/回前台 drainFired（full-screen intent 之外的兜底——用户从
 *   最近任务/桌面图标进 app 也补拉起）；每 20s 软计时扫原生注册表，非精确档
 *   （SCHEDULE_EXACT_ALARM 被拒）到点即拉 /alarm/<id>；系统拉回失败（息屏外
 *   的 heads-up 场景/OEM 吞 intent）时接收器的常驻通知卡（内容=时间+标题+
 *   描述）恒在场，其 tap 走 URL 深链由 expo-router 原生承接；挂载/回前台/tick
 *   同拍幂等刷「N 个行程提醒监控中」常驻监控通知（v0.5.2 令3，判据在原生
 *   注册表，store.refreshAlarmMonitor 与 store 钩子共用；iOS 无 FGS 等价物，
 *   「常驻」= 已排期通知在通知中心可见——门面 no-op 路径，平台上限如实）；
 * - iOS：无系统闹钟、后台无法拉起全屏（平台上限如实）——「拉回不可得」的
 *   默认兜底 = timeSensitive 本地通知（内容=时间+标题+描述，alarmCardContent
 *   同构文案）；本 hook 承接其 **tap 进 app 呈现**（v0.5.1 令 2 补的洞：
 *   data.path 此前无人消费，点通知只回首页不弹闹钟）与前台到点直呈：扫
 *   expo-notifications 已调度列表（identifier `trip-item-<id>`），到点即拉
 *   全屏屏并撤销该通知（避免进屏后系统横幅重复打扰）；
 * - 双端 tap 通道（令 3 行为一致）：onResponse 订阅 + 冷启 getLastResponse——
 *   notification.content.data.path → itemIdFromAlarmPath → 全屏屏；Android
 *   侧再验注册表未出账（已「停止」的残留 intent 不得复活铃屏），iOS tap 即呈。
 *
 * 全屏屏自身负责确认停止（acknowledge → confirmAlarmSession + alarm.confirm），
 * watcher 只做「发现到点/被 tap，只拉一次」——去重走 alarm-ladder 共享会话
 * 账（抢占标记 id→at 指纹；**确认出账 id 级无条件**，web 同样闭环——CDP
 * wheel4/5/6 实锤：即时指纹兜底会覆盖 dueAt 槽位造成确认后再跳的劫持环）；
 * 已在 /alarm 路由则不拉；tap 通道只绕抢占标记，不绕确认账。
 */

/** 软计时节拍（ms）：20s 对「分钟级」行程时刻足够（同 trip-day 15s 口径量级）。 */
const TICK_MS = 20_000;

export function useAlarmReminderWatcher(): void {
    const router = useRouter();
    const pathname = usePathname();
    /** 本会话已处理过的通知 response identifier（warm 订阅与冷启探测互斥去重）。 */
    const handledResponseIds = useRef<Set<string>>(new Set());
    const pathnameRef = useRef(pathname);
    pathnameRef.current = pathname;

    useEffect(() => {
        if (Platform.OS === 'web') return;

        const pushAlarm = (id: string, at: number): void => {
            // 去重/在场判定收口到 alarm-ladder.shouldPresentAlarm + 共享会话账
            // （纯函数与账都在 ladder，tests/alarm-ladder 有契约用例）。共享账而
            // 非本 hook 局部集：页内检查/全屏屏出口与本 watcher 是同一「本会话
            // 已处理」语义的三个_writer_，任一路换页卸载都不能带走自己的局部账
            // （v0.5.1 复响回路推演结论）；at 作指纹，重排闹钟天然重新在场。
            if (!shouldPresentAlarm(id, at, pathnameRef.current ?? '')) return;
            markAlarmHandled(id, at);
            // v0.5.1 真机纠错（『关闭后依然有声音』根因之一）：push 改 replace。
            // 冷启深链直达 /alarm/<id> 时，本 hook 首帧 pathnameRef 可能还是
            // 占位 '/'——drainFired/tick 判定「不在闹钟屏」把**同一 id 再 push
            // 一张** /alarm 屏，栈里叠两层全屏屏；用户在顶层点「确认停止」只
            // 拆掉顶层（replace），底下那张仍挂载、loop 播放器仍在响 = 「关掉
            // 还有声音」。replace 让任意时刻最多一张闹钟屏（真到第二个不同
            // 闹钟时替换旧屏也符合「一次只处理一个响铃」的产品语义）。
            // 路径参数（非 query）：typedRoutes 动态段形态，三端一致。
            router.replace({ pathname: '/alarm/[id]', params: { id } });
        };

        const drain = async (): Promise<void> => {
            const fired = await alarm.drainFired();
            for (const entry of fired) pushAlarm(entry.id, entry.at);
        };

        const tick = async (): Promise<void> => {
            if (Platform.OS === 'android') {
                // 非精确档软计时：原生注册表已到点条目（精确档由接收器到场，
                // drainFired 同拍收账，两条路径共享账天然去重）
                const scheduled = await alarm.listScheduled();
                const due = pickDueEntries(scheduled, Date.now());
                for (const entry of due) pushAlarm(entry.id, entry.at);
                // v0.5.2 令3：同拍顺带刷常驻监控通知（app 存活期间计数/最近
                // 时刻保鲜；「全部过点即停」在进程活着时靠这条通道收口——
                // 进程死了还有 AlarmManager 到点 + 接收器 sync / boot / sticky
                // 三层原生兜底，JS 不在场监控面也不裸奔）
                void refreshAlarmMonitor(scheduled);
            } else {
                // iOS：扫已调度本地通知（date trigger 到点 = 前台拉起全屏屏）
                try {
                    const ExpoNotifications = await import('expo-notifications');
                    const pending = await ExpoNotifications.getAllScheduledNotificationsAsync();
                    for (const request of pending) {
                        const itemId = itemIdFromNotificationId(request.identifier);
                        if (!itemId) continue;
                        // date trigger 运行时形态（SDK 58：{ date } 落在 trigger 对象上）
                        const trigger = request.trigger as { date?: Date | number } | undefined;
                        const raw = trigger?.date;
                        const at = raw instanceof Date ? raw.getTime() : typeof raw === 'number' ? raw : undefined;
                        if (at == null || at > Date.now()) continue;
                        pushAlarm(itemId, at);
                        // 撤销系统通知：前台全屏屏已接管，不再横幅重复打扰
                        void ExpoNotifications.cancelScheduledNotificationAsync(request.identifier).catch(
                            () => {
                                // 已触发出表：幂等无操作，静默
                            },
                        );
                    }
                } catch (error) {
                    console.warn('[alarm-watcher] iOS 调度扫描失败:', error);
                }
            }
        };

        // ─── v0.5.1 令 2/3：通知 tap → 全屏闹钟屏（本地通知兜底档的「进 app」腿）───
        // store 调度把 data.path（alarmRoutePath 构造）写进通知 content，本函数是
        // 其唯一消费者；此前无人接 response，iOS 兜底通知「只响不可进」。identifier
        // 会话级去重：冷启 getLastResponse 探测与 warm 订阅不会双跳。
        const routeAlarmNotification = async (
            identifier: string,
            path: unknown,
        ): Promise<void> => {
            if (typeof path !== 'string') return;
            const itemId = itemIdFromAlarmPath(path);
            if (itemId == null || handledResponseIds.current.has(identifier)) return;
            handledResponseIds.current.add(identifier);
            if (Platform.OS === 'android') {
                // Android 双保险：注册表仍有该条目才接——已「停止/确认」出账的
                // 陈旧 tap intent 不得把静音过的闹钟再拉起来；到点未确认条目
                // 恒在注册表（出账唯一入口 cancel/confirm，AlarmScheduler 注）。
                // 接收器常驻通知的 tap 走 URL 深链（expo-router 原生承接），不经此。
                if (isAlarmSettled(itemId, await alarm.listScheduled())) return;
            }
            // 确认 = 出账（跨平台单源）：本会话用户亲手停过的提醒，点陈旧
            // 通知也不得再进铃屏（native 已撤通知、iOS notification 可能滞留，
            // JS 账是最后闸）。
            if (isAlarmConfirmed(itemId)) return;
            // 其余 tap = 用户显式意图，绕过「已拉起未确认」的抢占标记直接呈现
            // （watcher 自动展示过一次但用户没停时，再点通知本就该再响；挡入口
            // 只剩「已在闹钟屏」的 pathname 在场判定与上面的确认账）。
            if ((pathnameRef.current ?? '').startsWith(ALARM_ROUTE)) return;
            router.replace({ pathname: '/alarm/[id]', params: { id: itemId } });
        };

        const responseSub = notifications.onResponse((response) => {
            void routeAlarmNotification(
                response.notification.request.identifier,
                response.notification.request.content.data?.path,
            );
        });

        void drain();
        // v0.5.2 令3：挂载即刷一次常驻监控（hydration/冷启对齐——store.loadAll
        // 尾部同款 poke，双通道幂等；iOS/web 门面内 no-op）
        void refreshAlarmMonitor();
        // 冷启由通知 tap 拉起（进程未活）：response 不进订阅，挂载探测一次
        void (async () => {
            try {
                const ExpoNotifications = await import('expo-notifications');
                // SDK 58 实名 getLastNotificationResponseAsync（NotificationsEmitter 出口）
                const last = await ExpoNotifications.getLastNotificationResponseAsync();
                if (!last) return;
                await routeAlarmNotification(
                    last.notification.request.identifier,
                    last.notification.request.content.data?.path,
                );
            } catch (error) {
                // 通道缺失（模块未装/平台差异）：tap 呈现退为打开 app 首页——
                // 兜底通知本身已在场（令 2「必有通知」不受此影响），留痕即可
                console.warn('[alarm-watcher] 冷启通知 response 读取失败:', error);
            }
        })();

        const timer = setInterval(() => void tick(), TICK_MS);
        const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
            // 回前台：补收 fired 账 + 收敛冻结期间过点造成的陈旧监控计数
            if (state === 'active') {
                void drain();
                void refreshAlarmMonitor();
            }
        });
        return () => {
            clearInterval(timer);
            sub.remove();
            responseSub.remove();
        };
    }, [router]);
}
