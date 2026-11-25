import { useRef, useState, type ComponentRef } from 'react';
import { Text, TextInput, View } from 'react-native';
import { isValidLocalDate } from '../trip-logic';
import { usePalette } from './theme';

/** RN 0.88 的 TextInput 实例类型（React 19 ref 语义下用 ComponentRef 解析）。 */
type TextInputRef = ComponentRef<typeof TextInput>;

/**
 * 三段式本地日期输入（年/月/日）：不引入日期选择器依赖（三端可用性优先）。
 * value 为 YYYY-MM-DD 或空段拼接（'2026-11-'）；complete 时保证格式合法。
 *
 * v5 修复「行程日期始终不对」（DEV.md #2）——旧实现两处硬伤：
 * ① 逐段清洗只截位数、从不补零（段配置里的 pad 是死代码）：数字键盘上用户自然输入
 *    2026/2/28 得到 '2026-2-28'，isDateInputComplete 的 ^\d{4}-\d{2}-\d{2}$ 永远
 *    不匹配 → 表单永远「出发日期不完整」；② 月段 '2' 后想输日的 '8' 会拼成 '28' 月。
 * 现按 Stripe 日期框口径做渐进归一：首位数字已排除两位数可能时立即补零跳段
 * （月首位 ≥2、日首位 ≥4），满位跳段保留，失焦对单数字段补零——自然输入
 * 2026 2 28 全程自动归一为 '2026-02-28'。
 *
 * 无边框输入（#13 输入框规范）：border 零、raised 浅井底（v0.4.6 字阶轮
 * 统一：与搜索药丸 / 表单卡内 FieldInput tone='raised' 同档——纸卡上的
 * 字段一律「井」不是「面」）；聚焦态底色再深一档（浅色加深 / 深色提亮，
 * 双主题同一 token 对）。聚焦用 onFocus/onBlur 本地状态而非 css-interop
 * 的 focus: 伪类——三端行为确定不赌编译产物。条件三元两侧变量集恒等
 * （bg + dark:bg 同槽位成对），符合 className 铁律。
 */
export function DateInput({
    value,
    onChange,
    placeholder = '日期',
}: {
    /** 完整或部分日期（空段为 ''），如 '2026-11-05' / '2026-11-' */
    value: string;
    onChange(value: string): void;
    placeholder?: string;
}) {
    const [y, m, d] = value.split('-');
    const yearRef = useRef<TextInputRef>(null);
    const monthRef = useRef<TextInputRef>(null);
    const dayRef = useRef<TextInputRef>(null);
    const palette = usePalette();
    // 聚焦段标记（#13 无边框聚焦反馈）：按段高亮（三段共享一个 state，比较 key），
    // 失焦即回落 surface——仅当前聚焦段亮度变化，非聚焦段不陪跑
    const [focusedKey, setFocusedKey] = useState<string | null>(null);

    // ref = 当前段自己的输入框，next = 满位后要聚焦的下一段 ref——
    // 两者必须分开挂：若把 next 挂成本段 ref，focus 落回自身，自动跳段永不生效。
    // autoPadFirstDigit：首位数字 > 该值时该段不可能是两位数（月 2x-9x、日 4x-9x
    // 均非法），立即补零并跳段；年段无此语义（年份恒 4 位制，部分年份补零是错值）。
    const segments = [
        { key: 'y' as const, ref: yearRef, next: monthRef, max: 4, val: y ?? '' },
        { key: 'm' as const, ref: monthRef, next: dayRef, max: 2, val: m ?? '', autoPadFirstDigit: 1 },
        { key: 'd' as const, ref: dayRef, next: null, max: 2, val: d ?? '', autoPadFirstDigit: 3 },
    ];

    const build = (yv: string, mv: string, dv: string) => `${yv}-${mv}-${dv}`;

    /**
     * 段内清洗 + 归一：剔除非数字、截到段上限；月/日首位已排除两位可能时补零
     * （'2' → '02'，返回值长度即到 max，调用方据此跳段）。
     */
    const normalizeSegment = (
        seg: (typeof segments)[number],
        raw: string,
    ): string => {
        const digits = raw.replace(/\D/g, '').slice(0, seg.max);
        if (
            digits.length === 1 &&
            seg.autoPadFirstDigit !== undefined &&
            Number(digits) > seg.autoPadFirstDigit
        ) {
            return `0${digits}`;
        }
        return digits;
    };

    return (
        // 段宽自适应（flex-1）：手机窄屏两列并排时固定宽会溢出视口（390px 实测）
        <View className="flex-row items-center gap-1.5">
            {segments.map((seg, index) => (
                <View key={seg.key} className="flex-1 flex-row items-center gap-1.5">
                    {index > 0 ? (
                        <Text className="text-ink-muted dark:text-inkd-muted">-</Text>
                    ) : null}
                    <TextInput
                        ref={seg.ref}
                        className={`h-11 min-w-0 flex-1 rounded-control text-center text-[15px] ${
                            // 无边框规范（#13）：border 零，聚焦 border / 失焦 raised
                            //（一档亮度变化语言，双主题 token 对成对）
                            focusedKey === seg.key
                                ? 'bg-ink-border dark:bg-inkd-border'
                                : 'bg-ink-raised dark:bg-inkd-raised'
                        } text-ink-text dark:text-inkd-text`}
                        style={{ fontVariant: ['tabular-nums'] }}
                        value={seg.val}
                        placeholder={index === 0 ? placeholder : '--'}
                        placeholderTextColor={palette.muted}
                        keyboardType="number-pad"
                        maxLength={seg.max}
                        onChangeText={(raw) => {
                            const digits = normalizeSegment(seg, raw);
                            const next = build(
                                seg.key === 'y' ? digits : y ?? '',
                                seg.key === 'm' ? digits : m ?? '',
                                seg.key === 'd' ? digits : d ?? '',
                            );
                            // 同值不回写：既免无谓 re-render，也断掉受控回写与键盘竞态吞键
                            if (next !== value) onChange(next);
                            // 满位（含补零归一后到位）→ 跳下一段
                            if (digits.length === seg.max && seg.next?.current) {
                                seg.next.current.focus();
                            }
                        }}
                        onFocus={() => setFocusedKey(seg.key)}
                        onBlur={() => {
                            setFocusedKey(null);
                            // 失焦补零：单数字段离开即归一（'2' → '02'），用户不会再
                            // 撞上「明明填了却提示不完整」的隐形坑；空段与满位不动
                            if (seg.key === 'y') return;
                            const current = seg.key === 'm' ? (m ?? '') : (d ?? '');
                            if (current.length === 0 || current.length >= seg.max) return;
                            const padded = current.padStart(seg.max, '0');
                            const next =
                                seg.key === 'm'
                                    ? build(y ?? '', padded, d ?? '')
                                    : build(y ?? '', m ?? '', padded);
                            if (next !== value) onChange(next);
                        }}
                    />
                </View>
            ))}
        </View>
    );
}

/** 三段是否填满且为真实日期。 */
export function isDateInputComplete(value: string): boolean {
    return isValidLocalDate(value);
}
