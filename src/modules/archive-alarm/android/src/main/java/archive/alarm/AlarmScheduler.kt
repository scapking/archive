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
 * 持久化：SharedPreferences 双表——`alarms`（待触发注册表：BOOT_COMPLETED
 * 重排、到点接收器读文案、JS listScheduled 软计时都靠它）与 `fired`
 * （v0.4.7 到点未确认账本：drainFired/confirm 的呈现链路）。BroadcastReceiver
 * 没有 React 上下文，不能问 JS 要数据，两表都是原生自持。
 *
 * 精确性：Android 12+ 受 SCHEDULE_EXACT_ALARM 管制，canScheduleExactAlarms()
 * 为 false 时降级 setAndAllowWhileIdle（非精确但必达），不抛错不阻塞。
 */
internal object AlarmScheduler {
    private const val PREFS = "archive-alarms"
    private const val KEY_ALARMS = "alarms"
    /** v0.4.7 fired 账本：到点已触发、尚未被 app 内全屏闹钟确认的条目。
     *  接收器落账 + 常驻通知；JS drain 后拉起全屏闹钟屏；confirm 清账。 */
    private const val KEY_FIRED = "fired"
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

    /** 取消（幂等：注册表无该 id 时 PendingIntent.cancel 也是无操作）。
     *  同拍清 fired 账与呈现面（常驻通知/保活服务）——行程项被删后
     *  「该响的闹钟」整体消失，不留孤儿通知。 */
    fun cancel(context: Context, id: String) {
        val alarms = readAll(context)
        alarms.remove(id)
        writeAll(context, alarms)
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.cancel(pendingIntent(context, id))
        removeFired(context, id)
        AlarmFireReceiver.dismiss(context, id)
    }

    // ─── fired 账本（v0.4.7：到点未确认 → app 内全屏闹钟）──────────────────

    private fun readFired(context: Context): JSONObject {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return JSONObject(prefs.getString(KEY_FIRED, "{}") ?: "{}")
    }

    private fun writeFired(context: Context, fired: JSONObject) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_FIRED, fired.toString())
            .apply()
    }

    /** 接收器到点落账（保留计划时刻 at，附 firedAt；文案快照自注册表）。 */
    fun markFired(context: Context, id: String, at: Long, title: String, body: String) {
        val fired = readFired(context)
        fired.put(
            id,
            JSONObject()
                .put("at", at)
                .put("firedAt", System.currentTimeMillis())
                .put("title", title)
                .put("body", body),
        )
        writeFired(context, fired)
    }

    /** 读取即清账（JS watcher / 冷启拉起用）。 */
    fun drainFired(context: Context): List<Map<String, Any>> {
        val entries = entries(readFired(context))
        if (entries.isNotEmpty()) writeFired(context, JSONObject())
        return entries
    }

    /** 确认出口清账（confirm(id) 用；幂等）。 */
    fun removeFired(context: Context, id: String) {
        val fired = readFired(context)
        if (fired.has(id)) {
            fired.remove(id)
            writeFired(context, fired)
        }
    }

    /** 待触发注册表回读（非精确档软计时数据源）。不清账：at 已过的条目可能
     *  只是非精确延迟未到（AlarmManager 仍会回调接收器），注册表是接收器读
     *  文案的数据源，删除只剩兜底文案；出账统一走 cancel/confirm。 */
    fun listScheduled(context: Context): List<Map<String, Any>> = entries(readAll(context))

    private fun entries(table: JSONObject): List<Map<String, Any>> {
        val out = ArrayList<Map<String, Any>>()
        val keys = table.keys()
        while (keys.hasNext()) {
            val id = keys.next()
            val entry = table.optJSONObject(id) ?: continue
            out.add(
                mapOf(
                    "id" to id,
                    "at" to entry.optLong("at", 0L),
                    "title" to entry.optString("title", ""),
                    "body" to entry.optString("body", ""),
                ),
            )
        }
        return out
    }

    /** 常驻监控摘要（v0.5.2 令3）：仍「未到点」（at > now）的待触发条目数与
     *  最近时刻；无 = null（常驻通知即停）。与 rescheduleAll 的过期口径同源：
     *  已到点条目虽滞留注册表等待确认出账，但不再属于「监控中」。 */
    fun pendingSummary(context: Context, now: Long): Pair<Int, Long>? {
        val alarms = readAll(context)
        var count = 0
        var nearest = Long.MAX_VALUE
        val keys = alarms.keys()
        while (keys.hasNext()) {
            val entry = alarms.optJSONObject(keys.next()) ?: continue
            val at = entry.optLong("at", 0L)
            if (at <= now) continue
            count += 1
            if (at < nearest) nearest = at
        }
        return if (count == 0) null else Pair(count, nearest)
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