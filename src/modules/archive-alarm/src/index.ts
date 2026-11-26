import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * archive-alarm 原生模块的 TS 面（Android only）：iOS/web 构建里模块不存在，
 * requireOptionalNativeModule 返回 null——调用方（core/alarm 门面）按
 * unsupported 降级，绝不抛错。
 *
 * v0.5.3 命名纠错：require 名曾是 'ArchiveAlarm'，与 Kotlin 侧
 * `Name("SystemAlarm")` 不一致——本门面任何平台都拿不到模块（潜伏死门面，
 * core/alarm 直连 'SystemAlarm' 才让闹钟链活到今天）。单一事实源 = Kotlin
 * Name，本文件随之收口；tests/alarm-android-source 正则闸锁两端一致。
 */
export interface ReminderPermissionStatus {
    /** 精确闹钟可调度（Android 12 前恒 true）。 */
    exactAlarms: boolean;
    /** 全屏通知已授予（Android 14 前恒 true——无用户授予面）。 */
    fullScreen: boolean;
    /** true = 仍受电池优化（未豁免）。Android 6 前恒 false。 */
    batteryOptimized: boolean;
}

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
    /** 常驻监控通知刷新（v0.5.2 用户令3）：start/stop 判据 = 原生注册表
     *  pending 集合（at > now 非空起、空停），title/body 传空 = 原生自算
     *  「N 个行程提醒监控中 · 最近 HH:mm」（boot/sticky 重入同款文案）。 */
    syncMonitor(title: string, body: string): Promise<void>;
    /** 提醒链路三项系统权限状态（v0.5.3 真机纠错，语义见字段注）。 */
    reminderPermissionStatus(): Promise<ReminderPermissionStatus>;
    /** 跳系统「精确闹钟」授权页（Android 12+；已授予也可直接跳）。 */
    openExactAlarmSettings(): Promise<boolean>;
    /** 跳系统「全屏通知」授权页（Android 14+；低版本落 app 通知设置）。 */
    openFullScreenSettings(): Promise<boolean>;
    /** 申请电池优化豁免（已豁免幂等 true；厂商 ROM 拒绝 = false 不抛）。 */
    requestIgnoreBatteryOptimizations(): Promise<boolean>;
    /** 锁屏呈现面开关（v0.5.3 根因 5）：全屏闹钟屏挂载 true / 卸载 false。 */
    setLockScreenSurface(enabled: boolean): Promise<boolean>;
}

export default requireOptionalNativeModule<ArchiveAlarmNativeModule>('SystemAlarm');
