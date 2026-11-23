package archive.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONObject

/**
 * 系统精确闹钟的注册表 + AlarmManager 封装。
 *
 * 持久化：SharedPreferences 存 id → {at, title, body} 的 JSON 表——
 * BOOT_COMPLETED 重排与到点接收器读文案都靠它（BroadcastReceiver 没有
 * React 上下文，不能问 JS 要数据）。
 *
 * 精确性：Android 12+ 受 SCHEDULE_EXACT_ALARM 管制，canScheduleExactAlarms()
 * 为 false 时降级 setAndAllowWhileIdle（非精确但必达），不抛错不阻塞。
 */
internal object AlarmScheduler {
    private const val PREFS = "archive-alarms"
    private const val KEY_ALARMS = "alarms"
    private const val TAG = "archive-alarm"

    /** 到点接收器的 PendingIntent（request code = id hash，唯一可寻址）。 */
    fun pendingIntent(context: Context, id: String): PendingIntent {
        val intent = Intent(context, AlarmFireReceiver::class.java)
            .setAction(AlarmFireReceiver.ACTION_FIRE)
            .putExtra(AlarmFireReceiver.EXTRA_ID, id)
        return PendingIntent.getBroadcast(
            context,
            id.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun readAll(context: Context): JSONObject {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return JSONObject(prefs.getString(KEY_ALARMS, "{}") ?: "{}")
    }

    private fun writeAll(context: Context, alarms: JSONObject) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ALARMS, alarms.toString())
            .apply()
    }

    /** 注册并持久化（同一 id 重复 schedule = 更新文案与时刻）。 */
    fun schedule(context: Context, id: String, at: Long, title: String, body: String) {
        val alarms = readAll(context)
        alarms.put(
            id,
            JSONObject().put("at", at).put("title", title).put("body", body),
        )
        writeAll(context, alarms)
        set(context, id, at)
    }

    private fun set(context: Context, id: String, at: Long) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = pendingIntent(context, id)
        if (canExact(context)) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }
    }

    /** 取消（幂等：注册表无该 id 时 PendingIntent.cancel 也是无操作）。 */
    fun cancel(context: Context, id: String) {
        val alarms = readAll(context)
        alarms.remove(id)
        writeAll(context, alarms)
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.cancel(pendingIntent(context, id))
    }

    /** 开机/时区变化后重排：丢弃已过期项，未触发的逐个重新注册。 */
    fun rescheduleAll(context: Context) {
        val alarms = readAll(context)
        val now = System.currentTimeMillis()
        val keep = JSONObject()
        val keys = alarms.keys()
        while (keys.hasNext()) {
            val id = keys.next()
            val entry = alarms.optJSONObject(id) ?: continue
            val at = entry.optLong("at", 0L)
            if (at <= now) continue
            keep.put(id, entry)
            try {
                set(context, id, at)
            } catch (e: Exception) {
                Log.w(TAG, "reschedule failed: $id", e)
            }
        }
        writeAll(context, keep)
    }

    /** 精确闹钟能力（Android 12 前恒可用）。 */
    fun canExact(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 31) return true
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return am.canScheduleExactAlarms()
    }
}