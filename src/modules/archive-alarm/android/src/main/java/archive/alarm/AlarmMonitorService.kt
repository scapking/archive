package archive.alarm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 常驻监控前台服务（v0.5.2 用户令3「创建行程的时候就创建常驻通知，
 * 否则后台会被冻结没办法使用」）：
 *
 * 只要原生注册表里存在「未到点且有闹钟」的 pending 行程项，本服务以前台
 * 通知常驻：**「N 个行程提醒监控中」+「最近 HH:mm」**（silent 渠道，点击
 * 回 app）。语义与 AlarmKeepAliveService（到点保活）刻意分离为**两个服务、
 * 两条通知**：一个 FGS 只能挂一条通知，混用会让「到点响铃卡（带 FSI/停止
 * 动作）」与「静默状态行」互相覆盖——v0.5.1 的 FSI 剥离教训不再重演。
 *
 * start/stop 判据 = AlarmScheduler 注册表本身（SharedPreferences 单源，
 * pending = at > now）：全部过点/删除即停，不依赖 JS 活着。JS 侧只在
 * hydration 与行程项增删改后 poke 一次（store.refreshAlarmMonitor，门面
 * best-effort 永不抛）；开机恢复走 BootRescheduleReceiver，被杀后自愈走
 * START_STICKY 重入（null intent = 纯注册表自算）。
 *
 * 文案双源说明：title/body 由 JS（alarm-ladder 纯函数镜像）传入时优先——
 * 保持文案事实源在 TS 侧可测；boot/sticky 重入无 extras 时本类自算同构
 * 文案（tests/alarm-android-source 正则闸锁定两端格式一致）。
 */
class AlarmMonitorService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val summary = AlarmScheduler.pendingSummary(this, System.currentTimeMillis())
        if (summary == null) {
            // 无 pending：立即收摊。经 startForegroundService 进入的调用方
            // 契约要求 startForeground 至少一次——先挂后撤（毫秒级、无感），
            // 否则 API 31+ 抛 ForegroundServiceDidNotStartInTimeException。
            transientStop()
            return START_NOT_STICKY
        }
        val title = intent?.getStringExtra(EXTRA_TITLE)?.ifEmpty { null } ?: formatTitle(summary.first)
        val body = intent?.getStringExtra(EXTRA_BODY)?.ifEmpty { null } ?: formatBody(summary.second)
        try {
            // 类型走清单声明（specialUse + trip-alarm-monitor subtype）：
            // 传 0 回落两参语义由系统按 manifest 读取（AlarmKeepAliveService
            // 同款选型注，不引用 ServiceInfo 常量的理由见彼处）。
            ServiceCompat.startForeground(this, MONITOR_NOTIFICATION_ID, build(title, body), 0)
        } catch (e: Exception) {
            // FGS 启动被拒（厂商 ROM 限制）：闹钟数据面不受影响，服务退出，
            // 下一次 JS poke / boot 重入再试
            Log.w(TAG, "monitor startForeground failed", e)
            stopSelfSafely()
        }
        // sticky：被系统回收后自动重拉（null intent 重入 = 注册表自算）——
        // 这正是本服务存在的意义：pending 闹钟在场期间进程不被冻结
        return START_STICKY
    }

    override fun onDestroy() {
        stopSelfSafely()
        super.onDestroy()
    }

    private fun transientStop() {
        try {
            ServiceCompat.startForeground(this, MONITOR_NOTIFICATION_ID, build("行程提醒监控中", ""), 0)
        } catch (e: Exception) {
            Log.w(TAG, "monitor transient startForeground failed", e)
        }
        stopSelfSafely()
    }

    private fun stopSelfSafely() {
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        } catch (e: Exception) {
            Log.w(TAG, "monitor stopForeground failed", e)
        }
        stopSelf()
    }

    /**
     * 监控状态行通知唯一构造点：**不出声、不带全屏 intent、无动作按钮**——
     * 铃声与 FSI 专属到点链路（AlarmFireReceiver），常驻监控必须静默
     * （用户令「停止即静音」口径的镜像：在场≠出声；正则闸锁死本类
     * 不出现响铃/全屏/动作的构造面）。
     */
    private fun build(title: String, body: String): Notification {
        ensureMonitorChannel(this)
        val builder = NotificationCompat.Builder(this, MONITOR_CHANNEL)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(body)
            .setOngoing(true)
            .setAutoCancel(false)
        val launch = packageManager.getLaunchIntentForPackage(packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (launch != null) {
            builder.setContentIntent(
                PendingIntent.getActivity(
                    this,
                    MONITOR_NOTIFICATION_ID,
                    launch,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
        }
        return builder.build()
    }

    companion object {
        /** 与行程项 id.hashCode()（到点通知寻址空间）无交集的稳定 id。 */
        val MONITOR_NOTIFICATION_ID: Int = "archive.alarm.monitor".hashCode()
        const val MONITOR_CHANNEL = "archive-alarm-monitor"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_BODY = "body"
        private const val TAG = "archive-alarm"

        /** boot/sticky 自算文案：与 TS alarmMonitorNotificationText 同构
         *  （tests/alarm-android-source 正则闸锁定字样）。 */
        private fun formatTitle(count: Int): String = "$count 个行程提醒监控中"

        private fun formatBody(nearestAt: Long): String =
            "最近 " + SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(nearestAt))

        /** 监控渠道：IMPORTANCE_LOW + 不设声音（创建后不可改，与响铃渠道
         *  `archive-alarms` 严格分离）——每次刷新通知不 heads-up 不出声。 */
        private fun ensureMonitorChannel(context: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(MONITOR_CHANNEL, "行程监控", NotificationManager.IMPORTANCE_LOW).apply {
                    setDescription("未到点行程闹钟的常驻监控状态行（静默）")
                    enableVibration(false)
                },
            )
        }

        /**
         * 幂等刷新入口（JS syncMonitor / BootRescheduleReceiver / 到点接收器
         * 共用）：以注册表为准决定 start/stop；title/body 传空 = 原生自算。
         * **永不抛**——FGS 后台启动受限（Android 12+）只留痕，呈现面退化为
         * 「下次进 app 再收敛」，闹钟数据面（AlarmManager 注册）不受影响。
         */
        fun sync(context: Context, title: String = "", body: String = "") {
            val app = context.applicationContext
            if (AlarmScheduler.pendingSummary(app, System.currentTimeMillis()) == null) {
                // 全部过点/删除 = 停：stopService 无后台启动限制；服务不在场
                // 时是 no-op。通知移除经 onDestroy → stopForeground(REMOVE)。
                try {
                    app.stopService(Intent(app, AlarmMonitorService::class.java))
                } catch (e: Exception) {
                    Log.w(TAG, "monitor stop ignored", e)
                }
                return
            }
            val intent = Intent(app, AlarmMonitorService::class.java)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_BODY, body)
            try {
                if (Build.VERSION.SDK_INT >= 26) {
                    app.startForegroundService(intent)
                } else {
                    app.startService(intent)
                }
            } catch (e: Exception) {
                Log.w(TAG, "monitor sync refused (FGS background limit)", e)
            }
        }
    }
}
