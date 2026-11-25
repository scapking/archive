package archive.alarm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * 闹钟到点接收器（v0.4.7 阶梯呈现核心）：
 *
 * 1. 落 fired 账本（JS 回前台 drainFired 补拉起）；
 * 2. 发**常驻通知**（ongoing + 不可滑掉 + 锁屏可见）：contentIntent 与
 *    full-screen intent 均深链 `archive://alarm/<id>`（路径参数，AGENTS.md
 *    偏差表三端统一）——息屏/锁屏场景系统直接拉起 app 内全屏闹钟屏，
 *    通知 tap 场景深链同屏；通知动作「停止」= confirm 出口（手动确认语义，
 *    确认后移除常驻通知）；
 * 3. 尝试启动保活前台服务（AlarmKeepAliveService）——Android 12+ 后台启动
 *    受限时仅留痕不崩（OEM 省电/自启动限制为已知边界，交付报告披露）。
 *
 * 文案读注册表（extras 只是寻址 id，重排后 extras 里的文案可能是旧的）。
 */
class AlarmFireReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        when (intent.action) {
            ACTION_FIRE -> fire(context, id)
            ACTION_STOP -> {
                // 通知动作「停止」= 用户手动确认：整单清理（注册表条目 +
                // fired 账 + 常驻通知 + 保活服务）——不留过期待触发条目，
                // JS 侧软计时才不会把已停的闹钟再拉起来
                AlarmScheduler.cancel(context, id)
            }
            else -> Unit
        }
    }

    private fun fire(context: Context, id: String) {
        val entry = AlarmScheduler.readAll(context).optJSONObject(id)
        val title = entry?.optString("title", "行程提醒")?.ifEmpty { "行程提醒" } ?: "行程提醒"
        val body = entry?.optString("body", "") ?: ""
        val at = entry?.optLong("at", System.currentTimeMillis()) ?: System.currentTimeMillis()
        try {
            AlarmScheduler.markFired(context, id, at, title, body)
            ensureChannel(context)

            // 保活前台服务（app 存活时 JS 侧才能在到点直接拉起全屏闹钟屏）：
            // Android 12+ 从广播后台启动 FGS 受限时留痕降级——常驻通知在场，
            // 用户 tap 通知/full-screen intent 拉起后 JS drainFired 补账。
            try {
                AlarmKeepAliveService.start(context, id, title, body)
            } catch (e: Exception) {
                Log.w(TAG, "keep-alive service start refused (FGS background limit): $id", e)
            }

            NotificationManagerCompat.from(context)
                .notify(notificationId(id), ongoingNotification(context, id, title, body, fullScreen = true))
        } catch (e: Exception) {
            // 通知失败只留痕：闹钟数据面不受影响（增强失败文档化降级口径）
            Log.w(TAG, "alarm notification failed: $id", e)
        }
    }

    companion object {
        const val ACTION_FIRE = "archive.alarm.FIRE"
        const val ACTION_STOP = "archive.alarm.STOP"
        const val EXTRA_ID = "id"
        const val CHANNEL = "archive-alarms"
        private const val TAG = "archive-alarm"
        private const val REQUEST_STOP_OFFSET = 1_000_000

        /** 通知与闹钟同一寻址 id 的映射（同前代语义，幂等覆盖）。 */
        fun notificationId(id: String): Int = id.hashCode()

        /** 深链 PendingIntent：archive://alarm/<id> → app 内全屏闹钟屏。 */
        fun alarmDeepLink(context: Context, id: String): PendingIntent? {
            val launch = context.packageManager
                .getLaunchIntentForPackage(context.packageName)
                ?.setData(Uri.parse("archive://alarm/$id"))
                ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ?: return null
            return PendingIntent.getActivity(
                context,
                id.hashCode(),
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        /** 「停止」动作 PendingIntent：广播回本接收器 ACTION_STOP（清账 + dismiss）。 */
        private fun stopIntent(context: Context, id: String): PendingIntent =
            PendingIntent.getBroadcast(
                context,
                REQUEST_STOP_OFFSET + id.hashCode(),
                Intent(context, AlarmFireReceiver::class.java)
                    .setAction(ACTION_STOP)
                    .putExtra(EXTRA_ID, id),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

        /**
         * 常驻通知唯一构造点（接收器呈现 + 前台服务认领同一 id 同构内容，
         * 服务 startForeground 换绑不丢「停止」动作）：ongoing、不 autoCancel、
         * 锁屏可见、category=alarm、渠道声音=系统闹钟铃音。
         */
        fun ongoingNotification(
            context: Context,
            id: String,
            title: String,
            body: String,
            fullScreen: Boolean,
        ): Notification {
            ensureChannel(context)
            val deepLink = alarmDeepLink(context, id)
            val builder = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(context.applicationInfo.icon)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                // 锁屏直呈闹钟面（OEM 锁屏通知策略为已知边界）
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))
                // 常驻通知：不可滑掉、不 autoCancel，「确认后移除」（用户令 #2）
                .setOngoing(true)
                .setAutoCancel(false)
                .addAction(0, "停止", stopIntent(context, id))
            if (deepLink != null) {
                builder.setContentIntent(deepLink)
                if (fullScreen) builder.setFullScreenIntent(deepLink, true)
            }
            return builder.build()
        }

        /** 闹钟渠道（IMPORTANCE_HIGH + 系统闹钟铃音 + 震动；创建幂等）。 */
        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "行程闹钟", NotificationManager.IMPORTANCE_HIGH).apply {
                    setDescription("行程项到点的系统闹钟提醒")
                    enableVibration(true)
                    // 渠道声音锁定系统闹钟铃音（O+ 渠道创建后 sound 不可再改，
                    // 建渠道即定档；builder.setSound 仅是历史路径的兜底）
                    setSound(
                        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                },
            )
        }

        /** 确认停止出口（通知动作 / JS confirm(id) 共用）：移除常驻通知并停服务。 */
        fun dismiss(context: Context, id: String) {
            try {
                NotificationManagerCompat.from(context).cancel(notificationId(id))
            } catch (e: Exception) {
                Log.w(TAG, "dismiss notification failed: $id", e)
            }
            AlarmKeepAliveService.stop(context, id)
        }
    }
}
