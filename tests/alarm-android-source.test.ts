/**
 * Android 闹钟链源码正则闸（v0.5.2 轮 D）：Kotlin/Manifest 无设备可跑，
 * 用源码断言锁死三类不可回退的事实——
 * 1. v0.5.1 FSI 剥离 bug 不复现（到点链路两个构造点恒 fullScreen=true；
 *    常驻监控链路恒**无** FSI/声音——两线混用即剥离窗口重演）；
 * 2. 重启恢复链在场（BootReceiver 声明 + rescheduleAll + 监控自恢复）；
 * 3. 常驻监控文案与 TS 纯函数镜像同构 + store 钩子接线在场。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidRoot = path.join(repoRoot, 'src', 'modules', 'archive-alarm', 'android', 'src', 'main');
const javaRoot = path.join(androidRoot, 'java', 'archive', 'alarm');

const read = (file: string): string => readFileSync(file, 'utf8');
const scheduler = () => read(path.join(javaRoot, 'AlarmScheduler.kt'));
const fireReceiver = () => read(path.join(javaRoot, 'AlarmFireReceiver.kt'));
const keepAlive = () => read(path.join(javaRoot, 'AlarmKeepAliveService.kt'));
const monitor = () => read(path.join(javaRoot, 'AlarmMonitorService.kt'));
const bootReceiver = () => read(path.join(javaRoot, 'BootRescheduleReceiver.kt'));
const alarmModule = () => read(path.join(javaRoot, 'AlarmModule.kt'));
const manifest = () => read(path.join(androidRoot, 'AndroidManifest.xml'));
const store = () => read(path.join(repoRoot, 'src', 'features', 'archive', 'store.ts'));
const ladder = () => read(path.join(repoRoot, 'src', 'features', 'archive', 'alarm-ladder.ts'));

// ─── 到点呈现链：FSI 不丢（v0.5.1 真机纠错的回退闸）─────────────────────────

test('fire receiver + keep-alive service both construct the alarm notification with fullScreen = true', () => {
    // 接收器先挂 FSI 版呈现，服务换绑同带 FSI——两构造点统一，剥离窗口不回归
    assert.match(fireReceiver(), /ongoingNotification\(context, id, title, body, fullScreen = true\)/);
    assert.match(keepAlive(), /ongoingNotification\(\s*this, id, titleOf\(intent\), bodyOf\(intent\), fullScreen = true,/);
    // ongoingNotification 的 FSI 只随 fullScreen 实参走（无第二事实源）
    assert.match(fireReceiver(), /if \(fullScreen\) builder\.setFullScreenIntent/);
});

test('fired alarm channel keeps alarm-ring sound; builder sound fallback present (双通道响铃)', () => {
    // 渠道声音 = 系统闹钟铃音（USAGE_ALARM），渠道被用户建后改不了时 builder 兜底
    assert.match(fireReceiver(), /setSound\(\s*RingtoneManager\.getDefaultUri\(RingtoneManager\.TYPE_ALARM\),/);
    assert.match(fireReceiver(), /\.setSound\(RingtoneManager\.getDefaultUri\(RingtoneManager\.TYPE_ALARM\)\)/);
});

// ─── 常驻监控线（v0.5.2 令3）：静默、无 FSI、无动作；与到点线渠道分离 ────────

test('monitor service is a silent status line: no sound, no full-screen intent, no actions', () => {
    const src = monitor();
    assert.doesNotMatch(src, /setFullScreenIntent/);
    assert.doesNotMatch(src, /setSound/);
    assert.doesNotMatch(src, /enableVibration\(true\)/);
    assert.doesNotMatch(src, /addAction/);
    // 独立静默渠道（IMPORTANCE_LOW），不得复用响铃渠道 archive-alarms
    assert.match(src, /MONITOR_CHANNEL = "archive-alarm-monitor"/);
    assert.match(src, /NotificationManager\.IMPORTANCE_LOW/);
    assert.doesNotMatch(src, /AlarmFireReceiver\.CHANNEL/);
    // 常驻 + 点击回 app（launcher contentIntent）
    assert.match(src, /\.setOngoing\(true\)/);
    assert.match(src, /getLaunchIntentForPackage/);
});

test('monitor copy mirrors the TS alarmMonitorNotificationText contract (N 个行程提醒监控中 / 最近 HH:mm)', () => {
    const src = monitor();
    assert.match(src, /\$count 个行程提醒监控中/);
    assert.match(src, /"最近 " \+ SimpleDateFormat\("HH:mm"/);
    const ts = ladder();
    assert.match(ts, /`\$\{summary\.count\} 个行程提醒监控中`/);
    assert.match(ts, /`最近 \$\{hh\}:\$\{mm\}`/);
});

test('monitor start/stop authority is the native registry pending set (at > now)', () => {
    // 判据单源：pendingSummary（at > now，与 rescheduleAll 过期口径同源）
    assert.match(scheduler(), /fun pendingSummary\(context: Context, now: Long\): Pair<Int, Long>\?/);
    assert.match(scheduler(), /if \(at <= now\) continue/);
    // sync：空 → stopService 撤面；非空 → startForegroundService；全兜底永不抛
    assert.match(monitor(), /AlarmScheduler\.pendingSummary\(app, System\.currentTimeMillis\(\)\) == null/);
    assert.match(monitor(), /app\.stopService\(Intent\(app, AlarmMonitorService::class\.java\)\)/);
    assert.match(monitor(), /app\.startForegroundService\(intent\)/);
    assert.match(monitor(), /return START_STICKY/); // 被杀自愈重拉（null intent = 注册表自算）
});

// ─── 重启 / 冷启恢复链 ──────────────────────────────────────────────────────

test('boot recovery is declared end-to-end: permission + exported receiver + reschedule + monitor', () => {
    assert.match(manifest(), /android\.permission\.RECEIVE_BOOT_COMPLETED/);
    assert.match(
        manifest(),
        /<receiver[\s\S]*?archive\.alarm\.BootRescheduleReceiver[\s\S]*?android:exported="true"[\s\S]*?BOOT_COMPLETED/,
    );
    assert.match(bootReceiver(), /AlarmScheduler\.rescheduleAll\(app\)/);
    assert.match(bootReceiver(), /AlarmMonitorService\.sync\(app\)/); // v0.5.2：开机同拍恢复常驻
});

test('alarm registry persists to SharedPreferences before AlarmManager set (boot 重排数据源)', () => {
    const src = scheduler();
    assert.match(src, /private const val PREFS = "archive-alarms"/);
    // schedule = 先 writeAll 后 set：进程/设备重启后注册表仍是唯一事实源
    assert.match(src, /writeAll\(context, alarms\)\s*\n\s*set\(context, id, at\)/);
});

test('fire receiver refreshes the monitor in the same pass (pending 集合过点即收)', () => {
    assert.match(fireReceiver(), /AlarmMonitorService\.sync\(context\)/);
});

// ─── JS ↔ 原生接线面 ────────────────────────────────────────────────────────

test('module exposes syncMonitor and manifest declares both keep-alive and monitor services', () => {
    assert.match(alarmModule(), /AsyncFunction\("syncMonitor"\)/);
    assert.match(
        manifest(),
        /<service[\s\S]*?archive\.alarm\.AlarmKeepAliveService[\s\S]*?foregroundServiceType="specialUse"/,
    );
    assert.match(
        manifest(),
        /<service[\s\S]*?archive\.alarm\.AlarmMonitorService[\s\S]*?foregroundServiceType="specialUse"/,
    );
});

test('store hooks poke the monitor after every registry mutation (hydration/create/edit/cancel chains)', () => {
    const src = store();
    // hydration：loadAll 尾部一次
    assert.match(src, /void refreshAlarmMonitor\(\);/);
    // schedule 落地后链刷（create + updateTripItemContent 重挂两处）
    assert.equal((src.match(/\.then\(\(\) => refreshAlarmMonitor\(\)\)/g) ?? []).length, 5);
    // deleteTrip 级联摘闹钟（v0.5.2 审计纠错：僵尸闹钟泄漏）
    assert.match(src, /tripItems\.map\(\(item\) => alarm\.cancel\(item\.id\)\)/);
});
