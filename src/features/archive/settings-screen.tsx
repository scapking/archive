import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    Text,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    LucideShield,
    LucideDownload,
    LucideFileText,
    LucideLock,
    LucideUpload,
} from '@/core/icons';
import { haptics } from '@/core/haptics';
import { localAuth } from '@/core/local-auth';
// 防截屏（Android FLAG_SECURE / iOS 库内防护 / web 恒 no-op，平台差异见能力注）
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from '@/core/screen-capture';
import { documentPicker } from '@/core/document-picker';
import { archiveConfig } from '@/config/archive';
import { useArchiveStore } from './store';
import { exportAllAsPdf, exportFullBackup, importFullBackup } from './export';
// App 锁配置字段与生效档位共用门禁组件同一事实源（features/archive/app-lock）：
// 生效档读取含旧布尔字段的兼容归一（useAppLockMode），切档写入同时清旧布尔
// 字段（cast，见 app-lock.tsx 旧数据兼容注）
import {
    APP_LOCK_MODE_CONFIG_KEY,
    LEGACY_APP_LOCK_CONFIG_KEY,
    useAppLockMode,
    type AppLockMode,
} from './app-lock';
import { PAPER_CARD_SHADOW, ScreenHeader, Segmented, usePalette, useThemePref, type ThemePref } from './ui';
// 深路径注记：useMediaAlignPref/MediaAlign 未入 ui/index.ts 出口（theme.ts 在
// 本组改动权限外的既有先例——me-screen 同款深取），域内深取。
import { useMediaAlignPref, type MediaAlign } from './ui/theme';

/**
 * 设置页（新1：Me 的 导出 / App 锁 / 外观 三块合并收口）：入口 = Me 页
 * 「我的内容」卡的「设置」行（点按进入本页），区块自上而下——
 *
 * **v0.4.6 重样（方向令 §2/§5，apple 参考）**：iOS 分组列表解剖——
 * - **外观**：主题三档 + 图片对齐三档（行 label 左 16px + 统一 Segmented 右，
 *   卡内零 hairline；分段从本页私有 CompactSegmented 收口到 ui/segmented，
 *   选中态由「换色」改「白块浮起 + 近距投影」）；
 * - **安全**：App 锁三档分段（关闭 / 平衡 / 激进；离开 off 档前探测本机认证
 *   手段，不支持就地说明——放行一个必然把人锁在门外的配置没有意义）；
 * - **备份与恢复（置底，用户指令「导出必须是最底部的」）**：导出全量备份
 *   （zip：全部行 + 图片/视频/音频二进制）→ 导入备份（选包自动恢复，合并
 *   语义无缝续用）→ 导出文稿（PDF，web 降级 HTML 下载）。导出/导入走系统
 *   分享/文件面板；成功静默 + 就地完成横幅（导入有计数反馈），失败进
 *   store.error 红字横幅（屏头下方，可重试）。
 *
 * 卡与卡的关系靠光影不靠色块（方向令 §1）：surface 纸卡 + PAPER_CARD 柔和
 * 投影浮在 base 页底上；区块题走 eyebrow 档（11 secondary），页底留一条
 * 版本号 meta（12 muted）收口最后一段空白——「稀疏即罪」的 settings 落法。
 *
 * **传输面注记**：跨设备 = 分享面板传同一个 zip 包（AirDrop/网盘/IM 任选）；
 * 局域网设备直传依赖常驻 HTTP 服务，Expo Go 运行时无此能力（见 export.ts
 * 头注），未实现。
 */

/** 打包版本号（页脚 meta 用）：package.json 由 metro JSON 导入直读，只显
 *  version 一段防映射表整体进包。 */
import packageJson from '../../package.json';
const APP_VERSION: string = (packageJson as { version: string }).version;

/** 导入在途/完成横幅自动消退时长（ms）：完成态确认是一次性反馈非常驻状态。 */
const IMPORT_NOTICE_TTL_MS = 6000;

/** 备份行数据（busy 态行尾 spinner + 禁按，同块操作卡保存到手机行口径）。 */
type BackupAction = 'export' | 'import' | 'pdf';

