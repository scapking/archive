package archive.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject

/**
 * 桌面 widget（Android AppWidget，RemoteViews 静态行渲染）：
 *
 * 数据 = JS 侧 push 的快照（WidgetDataStore），**不是固定的题式工具**——
 * 快照由 store 按「自动选最新行程 + 其行程项列表」编排（core/widget 契约），
 * 到点/换行程由显式 push 与 30min 周期重渲覆盖。点卡 = archive://trip/<id>
 * 深链进行程页（expo-router scheme）。
 */
class ArchiveWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        renderAll(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) renderAll(context)
    }

    companion object {
        const val ACTION_REFRESH = "archive.widget.REFRESH"
        private const val TAG = "archive-widget"

        /** 全部已放置 widget 重渲（快照缺失 = 空态文案，不崩）。 */
        fun renderAll(context: Context) {
            try {
                val manager = AppWidgetManager.getInstance(context) ?: return
                val ids = manager.getAppWidgetIds(
                    ComponentName(context, ArchiveWidgetProvider::class.java),
                )
                if (ids.isEmpty()) return
                val views = buildViews(context)
                for (id in ids) manager.updateAppWidget(id, views)
            } catch (e: Exception) {
                Log.w(TAG, "widget render failed", e)
            }
        }

        private fun buildViews(context: Context): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.archive_widget)
            val snapshot = runCatching { WidgetDataStore.read(context) }.getOrDefault(JSONObject())
            val tripId = snapshot.optString("tripId", "")
            val tripTitle = snapshot.optString("tripTitle", "")
            val items = snapshot.optJSONArray("items")
            val hasTrip = tripId.isNotEmpty()

            views.setTextViewText(
                R.id.widget_trip_title,
                if (hasTrip && tripTitle.isNotEmpty()) tripTitle else "行程",
            )
            views.setViewVisibility(R.id.widget_empty, if (hasTrip) View.GONE else View.VISIBLE)

            // 点击深链（有行程才挂）：archive://trip/<id> → expo-router 行程页
            if (hasTrip) {
                val launch = Intent(Intent.ACTION_VIEW, Uri.parse("archive://trip/$tripId"))
                    .setPackage(context.packageName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                views.setOnClickPendingIntent(
                    R.id.widget_root,
                    PendingIntent.getActivity(
                        context,
                        0,
                        launch,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    ),
                )
            }

            val rowCount = 4
            for (row in 0 until rowCount) {
                val rowId = when (row) {
                    0 -> R.id.widget_row_0
                    1 -> R.id.widget_row_1
                    2 -> R.id.widget_row_2
                    else -> R.id.widget_row_3
                }
                val timeId = when (row) {
                    0 -> R.id.widget_row_0_time
                    1 -> R.id.widget_row_1_time
                    2 -> R.id.widget_row_2_time
                    else -> R.id.widget_row_3_time
                }
                val titleId = when (row) {
                    0 -> R.id.widget_row_0_title
                    1 -> R.id.widget_row_1_title
                    2 -> R.id.widget_row_2_title
                    else -> R.id.widget_row_3_title
                }
                val item = if (items != null && row < items.length()) items.optJSONObject(row) else null
                if (item == null) {
                    views.setViewVisibility(rowId, View.GONE)
                    continue
                }
                views.setViewVisibility(rowId, View.VISIBLE)
                views.setTextViewText(timeId, item.optString("time", ""))
                views.setTextViewText(titleId, item.optString("title", ""))
            }
            return views
        }

    }
}