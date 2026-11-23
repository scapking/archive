package archive.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 开机重排：重启后 AlarmManager 注册全部丢失（易失），按持久化注册表逐条
 * 重新注册（已过期项丢弃）。
 */
class BootRescheduleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            AlarmScheduler.rescheduleAll(context.applicationContext)
        }
    }
}