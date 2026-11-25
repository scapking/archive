import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LucideCalendar } from '@/core/icons';
import { haptics } from '@/core/haptics';
import { todayLocal } from '../trip-logic';
import { formatDateFieldLabel, inDateRange } from '../calendar-logic';
import { Calendar, type CalendarDayMark } from './calendar';
import { DateInput, isDateInputComplete } from './date-input';
import { CloseButton } from './close-button';
import { usePalette } from './theme';
import { PAPER_FLOAT_SHADOW } from './paper-shadow';
import { PrimaryButton } from './primary-button';

/**
 * 日期选择族（v0.4.7 行程域重构令 2：「一眼、两步、不出错」的苹果式选择）：
 *
 * - `DateField`：表单里的日期「字段面」——不是裸输入框而是可点纸井（raised 档
 *   h-14 ≥44 命中），直接显示格式化文案（「11月13日 周五」跨年自动补年份）；
 *   一眼 = 打开表单先看见的是日期本身，不是三段数字格；
 * - `DatePickerSheet`：点字段弹出的月历浮层（scrim + 悬浮纸卡，禁 RN Modal
 *   条件渲染，范式同 DayActionCard / chooser 卡体）——两步 = 开层点日即完成
 *   并回写；不出错 = 区间外日期在网格层禁选（min/max 由调用方给），不可能
 *   经选择器产出非法日；「手输」兜底通道保留键盘/三端可达（DateInput 渐进
 *   归一 + 补零语义原样复用），且同样过区间闸。
 *
 * 质感纪律：全部走 ui/paper-shadow 光影档 + ink/inkd token（浮层用
 * PAPER_FLOAT，静止面用井/纸色分层），禁散写 hex；字阶 eyebrow 11 / 正文 16。
 *
 * 消费面：trip-form-screen（出发/返回两字段）。搜索页的区间筛选保持
 * search-screen 现形态（agent B 域，本组件不强加）。
 */

/** 空标记表（模块级稳定引用——Calendar memo 契约：marks 引用不稳 = 整树重渲）。 */
const NO_MARKS: ReadonlyMap<string, CalendarDayMark> = new Map();

/**
 * 日期字段面（raised 纸井，h-14）：value 完整显示格式化文案，未设/不完整落
 * placeholder；右侧日历图标 18 secondary 作「可点」锚（图标 pointerEvents
 * none，命中恒归字段本体）。
 */
export function DateField({
    value,
    onPress,
    accessibilityLabel,
    placeholder = '选择日期',
}: {
    /** 'YYYY-MM-DD'（或任何不完整串——按未设处理）。 */
    value: string;
    onPress(): void;
    accessibilityLabel: string;
    placeholder?: string;
}) {
    const palette = usePalette();
    const label = useMemo(() => formatDateFieldLabel(value, Number(todayLocal().slice(0, 4))), [value]);
    // 条件类铁律：文字颜色两分支同槽位（text 尺寸恒定）
    const textClass = label
        ? 'text-[16px] font-medium text-ink-text dark:text-inkd-text'
        : 'text-[16px] text-ink-muted dark:text-inkd-muted';
    return (
        <Pressable
            onPress={onPress}
            className="h-14 flex-row items-center justify-between rounded-control bg-ink-raised px-4 active:opacity-70 dark:bg-inkd-raised"
            accessibilityRole="button"
            accessibilityLabel={`${accessibilityLabel}：${label ?? '未设置'}`}
        >
            <Text numberOfLines={1} className={`min-w-0 flex-1 ${textClass}`} style={{ fontVariant: ['tabular-nums'] }}>
                {label ?? placeholder}
            </Text>
            <View pointerEvents="none">
                <LucideCalendar size={18} strokeWidth={1.9} color={palette.secondary} />
            </View>
        </Pressable>
    );
}

export interface DatePickerSheetProps {
    /** 字段语义标题（eyebrow：「出发日期」「返回日期」）。 */
    title: string;
    /** 当前值（打开即落其所在月；null/不完整 = 落今天月）。 */
    value: string;
    /** 可选闭区间（区间外网格禁选 + 手输确认闸）。 */
    minDate?: string | null;
    maxDate?: string | null;
    /** 选定回调（上抛必为完整、合法、区间内日期；浮层不自动关，关闭时机归调用方）。 */
    onPick(date: string): void;
    onClose(): void;
}

/**
 * 月历选择浮层。挂载即建（父级条件渲染 `{picker ? <DatePickerSheet/> : null}`），
 * 每次打开重挂 → 初始月天然跟随当前值，无受控同步问题。
 */
