package archive.widget

import android.content.Context
import org.json.JSONObject

/**
 * Widget 数据快照（JS 推 JSON 字符串，原样落 SharedPreferences）：
 * { tripId, tripTitle, items: [{time, title, phase}, ...≤4] }。
 * AppWidgetProvider 渲染与点击深链都从这里读。
 */
internal object WidgetDataStore {
    private const val PREFS = "archive-widget"
    private const val KEY_SNAPSHOT = "snapshot"

    fun save(context: Context, snapshotJson: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SNAPSHOT, snapshotJson)
            .apply()
    }

    fun read(context: Context): JSONObject =
        JSONObject(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SNAPSHOT, "{}") ?: "{}")
}