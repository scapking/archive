import { useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    BackHandler,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    Text,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BouncyPressable, LucideCalendar, LucideTrash, LucideVideo } from '@/core/icons';
import { imagePicker } from '@/core/image-picker';
import { useArchiveStore } from './store';
import {
    dayDiff,
    isTripLocked,
    isTripOpenEnded,
    isValidLocalDate,
    validateTripInput,
} from './trip-logic';
import { safeBack } from './ui';
// 深路径注记：FieldInput 未入 ui/index.ts 出口（该文件不在本组改动权限内），
// 域内深取；ui/index.ts 出口扩充时收口（同 close-button / editor-icons 先例）。
import { FieldInput } from './ui/field-input';
import {
    DateInput,
    EmptyState,
    isDateInputComplete,
    PrimaryButton,
    ScreenHeader,
    TRIP_ICON_DEFAULT,
    TripBadge,
    TripCoverVideo,
    usePalette,
} from './ui';
import type { TripRow } from './db';

/**
 * 行程可选图标候选（即 DB 存储值，emoji 语义不变）：每项在 TripBadge 中都有对应的
 * 线性徽标呈现；🐼 无线性对应（呈现会退回 emoji 原样，选择环内观感不一），换 🧳。
 * 首位 🧭 与 TRIP_ICON_DEFAULT 同值，仅为展示顺序——默认值来源是具名常量，不是「取第一个」。
 */
const ICON_CHOICES = ['🧭', '⛰️', '🌊', '🏛️', '🏙️', '🚗', '✈️', '🚄', '🏕️', '🍜', '📷', '🎡', '⛷️', '🏝️', '🧳', '🗺️'];

/** 分区容器：13px 小节标题 + 内容（分组是信息结构，不是装饰）。 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <View className="mt-5">
            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                {title}
            </Text>
            {children}
        </View>
    );
}

/**
 * 结束日期语义分段切换（DEV.md #4：结束日期可选，默认「持续进行」）。
 * 轨道 = surface 底；选中段 = raised 底 + 主文本色（亮度变化语言，不上彩——
 * 颜色只上数据，选中是交互态不是数据）。相邻两段 gap-1（4px）且均不传 hitSlop
 * （0）：命中区 == 视觉盒（h-11 ≥44 规范），4px 为停车距，无重叠核算项。
 * 按压范式收敛（一致性审计轮）：分段控制的按压反馈统一为 active: 底色一档
 * （与 Me 外观分段 / 搜索范围分段同一轨道 + 同一亮度语言），不再走 Bouncy 弹跳。
 */
