/**
 * Android 闹钟链源码正则闸（v0.5.2 轮 D；v0.5.3 轮 B 扩展）：Kotlin/Manifest
 * 无设备可跑，用源码断言锁死不可回退的事实——
 * 1. v0.5.1 FSI 剥离 bug 不复现（到点链路两个构造点恒 fullScreen=true；
 *    常驻监控链路恒**无** FSI/声音——两线混用即剥离窗口重演）；
 * 2. 重启恢复链在场（BootReceiver 声明 + rescheduleAll + 监控自恢复）；
 * 3. 常驻监控文案与 TS 纯函数镜像同构 + store 钩子接线在场；
 * 4. （v0.5.3 轮 B）响铃/拉回真机根治链在场：渠道 v2 版本化+旧渠道清理+
 *    闹钟流参数、canUseFullScreenIntent 检查与授权页入口、电池优化豁免、
 *    锁屏呈现面（showWhenLocked/turnScreenOn）接线、模块↔双 TS 门面同名、
 *    设置页「提醒权限自检」三行卡。
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
const settingsScreen = () => read(path.join(repoRoot, 'src', 'features', 'archive', 'settings-screen.tsx'));
const watcher = () => read(path.join(repoRoot, 'src', 'features', 'archive', 'alarm-watcher.ts'));
const rootLayout = () => read(path.join(repoRoot, 'src', 'app', '_layout.tsx'));
const fullscreenScreen = () => read(path.join(repoRoot, 'src', 'features', 'archive', 'alarm-fullscreen-screen.tsx'));
const coreAlarm = () => read(path.join(repoRoot, 'src', 'core', 'alarm', 'index.ts'));
const moduleTs = () => read(path.join(repoRoot, 'src', 'modules', 'archive-alarm', 'src', 'index.ts'));

/** v0.5.3 起闹钟链全部系统面入口（模块 ↔ 双 TS 门面必须同名同在）。 */
const V053_MODULE_FUNCTIONS = [
    'reminderPermissionStatus',
    'openExactAlarmSettings',
    'openFullScreenSettings',
    'requestIgnoreBatteryOptimizations',
    'setLockScreenSurface',
] as const;

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

// ─── v0.5.3 轮 B：真机「不回 app / 不响铃」根治链 ────────────────────────────

