import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * 系统闹钟门面（v0.4.4，用户指令 #9/#11）：
 *
 * - Android = 真系统闹钟（本地 alarm 模块，AlarmManager 精确闹钟 +
 *   到点全屏 intent 响铃通知；技术事实：第三方 app 无法往系统时钟 app 的
 *   闹钟列表里插条目——那是时钟 app 私有库，AlarmManager + 全屏呈现是
 *   「真闹钟」的全部可行面，brainstorming 已向用户说明并接受）；
 * - iOS = unsupported（无第三方加闹钟 API；强提醒走 store 既有本地通知链
 *   的 timeSensitive 升级，见 scheduleTripItemNotification）；
 * - web = unsupported。
 *
 * 契约：本门面**绝不 throw**——闹钟是提醒增强，不是数据完整性依赖
 * （scheduleTripItemNotification 同款 best-effort 口径）：模块缺失/调度失败
 * 返回 false 并 console.warn 留痕，调用方照常落库。
 *
 * v0.4.7 阶梯扩展（用户令 #2/#3）：接收器到点 = 全屏 intent 深链
 * `<scheme>://alarm/<id>`（scheme 由 app.json 定义）+ 常驻通知（ongoing
 * notification + 前台服务保活，
 * 通知动作「停止」= confirm 出口）；JS 侧 listScheduled（注册表回读，非精确
 * 档的软计时数据源）/ drainFired（已触发未确认账本）/ confirm（确认后移除
 * 通知停服务）。呈现编排（全屏闹钟屏）在 features 层，本门面只提供能力面。
 * iOS 能力边界如实：无第三方闹钟 API、后台无法拉起全屏 UI，到点呈现=
 * timeSensitive 本地通知 + 前台全屏屏。
 */

type SystemAlarmNative = {
    schedule(id: string, at: number, title: string, body: string): Promise<void>;
    cancel(id: string): Promise<void>;
    permission(): Promise<'granted' | 'denied' | 'unsupported'>;
    listScheduled(): Promise<FiredAlarmEntry[]>;
    drainFired(): Promise<FiredAlarmEntry[]>;
    confirm(id: string): Promise<void>;
};

/**
 * 到点记录/注册表条目（Android SharedPreferences 回传；JS 侧 watcher 据此
 * 在 app 存活/回前台时拉起全屏闹钟屏——「到点后若该卡片有提醒，在 app 内
 * 拉起全屏闹钟 UI」的用户令）。
 */
export interface FiredAlarmEntry {
    id: string;
    /** 计划触发时刻（epoch ms）。 */
    at: number;
    title: string;
    body: string;
}

const native = Platform.OS === 'android'
    ? requireOptionalNativeModule<SystemAlarmNative>('SystemAlarm')
    : null;

export interface AlarmScheduleInput {
    /** 闹钟 id（调用方自有约定；行程项用 itemId 本体——schedule/cancel 同一
     *  值即可，无需与通知 identifier `trip-item-<itemId>` 对齐）。 */
    id: string;
    /** 触发时刻（epoch ms）。 */
    at: number;
    title: string;
    body: string;
}

export type AlarmPermission = 'granted' | 'denied' | 'unsupported';

export const alarm = {
    /** 平台是否具备真闹钟能力（Android 且原生模块已链接）。 */
    isSupported(): boolean {
        return native != null;
    },

    /**
     * 注册系统闹钟：成功 true；模块缺失（iOS/web）、时刻已过、调度异常一律
     * false + warn 留痕（调用方无需区分降级形态——本地通知链独立在场）。
     */
    async schedule(input: AlarmScheduleInput): Promise<boolean> {
        if (native == null) return false;
        if (input.at <= Date.now()) {
            console.warn('[alarm] 闹钟时刻已过，跳过注册（id: %s）', input.id);
            return false;
        }
        try {
            await native.schedule(input.id, input.at, input.title, input.body);
            return true;
        } catch (error) {
            console.warn('[alarm] 闹钟注册失败（不阻塞调用方，id: %s）:', input.id, error);
            return false;
        }
    },

    /** 取消闹钟（幂等 best-effort：模块缺失/异常静默，仅 warn 留痕；
     *  v0.4.7 起原生侧同拍清理 fired 账与常驻通知/保活服务的呈现面）。 */
    async cancel(id: string): Promise<void> {
        if (native == null) return;
        try {
            await native.cancel(id);
        } catch (error) {
            console.warn('[alarm] 闹钟取消失败（id: %s）:', id, error);
        }
    },

    /** 综合权限判定（模块缺失 = unsupported）。 */
    async permission(): Promise<AlarmPermission> {
        if (native == null) return 'unsupported';
        try {
            return await native.permission();
        } catch (error) {
            console.warn('[alarm] 权限查询失败:', error);
            return 'denied';
        }
    },

    /**
     * 当前仍待触发的闹钟注册表（id/at/title/body；Android 原生持久化表回读）。
     * 模块缺失/失败 = []（watcher 软计时数据源，best-effort）。
     */
    async listScheduled(): Promise<FiredAlarmEntry[]> {
        if (native == null) return [];
        try {
            return (await native.listScheduled()) ?? [];
        } catch (error) {
            console.warn('[alarm] 注册表读取失败:', error);
            return [];
        }
    },

    /**
     * 取走「到点已触发但尚未被 app 确认」的闹钟（读取即清账）。接收器到点
     * 落 fired 表 + 常驻通知；JS 侧 drain 后拉起全屏闹钟屏，用户确认后
     * confirm(id) 移除常驻通知/前台服务。失败/缺失 = []。
     */
    async drainFired(): Promise<FiredAlarmEntry[]> {
        if (native == null) return [];
        try {
            return (await native.drainFired()) ?? [];
        } catch (error) {
            console.warn('[alarm] fired 读取失败:', error);
            return [];
        }
    },

    /**
     * 确认停止（v0.4.7 阶梯出口）：移除该闹钟的常驻通知并停掉保活前台服务、
     * 清 fired 账——「须手动确认停止，确认后移除」语义的原生侧收口。
     * 幂等 best-effort（未触发过/已确认 = 无操作；iOS/web no-op）。
     */
    async confirm(id: string): Promise<void> {
        if (native == null) return;
        try {
            await native.confirm(id);
        } catch (error) {
            console.warn('[alarm] 确认停止失败（id: %s）:', id, error);
        }
    },
};