function EndModeSwitch({
    mode,
    onChange,
}: {
    mode: 'open' | 'fixed';
    onChange(mode: 'open' | 'fixed'): void;
}) {
    const options = [
        { key: 'open' as const, label: '持续进行' },
        { key: 'fixed' as const, label: '设定结束' },
    ];
    return (
        <View
            className="flex-row gap-1 rounded-control bg-ink-surface p-1 dark:bg-inkd-surface"
            accessibilityRole="radiogroup"
        >
            {options.map((option) => {
                const active = mode === option.key;
                return (
                    // 分段本体即按压体（flex-1 撑等宽两段；结构对齐 ThemeSection 分段）
                    <Pressable
                        key={option.key}
                        onPress={() => onChange(option.key)}
                        accessibilityRole="radio"
                        accessibilityLabel={option.label}
                        accessibilityState={{ selected: active }}
                        className={`h-11 flex-1 items-center justify-center rounded-control active:bg-ink-raised dark:active:bg-inkd-raised ${
                            active
                                ? 'bg-ink-raised dark:bg-inkd-raised'
                                : 'bg-ink-surface dark:bg-inkd-surface'
                        }`}
                    >
                        <Text
                            className={`text-[15px] font-medium ${
                                active
                                    ? 'text-ink-text dark:text-inkd-text'
                                    : 'text-ink-secondary dark:text-inkd-secondary'
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

/**
 * 删除钮（二次确认态由父级持有）：普通表单危险区与锁定只读态共用同一决策点，
 * 避免「锁定了却连删都删不掉」的死角（#7 锁的是内容修改，删行程不是内容修改）。
 */
function DeleteTripControl({
    confirmDelete,
    onPress,
}: {
    confirmDelete: boolean;
    onPress(): void;
}) {
    const palette = usePalette();
    return (
        <Pressable
            onPress={onPress}
            className={`h-12 items-center justify-center rounded-control border ${
                confirmDelete
                    ? 'border-ink-negative bg-ink-negative-bg dark:border-inkd-negative dark:bg-inkd-negative-bg'
                    : // 条件类铁律：bg-transparent 会缺 --tw-bg-opacity 变量槽位，用 base 底
                      //（按钮坐在 base 画布上，视觉等价透明）保持两侧变量集恒等
                      'border-ink-border bg-ink-base dark:border-inkd-border dark:bg-inkd-base'
            }`}
            accessibilityRole="button"
            accessibilityLabel="删除行程"
        >
            <View className="flex-row items-center gap-1.5">
                <LucideTrash size={14} color={palette.negative} />
                <Text className="text-[13px] font-medium text-ink-negative dark:text-inkd-negative">
                    {/* 二次确认文案对齐 store.deleteTrip 的级联行为（日记/媒体/计划一并软删）：
                        危险操作必须把真实影响面说在确认文案里，不能只说「确认删除」 */}
                    {confirmDelete ? '将同时删除该行程下的全部日记与照片视频，再点一次确认删除' : '删除行程'}
                </Text>
            </View>
        </Pressable>
    );
}

/**
 * 行程表单（新建 / 编辑双模式，DEV.md #4 工作台口径的「创建像笔记一样轻量」）：
 * 标题 + 出发日期必填；结束日期可选——分段切换「持续进行（默认）/ 设定结束」；
 * 描述可选；图标保留（TripBadge 选择格）。提交统一走 endDate: string | null
 * 语义（null = 持续进行，store 落 TRIP_OPEN_ENDED 哨兵），日期原值透传
 * （#2：date-input 的自然输入归一已在组件内完成，表单不再二次加工）。
 * 已结束行程（isTripLocked）整表只读锁定：直达深链在此拦下，删除入口保留。
 */
export function TripFormScreen({ trip }: { trip?: TripRow } = {}) {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const createTrip = useArchiveStore((s) => s.createTrip);
    const updateTrip = useArchiveStore((s) => s.updateTrip);
    const deleteTrip = useArchiveStore((s) => s.deleteTrip);
    const attachTripVideo = useArchiveStore((s) => s.attachTripVideo);
    const storeError = useArchiveStore((s) => s.error);

    // 默认初始图标 = 具名常量（TripBadge 内空值兜底同源）；编辑模式下 trip.icon 为历史
    // 空值时仍回退到同一常量，两条路径共用一个决策点，不再散落字面量
    const [icon, setIcon] = useState<string | null>(trip?.icon ?? TRIP_ICON_DEFAULT);
    const [title, setTitle] = useState(trip?.title ?? '');
    const [startDate, setStartDate] = useState(trip?.start_date ?? '');
    // 结束语义：'open' = 持续进行 / 'fixed' = 有返回日。编辑既有行程按 end_date
    // 哨兵初始化，新建默认 open；DateInput 值域是日期串，'open' 绝不能进输入框
    const [endMode, setEndMode] = useState<'open' | 'fixed'>(
        trip && !isTripOpenEnded(trip) ? 'fixed' : 'open',
    );
    const [endDate, setEndDate] = useState(
        trip && !isTripOpenEnded(trip) ? trip.end_date : '',
    );
    const [description, setDescription] = useState(trip?.description ?? '');
    const [videoKey, setVideoKey] = useState<string | null>(trip?.video_key ?? null);
    const [submitting, setSubmitting] = useState(false);
    const [videoBusy, setVideoBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    const isEdit = Boolean(trip);
    // 锁定（#7）：已结束行程只读。store.updateTrip 无锁预检，UI 是唯一闸门——
    // 详情页已隐藏编辑入口，这里拦直达 /trip/[id]/edit 的深链路径
    const locked = isEdit && trip ? isTripLocked(trip) : false;

    // 提交语义单一出口：open 模式 endDate = null（持续性），fixed 模式原值透传
    const endDateValue = endMode === 'fixed' ? endDate : null;
    const validation = useMemo(
        () => validateTripInput({ title, startDate, endDate: endDateValue }),
        [title, startDate, endDateValue],
    );
    const canSubmit =
        !submitting &&
        validation === null &&
        isDateInputComplete(startDate) &&
        (endMode === 'open' || isDateInputComplete(endDate));
    // 即时天数反馈（仅固定结束态）：持续进行无固定跨度，不渲染「共 N 天」
    const dayCount =
        endMode === 'fixed' &&
        isDateInputComplete(startDate) &&
        isDateInputComplete(endDate) &&
        endDate >= startDate &&
        isValidLocalDate(startDate)
            ? dayDiff(startDate, endDate) + 1
            : null;

    // Android 硬件返回先退出删除二次确认态，不直接退屏（写法参照 archive-screen）
    useEffect(() => {
        if (!confirmDelete) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            setConfirmDelete(false);
            return true;
        });
        return () => sub.remove();
    }, [confirmDelete]);

    const switchEndMode = (mode: 'open' | 'fixed') => {
        setEndMode(mode);
        // 切到固定结束且结束日无效时用出发日兜底：同日往返是最常见形态，
        // 让用户从「合法值」上改比从空值上填少一步（可随时清空重填）
        if (mode === 'fixed' && !isDateInputComplete(endDate) && isDateInputComplete(startDate)) {
            setEndDate(startDate);
        }
    };

    const submit = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        try {
            if (trip) {
                const ok = await updateTrip(trip.id, {
                    title,
                    startDate,
                    endDate: endDateValue,
                    description,
                    icon,
                    videoKey,
                });
                if (ok) safeBack();
                return;
            }
            const created = await createTrip({
                title,
                startDate,
                endDate: endDateValue,
                description,
                icon,
            });
            if (created) router.replace({ pathname: '/trip/[id]', params: { id: created.id } });
        } catch (caught) {
            // 防御：updateTrip/createTrip 契约不 throw（失败走 false/null + store.error），
            // 这里只兜环境级意外，不让异常变 unhandled rejection
            useArchiveStore.setState({
                error: `保存失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            // 中断场景：store 方法意外 reject 时复位提交态——PrimaryButton 由
            // submitting 禁用，不复位 = 按钮永久禁用；常规失败走 false/null +
            // store.error（不禁按钮，可直接重试）
            setSubmitting(false);
        }
    };

    const pickVideo = async () => {
        if (videoBusy || !trip) return;
        setVideoBusy(true);
        try {
            const permission = await imagePicker.getMediaLibraryPermissionAsync();
            if (!permission.granted) {
                const requested = await imagePicker.requestMediaLibraryPermissionAsync();
                if (!requested.granted) {
                    useArchiveStore.setState({ error: '没有相册权限，去系统设置里开一下。' });
                    return;
                }
            }
            const result = await imagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], quality: 1 });
            if (result.canceled || result.assets.length === 0) return;
            const ok = await attachTripVideo(trip.id, result.assets[0].uri);
            // key 规则确定（trip-video/<id>.mp4），上传成功即回填预览
            if (ok) setVideoKey(`trip-video/${trip.id}.mp4`);
        } catch (caught) {
            // picker 抛错必须可见（对齐 journal-edit-screen 的 pick 写法），不能是 unhandled rejection
            useArchiveStore.setState({
                error: `视频选取失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            setVideoBusy(false);
        }
    };

    const removeVideo = async () => {
        if (!trip) return;
        setVideoKey(null); // 乐观摘预览（成功路径即时反馈，行为不变）
        const ok = await updateTrip(trip.id, { videoKey: null });
        // 失败回滚预览：防「界面删了、数据还在」的半更新态（失败文案经 store.error 上浮）
        if (!ok) setVideoKey(trip.video_key ?? null);
    };

    const remove = async () => {
        if (!trip) return;
        if (!confirmDelete) {
            setConfirmDelete(true);
            return;
        }
        const ok = await deleteTrip(trip.id);
        if (ok) safeBack();
    };

    // 锁定只读态（#7）：内容字段全部不可达，只保留「返回 + 删除」。
    // 删除保留的原因：已结束行程仍需可清理，否则旧行程在 UI 层无任何删除路径
    if (locked) {
        return (
            <View className="flex-1 bg-ink-base dark:bg-inkd-base">
                <View className="flex-1" style={{ paddingTop: insets.top }}>
                    <ScreenHeader title="行程" />
                    <EmptyState
                        icon={<LucideCalendar size={40} color={palette.muted} strokeWidth={1.5} />}
                        title="行程已完成，内容锁定"
                        hint="已结束的行程只读，不能修改内容。"
                        actionLabel="返回"
                        onAction={safeBack}
                    />
                    <View
                        className="border-t border-ink-rule px-6 pt-5 dark:border-inkd-rule"
                        style={{ paddingBottom: insets.bottom + 24 }}
                    >
                        <DeleteTripControl confirmDelete={confirmDelete} onPress={() => void remove()} />
                    </View>
                </View>
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-ink-base dark:bg-inkd-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView
                contentContainerStyle={{
                    // 顶部只垫 insets.top：屏头带顶距的 pt-2(8) 由 ScreenHeader 容器
                    // 自带（四屏统一口径 = insets.top + 8 + h-11(44)）。旧写法在此
                    // 再 +8，与 ScreenHeader 的 pt-2 双计，屏头带比笔记编辑/行程
                    // 详情/搜索低 8dp（用户反馈「顶部不一致」的修前主因之一）
                    paddingTop: insets.top,
                    paddingBottom: insets.bottom + 32,
                    paddingHorizontal: 24,
                }}
                keyboardShouldPersistTaps="handled"
            >
                <ScreenHeader
                    title={isEdit ? '编辑行程' : '新建行程'}
                    subtitle={isEdit ? '修改后立即生效。' : '起个名字，定个出发日就好。'}
                />

                {/* 图标 + 名称 */}
                <Section title="图标与名称">
                    {/* 选择格：44×44（360dp 宽下 6 列/行），命中区=格本体（Pressable 无 slop，
                        gap-2 = 8px 停车距，互不交叠）；按压反馈沿用 active: 体系（格内
                        TripBadge 不透明底会盖住 active:bg，故用整格降透明度）；选中态由
                        TripBadge 呈现（accent 框/底/图形，条件类变量集恒等）。 */}
                    <View className="flex-row flex-wrap gap-2">
                        {ICON_CHOICES.map((choice) => {
                            const active = icon === choice;
                            return (
                                <Pressable
                                    key={choice}
                                    onPress={() => setIcon(choice)}
                                    className="active:opacity-80"
                                    accessibilityRole="button"
                                    accessibilityLabel={`图标 ${choice}`}
                                    accessibilityState={{ selected: active }}
                                >
                                    <TripBadge icon={choice} size="cell" selected={active} />
                                </Pressable>
                            );
                        })}
                    </View>
                    <View className="mt-3">
                        {/* #1 推广收口：标题输入换 FieldInput（tone surface，容器承载
                            视觉 + 聚焦亮度一档 + 平台 props 单点收口），表单逻辑零改动。
                        标题输入放大（#尺寸组反馈，二轮纠正）：用户要的是「盒子大了、
                        字不变」——容器保持 h-14（56dp）档，文字不传 style 覆盖即回落
                        FIELD_TONE_TEXT.surface 默认 15/22 normal（撤销上一轮
                        20/semibold/lineHeight-28 覆盖）。containerClassName 追加到
                        容器（height 56 与默认 min-h-44 并存取大者）；输入体在容器内
                        stretch 填满（field-input 填充轮），点击区/视觉与容器一致，
                        文字垂直居中由输入体承担，props 覆盖即可、其他调用点
                        （描述/内联计划输入）不受影响 */}
                        <FieldInput
                            tone="surface"
                            value={title}
                            onChangeText={setTitle}
                            placeholder="比如：京都红叶五日"
                            maxLength={40}
                            returnKeyType="next"
                            containerClassName="h-14"
                        />
                    </View>
                </Section>

                {/* 日期：结束可选（DEV.md #4）——分段切换「持续进行 / 设定结束」 */}
                <Section title="日期">
                    <EndModeSwitch mode={endMode} onChange={switchEndMode} />
                    {endMode === 'open' ? (
                        <View className="mt-3">
                            <Text className="mb-1.5 text-[11px] text-ink-muted dark:text-inkd-muted">出发</Text>
                            <DateInput value={startDate} onChange={setStartDate} />
                        </View>
                    ) : (
                        <View className="mt-3 flex-row items-end gap-3">
                            <View className="flex-1">
                                <Text className="mb-1.5 text-[11px] text-ink-muted dark:text-inkd-muted">出发</Text>
                                <DateInput value={startDate} onChange={setStartDate} />
                            </View>
                            {/* 箭头基线随 DateInput 高度收敛（h-12→h-11）下移一档：pb-2.5 */}
                            <Text className="pb-2.5 text-ink-muted dark:text-inkd-muted">→</Text>
                            <View className="flex-1">
                                <Text className="mb-1.5 text-[11px] text-ink-muted dark:text-inkd-muted">返回</Text>
                                <DateInput value={endDate} onChange={setEndDate} />
                            </View>
                        </View>
                    )}
                    {endMode === 'open' ? (
                        <Text className="mt-2 text-[12px] text-ink-secondary dark:text-inkd-secondary">
                            持续进行 · 不设固定结束，从出发日开始累积
                        </Text>
                    ) : (
                        <Text
                            className="mt-2 text-[12px] text-ink-secondary dark:text-inkd-secondary"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {dayCount !== null ? `共 ${dayCount} 天，每天会自动生成一格` : '填完返回日期自动算天数'}
                        </Text>
                    )}
                </Section>

                {/* 描述（可选） */}
                <Section title="描述">
                    {/* 多行起手高度 + 顶距（#尺寸组反馈，二轮纠正）：描述首行与容器顶缘
                        间距明显加大——多行态文字从顶部排，在调用侧给 TextInput
                        paddingTop 16（pt-4 档）：调用侧 style 位于合并数组末位，且 Yoga
                        中具体边缘属性 paddingTop 覆盖 INPUT_TRANSPARENT_STYLE 的简写
                        paddingVertical:0 → 生效顶距 = 容器 py-2 上沿 8 + 内衬 16 =
                        24（修前 8）。minHeight 80 为 Yoga border-box（含内衬），三行
                        16+66=82 微超即自然撑开一档，自动增高与光标位置不受影响，
                        继续增高仍随内容自然撑开；填充轮后输入体在容器内 stretch，
                        多行内容增长时容器随内容撑开的语义不变 */}
                    <FieldInput
                        tone="surface"
                        multiline
                        value={description}
                        onChangeText={setDescription}
                        placeholder="一句话说明这次出行（可选）"
                        maxLength={500}
                        style={{ minHeight: 80, paddingTop: 16 }}
                    />
                </Section>

                {/* 封面视频（编辑模式；锁定态整表已提前返回，不会到这里） */}
                {isEdit ? (
                    <Section title="封面视频">
                        {videoKey ? (
                            <View className="gap-2">
                                <TripCoverVideo fileKey={videoKey} height={176} />
                                {/* 更换/移除并排：两钮同高 44 且「更换」闭 slop（0）——原 40 高 +
                                    BouncyPressable 默认 hitSlop 10 会跨过 8px gap 压进「移除」左缘
                                    2px，边缘点击误触发更换；44 高本体已达命中规范，slop 无必要 */}
                                <View className="flex-row gap-2">
                                    <BouncyPressable onPress={() => void pickVideo()} scaleTo={0.97} hitSlop={0}>
                                        <View className="h-11 items-center justify-center rounded-control border border-ink-border bg-ink-surface px-4 dark:border-inkd-border dark:bg-inkd-surface">
                                            <Text className="text-[13px] text-ink-secondary dark:text-inkd-secondary">
                                                更换
                                            </Text>
                                        </View>
                                    </BouncyPressable>
                                    <Pressable
                                        onPress={() => void removeVideo()}
                                        className="h-11 items-center justify-center rounded-control border border-ink-border bg-ink-surface px-4 dark:border-inkd-border dark:bg-inkd-surface"
                                    >
                                        <Text className="text-[13px] text-ink-negative dark:text-inkd-negative">
                                            移除
                                        </Text>
                                    </Pressable>
                                </View>
                            </View>
                        ) : (
                            <BouncyPressable onPress={() => void pickVideo()} scaleTo={0.98}>
                                {/* 按压反馈由外层 BouncyPressable 弹跳承担：内层 View 不用
                                    active: 伪类（css-interop 会把 View 升级成 Pressable
                                    首帧后 remount，触摸中途被杀——同 ChooserRow/MenuRow 口径） */}
                                <View
                                    className={`h-[104px] items-center justify-center gap-1.5 rounded-control border border-dashed border-ink-border bg-ink-surface dark:border-inkd-border dark:bg-inkd-surface ${
                                        videoBusy ? 'opacity-50' : ''
                                    }`}
                                    accessibilityRole="button"
                                    accessibilityLabel="选择封面视频"
                                >
                                    <LucideVideo size={20} strokeWidth={1.9} color={palette.muted} />
                                    <Text className="text-[13px] text-ink-secondary dark:text-inkd-secondary">
                                        {videoBusy ? '上传中…' : '从相册选择视频'}
                                    </Text>
                                    <Text className="text-[11px] text-ink-muted dark:text-inkd-muted">
                                        展示在行程页顶部
                                    </Text>
                                </View>
                            </BouncyPressable>
                        )}
                    </Section>
                ) : null}

                {validation ? (
                    <Text className="mt-4 text-[12px] text-ink-negative dark:text-inkd-negative">{validation}</Text>
                ) : null}
                {!validation && storeError ? (
                    <Text className="mt-4 text-[12px] text-ink-negative dark:text-inkd-negative">{storeError}</Text>
                ) : null}

                <View className="mt-6">
                    <PrimaryButton
                        label={isEdit ? '保存修改' : '创建行程'}
                        onPress={() => void submit()}
                        disabled={!canSubmit}
                    />
                </View>

                {/* 危险区（编辑模式）：与主流程隔开 */}
                {isEdit ? (
                    <View className="mt-8 border-t border-ink-rule pt-5 dark:border-inkd-rule">
                        <DeleteTripControl confirmDelete={confirmDelete} onPress={() => void remove()} />
                    </View>
                ) : null}

                {submitting || videoBusy ? (
                    <ActivityIndicator color={palette.spinner} style={{ marginTop: 12 }} />
                ) : null}
            </ScrollView>
        </KeyboardAvoidingView>
    );
}
