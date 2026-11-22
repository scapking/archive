import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Animated,
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
import { ScreenHeader, usePalette, useThemePref, type ThemePref } from './ui';
// 深路径注记：useMediaAlignPref/MediaAlign 未入 ui/index.ts 出口（theme.ts 在
// 本组改动权限外的既有先例——me-screen 同款深取），域内深取。
import { useMediaAlignPref, type MediaAlign } from './ui/theme';

/**
 * 设置页（新1：Me 的 导出 / App 锁 / 外观 三块合并收口）：入口 = Me 页
 * 「我的内容」卡的「设置」行（点按进入本页），区块自上而下——
 *
 * - **外观**：主题三档 + 图片对齐三档（与 Me 页原外观卡同一行语言：label 左
 *   14px medium + CompactSegmented 右，卡内零 hairline）；
 * - **安全**：App 锁三档分段（关闭 / 平衡 / 激进；离开 off 档前探测本机认证
 *   手段，不支持就地说明——放行一个必然把人锁在门外的配置没有意义）；
 * - **备份与恢复（置底，用户指令「导出必须是最底部的」）**：导出全量备份
 *   （zip：全部行 + 图片/视频/音频二进制）→ 导入备份（选包自动恢复，合并
 *   语义无缝续用）→ 导出文稿（PDF，web 降级 HTML 下载）。导出/导入走系统
 *   分享/文件面板；成功静默 + 就地完成横幅（导入有计数反馈），失败进
 *   store.error 红字横幅（屏头下方，可重试）。
 *
 * **传输面注记**：跨设备 = 分享面板传同一个 zip 包（AirDrop/网盘/IM 任选）；
 * 局域网设备直传依赖常驻 HTTP 服务，Expo Go 运行时无此能力（见 export.ts
 * 头注），未实现。
 */

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
                        paddingBottom: insets.bottom + 32,
                    }}
                    keyboardShouldPersistTaps="handled"
                >
                    {/* store.error 通道（App 锁探测/备份失败等）统一在此可见 */}
                    {storeError ? (
                        <Text className="mt-3 text-[12px] text-ink-negative dark:text-inkd-negative">
                            {storeError}
                        </Text>
                    ) : null}
                    {importNotice ? (
                        <Text className="mt-3 text-[12px] text-ink-secondary dark:text-inkd-secondary">
                            {importNotice.text}
                        </Text>
                    ) : null}

                    <AppearanceSection />
                    <SecuritySection
                        onChange={(next) => void setAppLockMode(next)}
                        onSetPreventCapture={(next) => void setPreventCapture(next)}
                    />

                    {/* 备份与恢复（用户指令：导出置底——区块排在页面最末） */}
                    <View className="mt-6">
                        <Text className="mb-3 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                            备份与恢复
                        </Text>
                        <View className="rounded-card bg-ink-surface dark:bg-inkd-surface">
                            {rows.map((row, index) => {
                                const busy = busyAction === row.action;
                                const locked = busyAction != null;
                                return (
                                    <Pressable
                                        key={row.action}
                                        onPress={() => void runBackupAction(row.action)}
                                        disabled={locked}
                                        // 行级 active 高亮（iOS 设置列表式，同 Me 内容卡
                                        // 统一按压语言）；行间贴靠 px-4 左缘统一
                                        className={`flex-row items-center gap-3 px-4 py-3.5 active:bg-ink-raised dark:active:bg-inkd-raised ${
                                            index === 0 ? '' : 'mt-0.5'
                                        } ${locked && !busy ? 'opacity-40' : ''}`}
                                        accessibilityRole="button"
                                        accessibilityLabel={row.title}
                                    >
                                        <View className="w-6 items-center">
                                            {row.icon}
                                        </View>
                                        <Text className="min-w-0 flex-1 text-[14px] font-medium text-ink-text dark:text-inkd-text">
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
                    </View>
                </ScrollView>
            </View>
        </KeyboardAvoidingView>
    );
}

/**
 * 外观卡（自 Me 页外观卡原样迁入：主题三档 + 图片对齐三档两行，卡内零
 * hairline；CompactSegmented 同文件私有——Me 页外观块已整体迁入本页，原
 * 私有实现随迁，两页不再共用此组件）。
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
        <View className="mt-4">
            <Text className="mb-3 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                外观
            </Text>
            <View className="rounded-card bg-ink-surface dark:bg-inkd-surface">
                <View className="flex-row items-center justify-between px-4 pt-4">
                    <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">主题</Text>
                    <CompactSegmented options={themeOptions} value={pref} onChange={setPref} labelPrefix="主题" />
                </View>
                <View className="mb-1 mt-2 flex-row items-center justify-between px-4 pb-3">
                    <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">图片对齐</Text>
                    <CompactSegmented options={alignOptions} value={align} onChange={setAlign} labelPrefix="图片对齐" />
                </View>
            </View>
        </View>
    );
}

/**
 * 安全卡（App 锁三档分段 + 防截屏两档，两行同构：图标+label 左、CompactSegmented
 * 右，行结构与 padding 照抄 AppearanceSection 的主题/图片对齐两行——2026-11-20
 * 回归同行排版：分段控件已收窄（CompactSegmented 紧凑几何），App 锁/防截屏
 * label 均为短词且 modeHint 长说明行已删，同行不再有溢出/挤压风险，与外观卡
 * 完全对齐，弃用 2026-11-19 为溢出临时改的上下两段结构）。
 * 切档即存（archiveConfig 持久化）：App 锁由 AppLockGate 订阅同一生效档即时
 * 生效，离开 off 档的探测在屏层 setAppLockMode 完成，不支持时经 store.error
 * 通道说明、不写配置；防截屏由屏层 setPreventCapture 先执行系统能力、成功才
 * 写档（失败分段保持原档），冷启生效由根级 effect 读档应用（接线见 _layout）。
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
        <View className="mt-6">
            <Text className="mb-3 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                安全
            </Text>
            {/* 卡体不带 px/py（同外观卡）：上下边距由首行 pt-4 / 末行 mb-1 pb-3
                承担，行结构照抄 AppearanceSection 两行 */}
            <View className="rounded-card bg-ink-surface dark:bg-inkd-surface">
                {/* App 锁行（同主题行排版：label 左、分段右同一行；左侧图标+
                    label 组是相对外观行唯一差异——无图标容器、无两行说明） */}
                <View className="flex-row items-center justify-between px-4 pt-4">
                    <View className="flex-row items-center gap-3">
                        <LucideLock size={18} strokeWidth={1.9} color={palette.secondary} />
                        <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                            App 锁
                        </Text>
                    </View>
                    <CompactSegmented
                        options={modeOptions}
                        value={mode}
                        onChange={onChange}
                        labelPrefix="App 锁"
                    />
                </View>
                {/* 防截屏行（同图片对齐行排版，与 App 锁行同构：图标+label 左、
                    分段右）。平台差异不就地形文案（分段内不放长说明）：
                    Android 真防，iOS 近似防护，web 仅存档，能力注与 config
                    字段注已写 */}
                <View className="mb-1 mt-2 flex-row items-center justify-between px-4 pb-3">
                    <View className="flex-row items-center gap-3">
                        <LucideShield size={18} strokeWidth={1.9} color={palette.secondary} />
                        <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                            防截屏
                        </Text>
                    </View>
                    <CompactSegmented
                        options={captureOptions}
                        value={preventCapture ? 'on' : 'off'}
                        onChange={(key) => onSetPreventCapture(key === 'on')}
                        labelPrefix="防截屏"
                    />
                </View>
            </View>
        </View>
    );
}

