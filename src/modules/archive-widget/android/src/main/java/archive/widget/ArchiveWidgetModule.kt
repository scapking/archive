package archive.widget

import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * widget 数据推送入口（JS → 原生）：快照落 SharedPreferences 后触发全部
 * 已放置 widget 重渲。
 */
class ArchiveWidgetModule : Module() {
    private val context: Context?
        get() = appContext.reactContext

    override fun definition() = ModuleDefinition {
        Name("ArchiveWidget")

        AsyncFunction("push") { snapshotJson: String, promise: Promise ->
            val ctx = context
            if (ctx == null) {
                promise.reject(CodedException("ERR_NO_CONTEXT", "Android context unavailable"))
                return@AsyncFunction
            }
            try {
                WidgetDataStore.save(ctx.applicationContext, snapshotJson)
                ArchiveWidgetProvider.renderAll(ctx.applicationContext)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject(CodedException("ERR_PUSH", e.message, e))
            }
        }
    }
}