package archive.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 开机重排：重启后 AlarmManager 注册全部丢失（易失），按持久化注册表逐条
 * 重新注册（已过期项丢弃）。
 *
 * v0.5.2 令3 同拍恢复常驻监控通知：BOOT_COMPLETED 是 Android 12+ 后台启动
 * FGS 的豁免广播（sync 内部再兜 try/catch），注册表仍有 pending 时直接由
 * 原生重建「N 个行程提醒监控中」状态行（文案自算，不依赖 JS 在场）。
 */
class BootRescheduleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            val app = context.applicationContext
            AlarmScheduler.rescheduleAll(app)
            AlarmMonitorService.sync(app)
        }
    }
}