/**
 * 紧凑分段滑块（自 Me 页原样迁入，几何/命中/动画取舍注释见原实现——逐段
 * 实测宽度 + 内联 style 滑块 + 轨道 overflow-hidden；Animated 系组件的
 * className 在 web 被 css-interop 静默丢弃，几何一律内联 style）。
 */
function CompactSegmented<T extends string>({
    options,
    value,
    onChange,
    labelPrefix,
}: {
    options: Array<{ key: T; label: string }>;
    value: T;
    onChange: (key: T) => void;
    labelPrefix: string;
}) {
    const [segWidths, setSegWidths] = useState<number[]>([]);
    const placedRef = useRef(false);
    const sliderX = useRef(new Animated.Value(0)).current;
    const activeIndex = Math.max(0, options.findIndex((option) => option.key === value));
    // 逐段实测：offsets = 前缀和（段间零间隙，实测段宽和恒等于轨道内容区宽）
    const measured = segWidths.length === options.length && segWidths.every((width) => width > 0);
    let acc = 0;
    const offsets = options.map((_, index) => {
        const offset = acc;
        acc += segWidths[index] ?? 0;
        return offset;
    });
    const segW = measured ? segWidths[activeIndex] : 0;
    useEffect(() => {
        if (!measured) return;
        const target = offsets[activeIndex];
        if (!placedRef.current) {
            placedRef.current = true;
            sliderX.setValue(target);
            return;
        }
        const spring = Animated.spring(sliderX, { toValue: target, friction: 9, useNativeDriver: true });
        spring.start();
        return () => spring.stop();
        // offsets 随 segWidths 派生（O(段数) 每渲染直算），activeIndex 选中变更即重瞄准
    }, [activeIndex, measured, offsets, sliderX]);
    return (
        <View className="flex-row overflow-hidden rounded-control bg-ink-border p-1 dark:bg-inkd-border">
            {/* 滑块：纯视觉层先渲染（段落文字浮其上），几何内联 style（web 可靠性
                见组件注），涂装在内层普通 View；实测未就绪时宽 0 不可见 */}
            <Animated.View
                pointerEvents="none"
                style={{
                    position: 'absolute',
                    top: 4,
                    bottom: 4,
                    left: 4,
                    width: segW,
                    transform: [{ translateX: sliderX }],
                }}
            >
                <View className="h-full w-full rounded-thumb bg-ink-base dark:bg-inkd-base" />
            </Animated.View>
            {options.map((option, index) => {
                const active = value === option.key;
                return (
                    <Pressable
                        key={option.key}
                        onPress={() => onChange(option.key)}
                        hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
                        className="h-8 items-center justify-center px-4"
                        onLayout={(event) =>
                            setSegWidths((prev) => {
                                const width = event.nativeEvent.layout.width;
                                if (prev[index] === width) return prev;
                                const next = [...prev];
                                next[index] = width;
                                return next;
                            })
                        }
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={`${labelPrefix}：${option.label}`}
                    >
                        <Text
                            className={`text-[12px] ${
                                active
                                    ? 'font-medium text-ink-text dark:text-inkd-text'
                                    : 'text-ink-muted dark:text-inkd-muted'
                            }`}
                        >
                            {option.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