export function SettingsScreen() {
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const storeError = useArchiveStore((s) => s.error);
    const loadAll = useArchiveStore((s) => s.loadAll);
    // 备份动作在途（三行动作互斥：同一在读面，串行防内存叠加——全量备份把
    // 媒体读进 JS，两个备份并行会翻倍峰值内存）
    const [busyAction, setBusyAction] = useState<BackupAction | null>(null);
    // 导入完成横幅（{ text, at }：at 供自动消退 effect 精确重启计时器）
    const [importNotice, setImportNotice] = useState<{ text: string; at: number } | null>(null);
    // busyRef 防双击双跑（state 在异步链里读旧值，同 savingToPhoneRef 口径）
    const busyRef = useRef(false);

    // 完成横幅自动消退（6s：导入计数文案较长，给足阅读时间）
    useEffect(() => {
        if (!importNotice) return;
        const timer = setTimeout(() => setImportNotice(null), IMPORT_NOTICE_TTL_MS);
        return () => clearTimeout(timer);
    }, [importNotice]);

    /** App 锁切档：离开 off 档前探测本机认证手段（硬件 + 已录入），不支持拒绝
        并就地说明、不写配置（放行一个必然把人锁在门外的配置没有意义）；切档
        同时写 false 清掉旧版布尔字段（存量兼容回退见 app-lock.tsx 头注，切一次
        档即永久退出）。 */
    const setAppLockMode = async (next: AppLockMode) => {
        if (busyRef.current) return;
        try {
            if (next !== 'off') {
                const supported = await localAuth.isSupportedAsync();
                if (!supported) {
                    useArchiveStore.setState({ error: '这台设备没有可用的面容 / 指纹或锁屏凭据，暂不能开启 App 锁。' });
                    return;
                }
            }
            // 旧布尔字段清除写入需 cast：security.appLock 已从 config 默认表移除，
            // config store 类型面不再认识该键（仅存量文档残留）
            archiveConfig.update({
                [APP_LOCK_MODE_CONFIG_KEY]: next,
                [LEGACY_APP_LOCK_CONFIG_KEY]: false,
            } as Parameters<typeof archiveConfig.update>[0]);
            useArchiveStore.setState({ error: null });
            haptics.selection();
        } catch (caught) {
            useArchiveStore.setState({
                error: `App 锁切换失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        }
    };

    /** 防截屏切档：**先执行系统能力、成功才写配置**——native 调用失败时配置
        保持原档（分段展示与实际防控行为恒一致），失败经 store.error 通道说明；
        web 端能力恒 no-op（档位仅落配置存档）。busyRef 与 App 锁切档共用互斥
        （同一安全卡内两个切档动作串行，避免并发写配置文档）。 */
    const setPreventCapture = async (next: boolean) => {
        if (busyRef.current) return;
        busyRef.current = true;
        try {
            if (next) {
                await preventScreenCaptureAsync();
            } else {
                await allowScreenCaptureAsync();
            }
            archiveConfig.update({ 'security.preventCapture': next });
            useArchiveStore.setState({ error: null });
            haptics.selection();
        } catch (caught) {
            useArchiveStore.setState({
                error: `防截屏切换失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            busyRef.current = false;
        }
    };

    /** 备份三动作统一编排：互斥 + spinner 反馈 + 失败上浮（成功静默/横幅）。 */
    const runBackupAction = async (action: BackupAction) => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusyAction(action);
        try {
            if (action === 'export') {
                await exportFullBackup();
            } else if (action === 'pdf') {
                await exportAllAsPdf();
            } else {
                const picked = await documentPicker.pickAsync({
                    type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
                });
                if (picked.canceled || !picked.document) return;
                const result = await importFullBackup(picked.document.uri);
                // 导入改变了全库数据：store 全量重载 + revision 推进（首页 deck /
                // Me 指标 / 各自持屏据此刷新）
                await loadAll();
                useArchiveStore.setState((s) => ({ revision: s.revision + 1, error: null }));
                haptics.success();
                const rows = result.trips + result.journals + result.events;
                setImportNotice({
                    text: `导入完成：新增 ${rows} 条记录、恢复 ${result.mediaFiles} 个媒体文件，已有内容保持不变`,
                    at: Date.now(),
                });
            }
        } catch (caught) {
            // 失败红字横幅（store.error 通道），就地可重试
            useArchiveStore.setState({
                error: `备份失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            busyRef.current = false;
            setBusyAction(null);
        }
    };

    // 备份三行（只留标题：动作语义靠标题自明，描述文案已按用户反馈精简）；
    // icon 统一 color=palette.secondary——非 CSS 场景语义色口径（theme.ts 头注），
    // 漏传会在深色模式保持默认色不变
    const rows: Array<{ action: BackupAction; icon: React.ReactNode; title: string }> = [
        {
            action: 'export',
            icon: <LucideDownload size={18} strokeWidth={1.9} color={palette.secondary} />,
            title: '导出备份',
        },
        {
            action: 'import',
            icon: <LucideUpload size={18} strokeWidth={1.9} color={palette.secondary} />,
            title: '导入备份',
        },
        {
            action: 'pdf',
            icon: <LucideFileText size={18} strokeWidth={1.9} color={palette.secondary} />,
            title: '导出文稿',
        },
    ];

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-ink-base dark:bg-inkd-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <ScreenHeader title="设置" />
                <ScrollView
                    contentContainerStyle={{
                        paddingHorizontal: 24,
                        paddingBottom: insets.bottom + 40,
                    }}
                    keyboardShouldPersistTaps="handled"
                >
                    {/* store.error 通道（App 锁探测/备份失败等）统一在此可见：
                        红字裸行升级为 tinted 横幅卡（方向令 §7——错误是设计面，
                        不是贴在留白上的一行小字） */}
                    {storeError ? (
                        <View className="mt-2 rounded-control bg-ink-negative-bg px-4 py-3 dark:bg-inkd-negative-bg">
                            <Text className="text-[13px] leading-5 text-ink-negative dark:text-inkd-negative">
                                {storeError}
                            </Text>
                        </View>
                    ) : null}
                    {importNotice ? (
                        <View className="mt-2 rounded-control bg-ink-surface px-4 py-3 dark:bg-inkd-surface">
                            <Text className="text-[13px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                                {importNotice.text}
                            </Text>
                        </View>
                    ) : null}

                    <AppearanceSection />
                    <SecuritySection
                        onChange={(next) => void setAppLockMode(next)}
                        onSetPreventCapture={(next) => void setPreventCapture(next)}
                    />

                    {/* 备份与恢复（用户指令：导出置底——区块排在页面最末） */}
                    <SectionEyebrow label="备份与恢复" />
                    <View className="rounded-card bg-ink-surface px-2.5 py-1.5 dark:bg-inkd-surface" style={PAPER_CARD_SHADOW}>
                        {rows.map((row) => {
                            const busy = busyAction === row.action;
                            const locked = busyAction != null;
                            return (
                                <Pressable
                                    key={row.action}
                                    onPress={() => void runBackupAction(row.action)}
                                    disabled={locked}
                                    // 行级 active 高亮（iOS 设置列表式，同 Me 内容卡
                                    // 统一按压语言）；行贴靠零线条；px 内缩让按压
                                    // 高亮块带圆角收在卡缘内
                                    className={`flex-row items-center gap-4 rounded-control px-2.5 py-3 active:bg-ink-raised dark:active:bg-inkd-raised ${
                                        locked && !busy ? 'opacity-40' : ''
                                    }`}
                                    accessibilityRole="button"
                                    accessibilityLabel={row.title}
                                >
                                    <View className="w-6 items-center">
                                        {row.icon}
                                    </View>
                                    <Text className="min-w-0 flex-1 text-[16px] text-ink-text dark:text-inkd-text">
                                        {row.title}
                                    </Text>
                                    {busy ? (
                                        // in-flight：行尾 spinner（动作可见）
                                        <ActivityIndicator size="small" color={palette.secondary} />
                                    ) : null}
                                </Pressable>
                            );
                        })}
                    </View>

                    {/* 页脚版本 meta（12 muted 档收口）：备份区之下的死白由这行
                        最小必要信息收尾（方向令 §2「eyebrow 二字类型词 + 最小必要
                        meta」；v0.4.6 起页脚版本号也是排障口径的落点） */}
                    <Text
                        className="mt-8 text-center text-[12px] text-ink-faint dark:text-inkd-faint"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {`Archive ${APP_VERSION}`}
                    </Text>
                </ScrollView>
            </View>
        </KeyboardAvoidingView>
    );
}

/**
 * 区块 eyebrow（方向令 §2 字阶档：11 / secondary / medium，区块题一律二字或短语）。
 * `first` = 首个区块：屏头 pb-3 已给 12dp，顶距收到 2（mb-2 之外只差 2dp 节奏）；
 * 其余区块用 mt-7（28dp）拉开分组呼吸带。
 */
function SectionEyebrow({ label, first = false }: { label: string; first?: boolean }) {
    return (
        <Text
            className={`mb-2 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary ${
                first ? 'mt-0.5' : 'mt-7'
            }`}
        >
            {label}
        </Text>
    );
}

/**
 * 外观卡（主题三档 + 图片对齐三档两行，卡内零 hairline）：v0.4.6 起分段
 * 控件收口到 ui/segmented（本页私有 CompactSegmented 退役——Me 页外观块
 * 早已整体迁入本页，两页不共用组件的旧注随之作废）。
 */
function AppearanceSection() {
    const [pref, setPref] = useThemePref();
    const [align, setAlign] = useMediaAlignPref();
    const themeOptions: Array<{ key: ThemePref; label: string }> = [
        { key: 'system', label: '跟随系统' },
        { key: 'light', label: '浅色模式' },
        { key: 'dark', label: '深色模式' },
    ];
    const alignOptions: Array<{ key: MediaAlign; label: string }> = [
        { key: 'left', label: '靠左' },
        { key: 'center', label: '居中' },
        { key: 'right', label: '靠右' },
    ];
    return (
        <>
            <SectionEyebrow label="外观" first />
            <View className="rounded-card bg-ink-surface px-5 py-1 dark:bg-inkd-surface" style={PAPER_CARD_SHADOW}>
                <View className="flex-row items-center justify-between gap-3 py-2.5">
                    <Text className="text-[16px] text-ink-text dark:text-inkd-text">主题</Text>
                    <Segmented<ThemePref> options={themeOptions} value={pref} onChange={setPref} labelPrefix="主题" />
                </View>
                <View className="flex-row items-center justify-between gap-3 py-2.5">
                    <Text className="text-[16px] text-ink-text dark:text-inkd-text">图片对齐</Text>
                    <Segmented<MediaAlign> options={alignOptions} value={align} onChange={setAlign} labelPrefix="图片对齐" />
                </View>
            </View>
        </>
    );
}

/**
 * 安全卡（App 锁三档分段 + 防截屏两档，两行同构：图标+label 左、Segmented
 * 右，行解剖与外观卡逐 dp 相同）。切档即存（archiveConfig 持久化）：App 锁由
 * AppLockGate 订阅同一生效档即时生效，离开 off 档的探测在屏层 setAppLockMode
 * 完成，不支持时经 store.error 通道说明、不写配置；防截屏由屏层
 * setPreventCapture 先执行系统能力、成功才写档（失败分段保持原档），冷启生效
 * 由根级 effect 读档应用（接线见 _layout）。
 */
function SecuritySection({
    onChange,
    onSetPreventCapture,
}: {
    onChange(next: AppLockMode): void;
    onSetPreventCapture(next: boolean): void;
}) {
    const palette = usePalette();
    // 订阅生效档位（门禁组件与分段行同一事实源，含旧布尔兼容归一）
    const mode = useAppLockMode();
    // 防截屏档位（config 订阅：切档成功写档后分段跟随；失败不写档保持原档）
    const preventCapture = archiveConfig.use((config) => config['security.preventCapture']);
    const modeOptions: Array<{ key: AppLockMode; label: string }> = [
        { key: 'off', label: '关闭' },
        { key: 'balanced', label: '平衡' },
        { key: 'aggressive', label: '激进' },
    ];
    const captureOptions: Array<{ key: 'off' | 'on'; label: string }> = [
        { key: 'off', label: '关闭' },
        { key: 'on', label: '开启' },
    ];
    return (
        <>
            <SectionEyebrow label="安全" />
            <View className="rounded-card bg-ink-surface px-5 py-1 dark:bg-inkd-surface" style={PAPER_CARD_SHADOW}>
                {/* App 锁行（label 左、分段右同一行；图标 18 secondary 是相对
                    外观行的唯一差异——安全语义的图标锚，无两行说明） */}
                <View className="flex-row items-center justify-between gap-3 py-2.5">
                    <View className="flex-row items-center gap-3">
                        <LucideLock size={18} strokeWidth={1.9} color={palette.secondary} />
                        <Text className="text-[16px] text-ink-text dark:text-inkd-text">App 锁</Text>
                    </View>
                    <Segmented options={modeOptions} value={mode} onChange={onChange} labelPrefix="App 锁" />
                </View>
                {/* 防截屏行（与 App 锁行同构）。平台差异不就地形文案（分段内不放
                    长说明）：Android 真防，iOS 近似防护，web 仅存档，能力注与
                    config 字段注已写 */}
                <View className="flex-row items-center justify-between gap-3 py-2.5">
                    <View className="flex-row items-center gap-3">
                        <LucideShield size={18} strokeWidth={1.9} color={palette.secondary} />
                        <Text className="text-[16px] text-ink-text dark:text-inkd-text">防截屏</Text>
                    </View>
                    <Segmented
                        options={captureOptions}
                        value={preventCapture ? 'on' : 'off'}
                        onChange={(key) => onSetPreventCapture(key === 'on')}
                        labelPrefix="防截屏"
                    />
                </View>
            </View>
        </>
    );
}
