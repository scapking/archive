package archive.alarm

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.WindowManager
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

        /** 待触发注册表回读（v0.4.7 软计时数据源；过期项由调度器顺带剔除）。 */
        AsyncFunction("listScheduled") {
            val ctx = appContext.reactContext ?: return@AsyncFunction emptyList<Map<String, Any>>()
            AlarmScheduler.listScheduled(ctx)
        }

        /** 已触发未确认账本，读取即清账（v0.4.7 全屏闹钟拉起数据源）。 */
        AsyncFunction("drainFired") {
            val ctx = appContext.reactContext ?: return@AsyncFunction emptyList<Map<String, Any>>()
            AlarmScheduler.drainFired(ctx)
        }

        /** 确认停止（v0.4.7）：整单清理——注册表条目 + fired 账 + 常驻通知 +
         *  保活服务一并移除（与通知动作「停止」同一出口，幂等）。 */
        AsyncFunction("confirm") { id: String ->
            val ctx = appContext.reactContext
                ?: throw IllegalStateException("Android context unavailable")
            AlarmScheduler.cancel(ctx, id)
        }

        /** 常驻监控通知刷新（v0.5.2 用户令3）：JS 在 hydration / 行程项增删改
         *  后幂等 poke；start/stop 判据 = 原生注册表 pending 集合（非 JS 传参），
         *  title/body 传空 = 原生自算文案（boot/sticky 同构口径）。失败语义：
         *  sync 内部全兜底不抛，本函数只在 context 缺失时 reject——core/alarm
         *  门面 catch 后 warn 降级。 */
        AsyncFunction("syncMonitor") { title: String, body: String ->
            val ctx = appContext.reactContext
                ?: throw IllegalStateException("Android context unavailable")
            AlarmMonitorService.sync(ctx, title, body)
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

        /**
         * 提醒链路三项系统权限状态（v0.5.3 真机纠错；设置页「提醒权限自检」卡
         * 数据源；JS 门面契约见 core/alarm）：
         * - exactAlarms：AlarmManager.canScheduleExactAlarms（Android 12 前恒 true）；
         * - fullScreen：Android 14+ 查 NotificationManager.canUseFullScreenIntent
         *   （清单声明 USE_FULL_SCREEN_INTENT 时低版本恒 true——授予非用户可控面）；
         * - batteryOptimized：true = **仍受电池优化**（未豁免）；Android 6 前无
         *   Doze 恒 false。语义字段名以「是否被优化」为准，卡面对「已豁免」显绿。
         */
        AsyncFunction("reminderPermissionStatus") {
            val ctx = appContext.reactContext
                ?: return@AsyncFunction mapOf(
                    "exactAlarms" to true,
                    "fullScreen" to true,
                    "batteryOptimized" to false,
                )
            // v0.5.3 发布纠错（Release #30 Android 编译红：K2 在 `!` 开行的块尾
            // 表达式报 Unexpected token——全模块唯一一处该行 `!` 先例，改保守
            // 两分支形态；语义逐字等价：fullScreen=14+ 查系统授予否则恒 true，
            // batteryOptimized=「仍受优化」即未豁免，Android 6 前恒 false）。
            val notificationManager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val fullScreen = if (Build.VERSION.SDK_INT >= 34) {
                notificationManager.canUseFullScreenIntent()
            } else {
                true
            }
            val powerManager = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            val batteryOptimized = if (Build.VERSION.SDK_INT >= 23) {
                val ignoring = powerManager.isIgnoringBatteryOptimizations(ctx.packageName)
                if (ignoring) false else true
            } else {
                false
            }
            mapOf(
                "exactAlarms" to AlarmScheduler.canExact(ctx),
                "fullScreen" to fullScreen,
                "batteryOptimized" to batteryOptimized,
            )
        }

        /** 跳「允许精确闹钟」设置页（Android 12+；低版本/异常 = false，不抛）。 */
        AsyncFunction("openExactAlarmSettings") {
            val ctx = appContext.reactContext ?: return@AsyncFunction false
            if (Build.VERSION.SDK_INT < 31) return@AsyncFunction false
            // 动作字符串直写 + try/catch：与 AlarmKeepAliveService 的类型选型注
            // 同口径——不赌 compileSdk 常量池，缺失时 ActivityNotFoundException
            // 由 sendSettingsIntent 回落应用详情页
            sendSettingsIntent(
                ctx,
                "android.settings.REQUEST_SCHEDULE_EXACT_ALARM",
                Uri.fromParts("package", ctx.packageName, null),
            )
        }

        /**
         * 跳「全屏通知」授权页（Android 14+ FSI 用户授予面；低版本无该页，
         * 回落 app 通知设置——渠道静音与否也在那里修）。
         */
        AsyncFunction("openFullScreenSettings") {
            val ctx = appContext.reactContext ?: return@AsyncFunction false
            if (Build.VERSION.SDK_INT >= 34) {
                sendSettingsIntent(
                    ctx,
                    "android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT",
                    Uri.fromParts("package", ctx.packageName, null),
                )
            } else {
                sendSettingsIntent(ctx, Settings.ACTION_APP_NOTIFICATION_SETTINGS, null)
            }
        }

        /**
         * 申请电池优化豁免（Android 6+ ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS；
         * 已豁免幂等直返 true。厂商 ROM 自启动策略不在本页管辖，验收清单披露）。
         */
        AsyncFunction("requestIgnoreBatteryOptimizations") {
            val ctx = appContext.reactContext ?: return@AsyncFunction false
            if (Build.VERSION.SDK_INT < 23) return@AsyncFunction false
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            if (pm.isIgnoringBatteryOptimizations(ctx.packageName)) return@AsyncFunction true
            sendSettingsIntent(
                ctx,
                "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
                Uri.fromParts("package", ctx.packageName, null),
            )
        }

        /**
         * 锁屏呈现面开关（v0.5.3 真机纠错·根因 5）：FSI 拉起 Activity 后，
         * **Activity 自身必须开 showWhenLocked/turnScreenOn 才显示在锁屏之上**
         * （AOSP 时钟同款做法）——本项目 CNG 无 android/ 工程、清单静态 flag
         * 无处落，v0.4.x 起从未设置过这两个 flag，息屏到点 Activity 实际已在
         * 锁屏后启动而不可见 = 「不能回到 app」的直接根因。全屏闹钟屏挂载时
         * true、卸载/停止时 false（含 KEEP_SCREEN_ON，闹钟在响期间不灭屏）。
         */
        AsyncFunction("setLockScreenSurface") { enabled: Boolean ->
            val activity = appContext.currentActivity ?: return@AsyncFunction false
            Handler(Looper.getMainLooper()).post {
                try {
                    if (Build.VERSION.SDK_INT >= 27) {
                        activity.setShowWhenLocked(enabled)
                        activity.setTurnScreenOn(enabled)
                    }
                    val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    if (enabled) activity.window.addFlags(flags) else activity.window.clearFlags(flags)
                } catch (e: Exception) {
                    Log.w("archive-alarm", "lock-screen surface flags failed", e)
                }
            }
            true
        }
    }

    /** 系统设置页 intent 统一出口：NEW_TASK（非 Activity 上下文启动必需）；
     *  厂商 ROM 缺动作页时回落「应用详情」设置页；全兜底不抛，返回是否已发起。 */
    private fun sendSettingsIntent(context: Context, action: String, dataUri: Uri?): Boolean =
        try {
            context.startActivity(
                // 参数名刻意 dataUri：apply 里裸 `data` 会解析到 Intent.getData()
                // 合成属性遮蔽入参（审查实锤的坑），显式 setData(dataUri) 消歧
                Intent(action)
                    .apply { dataUri?.let { setData(it) } }
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            true
        } catch (e: Exception) {
            try {
                context.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.fromParts("package", context.packageName, null))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                true
            } catch (fallback: Exception) {
                Log.w("archive-alarm", "settings intent refused: $action", fallback)
                false
            }
        }

    private fun hasNotificationPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
}
