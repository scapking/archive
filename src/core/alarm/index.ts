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
 */

type SystemAlarmNative = {
    schedule(id: string, at: number, title: string, body: string): Promise<void>;
    cancel(id: string): Promise<void>;
    permission(): Promise<'granted' | 'denied' | 'unsupported'>;
};

const native = Platform.OS === 'android'
    ? requireOptionalNativeModule<SystemAlarmNative>('SystemAlarm')
    : null;

export interface AlarmScheduleInput {
    /** 闹钟 id（与通知 identifier 同源：`trip-item-<itemId>`，取消共用）。 */
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

    /** 取消闹钟（幂等 best-effort：模块缺失/异常静默，仅 warn 留痕）。 */
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
};