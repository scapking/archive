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
}

export default requireOptionalNativeModule<ArchiveAlarmNativeModule>('ArchiveAlarm');