import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * archive-alarm 原生模块的 TS 面（Android only）：iOS/web 构建里模块不存在，
 * requireOptionalNativeModule 返回 null——调用方（core/alarm 门面）按
 * unsupported 降级，绝不抛错。
 */
export interface ArchiveAlarmNativeModule {
    /** 注册精确闹钟（AlarmManager.setExactAndAllowWhileIdle；持久化到
     *  SharedPreferences 供 BOOT_COMPLETED 重排）。 */
    schedule(id: string, at: number, title: string, body: string): Promise<void>;
    /** 取消闹钟（幂等：无对应注册视为成功）。 */
    cancel(id: string): Promise<void>;
    /** 精确闹钟 + 通知权限的综合判定：granted / denied / unsupported。 */
    permission(): Promise<'granted' | 'denied' | 'unsupported'>;
    /** 待触发注册表回读：[{id, at, title, body}]（v0.4.7 软计时数据源）。 */
    listScheduled(): Promise<{ id: string; at: number; title: string; body: string }[]>;
    /** 已触发未确认账本，读取即清账（v0.4.7 全屏闹钟拉起数据源）。 */
    drainFired(): Promise<{ id: string; at: number; title: string; body: string }[]>;
    /** 确认停止：移除常驻通知 + 停保活前台服务 + 清 fired 账（v0.4.7）。 */
    confirm(id: string): Promise<void>;
}

export default requireOptionalNativeModule<ArchiveAlarmNativeModule>('ArchiveAlarm');