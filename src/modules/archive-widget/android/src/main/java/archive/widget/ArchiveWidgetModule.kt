package archive.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/**
 * widget 数据推送入口（JS → 原生）：快照落 SharedPreferences 后触发全部
 * 已放置 widget 重渲；并（v0.4.7）按快照内未来的 dueAt 挂自刷新广播——
 * pending→ongoing→done 是纯时间派生档，到点即重渲，不坐 30min 兜底
 * （setAndAllowWhileIdle 非精确即可：分钟级精度对阶段徽章足够，也免占用
 * 精确闹钟配额；done/wrap/terminal 是 DB 持久态由 push 覆盖，不需自刷）。
 */
class ArchiveWidgetModule : Module() {
    private val context: Context?
        get() = appContext.reactContext

    override fun definition() = ModuleDefinition {
        Name("HomeWidget")

        AsyncFunction("push") { snapshotJson: String, promise: Promise ->
            val ctx = context
            if (ctx == null) {
                promise.reject(CodedException("ERR_NO_CONTEXT", "Android context unavailable", null))
                return@AsyncFunction
            }
            try {
                WidgetDataStore.save(ctx.applicationContext, snapshotJson)
                ArchiveWidgetProvider.renderAll(ctx.applicationContext)
                schedulePhaseRefresh(ctx.applicationContext, snapshotJson)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject(CodedException("ERR_PUSH", e.message, e))
            }
        }
    }

    /**
     * 为每个未来 pending/ongoing 项挂两个时点刷新（dueAt = 进 ongoing 边界、
     * dueAt + DONE_WINDOW = 出 ongoing 边界），request code 逐项唯一互不覆盖；
     * 上限 [MAX_REFRESH_ALARMS] 防极端长列表堆闹钟。
     */
    private fun schedulePhaseRefresh(context: Context, snapshotJson: String) {
        try {
            val items = JSONObject(snapshotJson).optJSONArray("items") ?: return
            val now = System.currentTimeMillis()
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            var scheduled = 0
            for (i in 0 until items.length()) {
                if (scheduled >= MAX_REFRESH_ALARMS) break
                val item = items.optJSONObject(i) ?: continue
                val dueAt = item.optLong("dueAt", 0L)
                val status = item.optString("status", "pending")
                if (dueAt <= now || (status != "pending" && status != "ongoing")) continue
                // 进 ongoing 边界（dueAt 已过 = 只挂出边界；dueAt>now 两个都挂）
                if (dueAt > now) {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, dueAt, refreshIntent(context, i * 2))
                    scheduled += 1
                }
                val exitAt = dueAt + DONE_WINDOW_MS
                if (exitAt > now) {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, exitAt, refreshIntent(context, i * 2 + 1))
                    scheduled += 1
                }
            }
        } catch (e: Exception) {
            // 刷新闹钟是渲染增强：失败静默，30min updatePeriodMillis 兜底
            Log.w(TAG, "widget phase refresh scheduling failed", e)
        }
    }

    private fun refreshIntent(context: Context, requestCode: Int): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            REFRESH_REQUEST_CODE_BASE + requestCode,
            Intent(context, ArchiveWidgetProvider::class.java)
                .setAction(ArchiveWidgetProvider.ACTION_REFRESH),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    companion object {
        private const val REFRESH_REQUEST_CODE_BASE = 7300
        private const val MAX_REFRESH_ALARMS = 8
        /** 与 ArchiveWidgetProvider.DONE_WINDOW_MS / JS trip-item-logic 同值镜像。 */
        private const val DONE_WINDOW_MS = 30 * 60_000L
        private const val TAG = "archive-widget"
    }
}
