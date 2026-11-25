package archive.alarm

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat

/**
 * 到点保活前台服务（v0.4.7 用户令 #2「常驻通知维持存活」）：
 *
 * 闹钟触发后常驻通知在场期间，进程以 FGS（type=alarm）保活——app 已存活/
 * 被 full-screen intent 拉起时，JS 侧 timer 能真实走到「全屏闹钟屏」而不是
 * 被系统回收。确认停止（通知动作「停止」或 JS confirm(id)）→ 本服务自停、
 * 常驻通知移除。
 *
 * 通知与接收器同 id：receiver 先 notify（呈现本体），service startForeground
 * 认领同一通知（FGS 合法化），二者不重复弹卡。Android 12+ 从广播后台启动
 * FGS 受限：调用方（接收器/模块）try/catch 留痕降级，不崩。
 */
class AlarmKeepAliveService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // 停止命令只挂一个服务实例语义：任一 STOP 即收工
            // （逐 id 的呈现清理由 AlarmFireReceiver.dismiss 负责）
            stopSelfSafely()
            return START_NOT_STICKY
        }
        val id = intent?.getStringExtra(EXTRA_ID)
        if (id == null) {
            stopSelfSafely()
            return START_NOT_STICKY
        }
        try {
            // 与接收器同一构造点：同 id 换绑不丢「停止」动作与深链
            val notification = AlarmFireReceiver.ongoingNotification(
                this, id, titleOf(intent), bodyOf(intent), fullScreen = false,
            )
            val type = if (Build.VERSION.SDK_INT >= 34) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_ALARM
            } else {
                0
            }
            ServiceCompat.startForeground(this, AlarmFireReceiver.notificationId(id), notification, type)
        } catch (e: Exception) {
            // FGS 启动失败（厂商 ROM 限制/类型拒批）：通知呈现不受影响，服务退出
            Log.w(TAG, "keep-alive startForeground failed: $id", e)
            stopSelfSafely()
        }
        // 不 sticky：系统回收后不自动复活——到点账本在 SharedPreferences，
        // JS 回前台 drainFired 补呈现，避免不可见常驻服务耗用户电
        return START_NOT_STICKY
    }

    private fun stopSelfSafely() {
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        } catch (e: Exception) {
            Log.w(TAG, "stopForeground failed", e)
        }
        stopSelf()
    }

    override fun onDestroy() {
        stopSelfSafely()
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "archive.alarm.KEEPALIVE_STOP"
        private const val EXTRA_ID = AlarmFireReceiver.EXTRA_ID
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_BODY = "body"
        private const val TAG = "archive-alarm"

        private fun titleOf(intent: Intent): String =
            intent.getStringExtra(EXTRA_TITLE)?.ifEmpty { "行程提醒" } ?: "行程提醒"

        private fun bodyOf(intent: Intent): String = intent.getStringExtra(EXTRA_BODY) ?: ""

        fun start(context: Context, id: String, title: String, body: String) {
            val intent = Intent(context, AlarmKeepAliveService::class.java)
                .putExtra(EXTRA_ID, id)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_BODY, body)
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** 确认停止：发 STOP 命令停服务（通知移除在 dismiss 收口）。 */
        fun stop(context: Context, id: String) {
            try {
                context.startService(
                    Intent(context, AlarmKeepAliveService::class.java)
                        .setAction(ACTION_STOP)
                        .putExtra(EXTRA_ID, id),
                )
            } catch (e: Exception) {
                // 服务本就不在场（FGS 曾被拒）：幂等无操作
                Log.w(TAG, "keep-alive stop ignored: $id", e)
            }
        }
    }
}
