package archive.alarm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * 闹钟到点接收器：发一条 IMPORTANCE_HIGH + 全屏 intent 的闹钟通知（用户裁决
 * 的「Android 真闹钟」呈现——锁屏上直接弹响铃面，点开进 app）。文案读注册表
 * （extras 只是寻址 id，重排后 extras 里的文案可能是旧的）。
 */
class AlarmFireReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_FIRE) return
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val entry = AlarmScheduler.readAll(context).optJSONObject(id)
        val title = entry?.optString("title", "行程提醒")?.ifEmpty { "行程提醒" } ?: "行程提醒"
        val body = entry?.optString("body", "") ?: ""
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL, "行程闹钟", NotificationManager.IMPORTANCE_HIGH).apply {
                        setDescription("行程项到点的系统闹钟提醒")
                        enableVibration(true)
                    },
                )
            }
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val fullScreen: PendingIntent? = launch?.let {
                PendingIntent.getActivity(
                    context,
                    id.hashCode(),
                    it,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            }
            val builder = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(context.applicationInfo.icon)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))
            if (fullScreen != null) builder.setFullScreenIntent(fullScreen, true)
            NotificationManagerCompat.from(context).notify(id.hashCode(), builder.build())
        } catch (e: Exception) {
            // 通知失败只留痕：闹钟数据面不受影响（增强失败文档化降级口径）
            Log.w(TAG, "alarm notification failed: $id", e)
        }
    }

    companion object {
        const val ACTION_FIRE = "archive.alarm.FIRE"
        const val EXTRA_ID = "id"
        const val CHANNEL = "archive-alarms"
        private const val TAG = "archive-alarm"
    }
}