test('alarm channel is versioned v2 with legacy cleanup — both construction points share it', () => {
    const src = fireReceiver();
    // 渠道不可变性陷阱：O+ 渠道 sound/importance 创建后不可改，v0.4.x 装机
    // 设备上的旧渠道参数已固化——唯一修法是新 id 重建 + 旧渠道删除
    assert.match(src, /const val CHANNEL = "archive-alarms-v2"/);
    assert.match(src, /const val LEGACY_CHANNELS = "archive-alarms"/);
    assert.match(src, /nm\.deleteNotificationChannel\(LEGACY_CHANNELS\)/);
    // 通知构造单点：接收器呈现与服务换绑都经 ongoingNotification → Builder(context, CHANNEL)，
    // 「两处都切新渠道」由常量单源保证（两调用点各自的 fullScreen=true 由首个用例锁定）
    assert.match(src, /NotificationCompat\.Builder\(context, CHANNEL\)/);
    assert.match(keepAlive(), /AlarmFireReceiver\.ongoingNotification\(/);
});

test('channel v2 first creation carries full alarm parameters (sound/focus/DND/lockscreen)', () => {
    const src = fireReceiver();
    assert.match(src, /NotificationManager\.IMPORTANCE_HIGH/);
    assert.match(src, /AudioAttributes\.USAGE_ALARM/);
    assert.match(src, /AudioAttributes\.CONTENT_TYPE_SONIFICATION/);
    assert.match(src, /setBypassDnd\(true\)/);
    assert.match(src, /lockscreenVisibility = Notification\.VISIBILITY_PUBLIC/);
});

test('full-screen intent grant state is checked at fire time and queryable by JS', () => {
    // 接收器：Android 14+ FSI 被拒 → 留痕（退化为 heads-up 的现场证据）
    const src = fireReceiver();
    assert.match(src, /Build\.VERSION\.SDK_INT >= 34/);
    assert.match(src, /\.canUseFullScreenIntent\(\)/);
    // 模块：reminderPermissionStatus 同源查询（API<34 恒 true 语义见字段注）
    const mod = alarmModule();
    assert.match(mod, /canUseFullScreenIntent\(\)/);
    assert.match(mod, /AsyncFunction\("reminderPermissionStatus"\)/);
});

test('module exposes the v0.5.3 system-surface functions and both TS facades mirror them', () => {
    const mod = alarmModule();
    for (const fn of V053_MODULE_FUNCTIONS) {
        assert.match(mod, new RegExp(`AsyncFunction\\("${fn}"\\)`));
        // 双 TS 门面（core/alarm 消费面 + 模块包门面）同名在场
        assert.match(coreAlarm(), new RegExp(`${fn}\\(`));
        assert.match(moduleTs(), new RegExp(`${fn}\\(`));
    }
    // 命名错位根治：Kotlin Name ≡ requireOptionalNativeModule 的字符串（两端门面）
    assert.match(mod, /Name\("SystemAlarm"\)/);
    assert.match(coreAlarm(), /requireOptionalNativeModule<SystemAlarmNative>\('SystemAlarm'\)/);
    assert.match(moduleTs(), /requireOptionalNativeModule<ArchiveAlarmNativeModule>\('SystemAlarm'\)/);
});

test('settings intents are guarded and best-effort (exact alarm / FSI / battery exemption)', () => {
    const mod = alarmModule();
    assert.match(mod, /android\.settings\.REQUEST_SCHEDULE_EXACT_ALARM/);
    assert.match(mod, /android\.settings\.MANAGE_APP_USE_FULL_SCREEN_INTENT/);
    assert.match(mod, /android\.settings\.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/);
    assert.match(mod, /isIgnoringBatteryOptimizations/);
    // 非 Activity 上下文启动必须 NEW_TASK；全兜底不抛（sendSettingsIntent 单点）
    assert.match(mod, /Intent\.FLAG_ACTIVITY_NEW_TASK/);
    assert.match(manifest(), /android\.permission\.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/);
});

test('lock-screen surface is wired: module sets showWhenLocked/turnScreenOn, alarm screen applies it', () => {
    const mod = alarmModule();
    assert.match(mod, /activity\.setShowWhenLocked\(enabled\)/);
    assert.match(mod, /activity\.setTurnScreenOn\(enabled\)/);
    assert.match(mod, /FLAG_SHOW_WHEN_LOCKED/);
    assert.match(mod, /FLAG_TURN_SCREEN_ON/);
    // 全屏闹钟屏：挂载开、卸载还原；仅 Android（iOS/web 门面 no-op 也不空转）
    const screen = fullscreenScreen();
    assert.match(screen, /if \(Platform\.OS !== 'android'\) return;/);
    assert.match(screen, /void alarm\.setLockScreenSurface\(true\);/);
    assert.match(screen, /void alarm\.setLockScreenSurface\(false\);/);
});

test('watcher soft-timer core registers before notification tap channel (v0.5.3 需求5 前台到点)', () => {
    const src = watcher();
    // 结构纪律：interval/AppState/首轮 drain 先注册，onResponse（try/catch 增强
    // 通道）在其后——通知面同步抛不得再带死软计时网
    const timerAt = src.indexOf('const timer = setInterval(');
    const tapAt = src.indexOf('notifications.onResponse(');
    assert.ok(timerAt > 0 && tapAt > 0, 'timer & tap subscription both wired');
    assert.ok(timerAt < tapAt, 'soft-timer core must register before the tap channel');
    assert.match(src, /TICK_MS = 15_000/);
    assert.match(src, /await drain\(\);/); // Android 每拍顺带收 fired 账（亮屏 FSI 降级洞）
    assert.match(src, /tickRef\.current = tick;/);
    assert.match(src, /void tickRef\.current\?\.\(\);/); // 路由切换同拍补扫
    assert.match(src, /\}, \[pathname\]\);/);
    // 全局挂载面：根布局无条件挂 watcher（任意前台路由的到点网都从这来）
    assert.match(rootLayout(), /useAlarmReminderWatcher\(\);/);
});

test('settings screen carries the reminder permission self-check card (Android-only, three rows)', () => {
    const src = settingsScreen();
    assert.match(src, /提醒权限自检/);
    assert.match(src, /Platform\.OS === 'android' \? <ReminderPermissionSection \/> : null/);
    for (const label of ['精确闹钟', '全屏通知', '电池优化豁免']) {
        assert.ok(src.includes(`label: '${label}'`), `settings card row ${label} missing`);
    }
    assert.match(src, /未开启/);
    assert.match(src, /去开启/);
    assert.match(src, /alarm\.reminderPermissionStatus\(\)/);
    assert.match(src, /AppState\.addEventListener\('change'/); // 授权返回后重查
});