export function DatePickerSheet({ title, value, minDate, maxDate, onPick, onClose }: DatePickerSheetProps) {
    const insets = useSafeAreaInsets();
    // 手输兜底态（键盘可达性：web/外接键盘用户可跳过网格直接敲数字；
    // DateInput 的渐进归一/失焦补零语义原样复用，「不出错」闸同样生效）
    const [manual, setManual] = useState(false);
    const [draft, setDraft] = useState(value);

    useEffect(() => {
        // 打开即收键盘（浮层自身无输入时不留残键盘；手输态由用户主动唤起）
        Keyboard.dismiss();
    }, []);
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose]);

    const handlePickDay = useCallback(
        (date: string) => {
            // 防御闸：Calendar 已禁选区间外日，这里再兜一层（调用方传错
            // min/max 时宁可无响应也不上抛非法值——「不出错」是硬承诺）
            if (!inDateRange(date, minDate, maxDate)) return;
            haptics.selection();
            onPick(date);
        },
        [minDate, maxDate, onPick],
    );

    const draftValid = isDateInputComplete(draft) && inDateRange(draft, minDate, maxDate);
    const handleConfirmManual = useCallback(() => {
        if (!draftValid) return;
        haptics.selection();
        onPick(draft);
    }, [draftValid, draft, onPick]);

    // 区间提示（手输态可见，网格态由禁选视觉直接表达不上字）
    const rangeHint = useMemo(() => {
        const from = minDate ? formatDateFieldLabel(minDate, Number(todayLocal().slice(0, 4))) : null;
        const to = maxDate ? formatDateFieldLabel(maxDate, Number(todayLocal().slice(0, 4))) : null;
        if (from && to) return `可选 ${from} – ${to}`;
        if (from) return `不早于 ${from}`;
        if (to) return `不晚于 ${to}`;
        return null;
    }, [minDate, maxDate]);

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 justify-end bg-ink-scrim px-3 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel="关闭日期选择"
            >
                {/* 卡体拦截冒泡（点卡不关，范式同 DayActionCard / chooser） */}
                <Pressable
                    className="rounded-card bg-ink-surface p-4 pb-6 dark:bg-inkd-surface"
                    style={[PAPER_FLOAT_SHADOW, { paddingBottom: Math.max(insets.bottom + 16, 24) }]}
                    accessibilityLabel={`${title}选择面板`}
                >
                    {/* 卡头：eyebrow 标题（11 medium secondary）+ 手输切换 + 关闭
                        钮（CloseButton 44 圆盒；三者间距 ≥12 无命中交叠） */}
                    <View className="mb-2 flex-row items-center justify-between">
                        <Text className="text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                            {title}
                        </Text>
                        <View className="flex-row items-center">
                            <Pressable
                                onPress={() => {
                                    setManual((prev) => !prev);
                                    haptics.selection();
                                }}
                                className="h-11 justify-center rounded-full px-3 active:opacity-70"
                                accessibilityRole="button"
                                accessibilityLabel={manual ? '用日历选择' : '手动输入日期'}
                                accessibilityState={{ selected: manual }}
                            >
                                <Text className="text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                    {manual ? '日历' : '手输'}
                                </Text>
                            </Pressable>
                            {/* 44 视觉盒 CloseButton；左邻手输钮 px-3 自带停车距 */}
                            <View className="ml-1">
                                <CloseButton onPress={onClose} />
                            </View>
                        </View>
                    </View>

                    {manual ? (
                        <View className="pt-1">
                            <DateInput value={draft} onChange={setDraft} placeholder="年月日" />
                            {rangeHint ? (
                                <Text className="mt-3 text-[12px] text-ink-muted dark:text-inkd-muted">{rangeHint}</Text>
                            ) : null}
                            <View className="mt-4">
                                <PrimaryButton
                                    label={draftValid ? '使用该日期' : '日期不完整或超出可选范围'}
                                    onPress={handleConfirmManual}
                                    disabled={!draftValid}
                                />
                            </View>
                        </View>
                    ) : (
                        <Calendar
                            marks={NO_MARKS}
                            selected={value || null}
                            onSelectDate={handlePickDay}
                            initialMonth={value || null}
                            minDate={minDate}
                            maxDate={maxDate}
                            tone="card"
                        />
                    )}
                </Pressable>
            </Pressable>
        </View>
    );
}

/* 浮层出现不做转场动画（animate-expo 频次闸：表单内交互每天数十次，动效要么
 * <150ms 要么不动——本层选择「不动」，条件挂载即到位；scrim 压暗本身是
 * 状态指示）。样式差异由 token/阴影档收口，无平台分叉渲染。 */
