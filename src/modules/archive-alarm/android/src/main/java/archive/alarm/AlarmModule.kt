package archive.alarm

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * archive-alarm 的 Expo 模块入口（JS → 原生）：schedule / cancel / permission。
 *
 * 模块名 `SystemAlarm`（业务中立，H5 core 纯净约束见 layering.md L2——core 门面
 * 只认中立名，本目录名与包名不受该约束）。Android-only：iOS/web 构建不含本
 * 类，JS 侧 requireOptionalNativeModule 返回 null 走 unsupported 降级。
 *
 * 异常语义：调度失败向上抛（promise reject），由 core/alarm 门面 catch 后
 * warn 降级——门面契约「绝不 throw」，数据面照常落库。
 */
class AlarmModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("SystemAlarm")

        AsyncFunction("schedule") { id: String, at: Double, title: String, body: String ->
            val ctx = appContext.reactContext
                ?: throw IllegalStateException("Android context unavailable")
            AlarmScheduler.schedule(ctx, id, at.toLong(), title, body)
        }

        AsyncFunction("cancel") { id: String ->
            val ctx = appContext.reactContext
                ?: throw IllegalStateException("Android context unavailable")
            AlarmScheduler.cancel(ctx, id)
        }

        /** 精确闹钟 + 通知权限综合判定：granted / denied / unsupported。 */
        AsyncFunction("permission") {
            val ctx = appContext.reactContext
            if (ctx == null) {
                "unsupported"
            } else if (!AlarmScheduler.canExact(ctx)) {
                "denied"
            } else if (Build.VERSION.SDK_INT >= 33 && !hasNotificationPermission(ctx)) {
                "denied"
            } else {
                "granted"
            }
        }
    }

    private fun hasNotificationPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
}
