import { useEffect, useRef } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { alarm } from '@/core/alarm';
import { itemIdFromNotificationId, pickDueEntries } from './alarm-ladder';

/**
 * 闹钟提醒 watcher（v0.4.7 用户令 #2/#3 的 JS 侧薄层；接线由主控在
 * app/_layout.tsx 挂载——一行 hook，见交付报告接线清单）。
 *
 * 职责 = 「到点后把在场 app 拉进全屏闹钟屏」：
 * - Android：冷启/回前台 drainFired（full-screen intent 之外的兜底——用户从
 *   最近任务/桌面图标进 app 也补拉起）；每 20s 软计时扫原生注册表，非精确档
 *   （SCHEDULE_EXACT_ALARM 被拒）到点即推 /alarm/<id>；
 * - iOS：无系统闹钟、后台无法拉起全屏（能力边界如实）——前台期间扫
 *   expo-notifications 已调度列表（identifier `trip-item-<id>`），到点即推
 *   全屏屏并撤销该通知（避免进屏后系统横幅重复打扰）。
 *
 * 全屏屏自身负责确认停止（alarm.confirm 清账），watcher 只做「发现到点、
 * 只推一次」——presented 集防同会话重复推送；已在 /alarm 路由则不推。
 */

/** 软计时节拍（ms）：20s 对「分钟级」行程时刻足够（同 trip-day 15s 口径量级）。 */
const TICK_MS = 20_000;

export function useAlarmReminderWatcher(): void {
    const router = useRouter();
    const pathname = usePathname();
    /** 本会话已拉起过的闹钟 id（防重复 push；确认清账后条目自然消失）。 */
    const presented = useRef<Set<string>>(new Set());
    const pathnameRef = useRef(pathname);
    pathnameRef.current = pathname;

    useEffect(() => {
        if (Platform.OS === 'web') return;

        const pushAlarm = (id: string): void => {
            if (presented.current.has(id)) return;
            if ((pathnameRef.current ?? '').startsWith('/alarm')) return;
            presented.current.add(id);
            // 路径参数（非 query）：typedRoutes 动态段形态，三端一致
            router.push({ pathname: '/alarm/[id]', params: { id } });
        };

        const drain = async (): Promise<void> => {
            const fired = await alarm.drainFired();
            for (const entry of fired) pushAlarm(entry.id);
        };

        const tick = async (): Promise<void> => {
            if (Platform.OS === 'android') {
                // 非精确档软计时：原生注册表已到点条目（精确档由接收器到场，
                // drainFired 同拍收账，两条路径 presented 集天然去重）
                const due = pickDueEntries(await alarm.listScheduled(), Date.now());
                for (const entry of due) pushAlarm(entry.id);
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
                        pushAlarm(itemId);
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

        void drain();
        const timer = setInterval(() => void tick(), TICK_MS);
        const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
            if (state === 'active') void drain();
        });
        return () => {
            clearInterval(timer);
            sub.remove();
        };
    }, [router]);
}
