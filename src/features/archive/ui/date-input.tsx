import { useRef, useState, type ComponentRef, type RefObject } from 'react';
import { Text, TextInput, View } from 'react-native';
import { isValidLocalDate } from '../trip-logic';

/** RN 0.88 的 TextInput 实例类型（React 19 ref 语义下用 ComponentRef 解析）。 */
type TextInputRef = ComponentRef<typeof TextInput>;

/**
 * 三段式本地日期输入（年/月/日）：不引入日期选择器依赖（三端可用性优先），
 * 满位自动跳段。value 为 YYYY-MM-DD 或空段拼接；complete 时保证格式合法。
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
    const monthRef = useRef<TextInputRef>(null);
    const dayRef = useRef<TextInputRef>(null);

    const segments = [
        { key: 'y' as const, next: monthRef as RefObject<TextInputRef> | null, max: 4, val: y ?? '', pad: 4 },
        { key: 'm' as const, next: dayRef, max: 2, val: m ?? '', pad: 2 },
        { key: 'd' as const, next: null, max: 2, val: d ?? '', pad: 2 },
    ];

    const build = (yv: string, mv: string, dv: string) => `${yv}-${mv}-${dv}`;

    return (
        <View className="flex-row items-center gap-2">
            {segments.map((seg, index) => (
                <View key={seg.key} className="flex-row items-center gap-2">
                    {index > 0 ? (
                        <Text className="text-ink-muted dark:text-inkd-muted">-</Text>
                    ) : null}
                    <TextInput
                        ref={seg.next ?? undefined}
                        className="h-12 w-16 rounded-lg border border-ink-border bg-ink-surface text-center text-[15px] text-ink-text dark:border-inkd-border dark:bg-inkd-surface dark:text-inkd-text"
                        value={seg.val}
                        placeholder={index === 0 ? placeholder : '--'}
                        placeholderTextColor="#8B939C"
                        keyboardType="number-pad"
                        maxLength={seg.max}
                        onChangeText={(raw) => {
                            const digits = raw.replace(/\D/g, '').slice(0, seg.max);
                            const next = build(
                                seg.key === 'y' ? digits : y ?? '',
                                seg.key === 'm' ? digits : m ?? '',
                                seg.key === 'd' ? digits : d ?? '',
                            );
                            onChange(next);
                            if (digits.length === seg.max && seg.next?.current) {
                                seg.next.current.focus();
                            }
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
