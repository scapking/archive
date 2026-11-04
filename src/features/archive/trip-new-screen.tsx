import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useArchiveStore } from './store';
import { dayDiff, isValidLocalDate, validateTripInput } from './trip-logic';
import { ScreenHeader } from './ui/screen-header';
import { PrimaryButton } from './ui/primary-button';
import { DateInput, isDateInputComplete } from './ui/date-input';

/**
 * 新建行程：标题 + 起止日期。提交即生成逐日骨架（"行程是骨架"）。
 * 日期用三段式输入，不引第三方日期选择器依赖。
 */
export function TripNewScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const createTrip = useArchiveStore((s) => s.createTrip);
    const storeError = useArchiveStore((s) => s.error);

    const [title, setTitle] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const validation = useMemo(
        () => validateTripInput({ title, startDate, endDate }),
        [title, startDate, endDate],
    );
    const canSubmit =
        !submitting && validation === null && isDateInputComplete(startDate) && isDateInputComplete(endDate);
    const dayCount =
        isDateInputComplete(startDate) && isDateInputComplete(endDate) && endDate >= startDate
            ? dayDiff(startDate, endDate) + 1
            : null;

    const submit = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        const trip = await createTrip({ title, startDate, endDate, note: '' });
        setSubmitting(false);
        if (trip) {
            router.replace({ pathname: '/trip/[id]', params: { id: trip.id } });
        }
    };

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-hatch-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView
                contentContainerStyle={{
                    paddingTop: insets.top + 8,
                    paddingBottom: insets.bottom + 24,
                    paddingHorizontal: 24,
                }}
                keyboardShouldPersistTaps="handled"
            >
                <ScreenHeader title="新建行程" subtitle="定下起止日期，每天会自动生成一格。" />
                <View className="gap-5">
                    <View>
                        <Text className="mb-2 text-[12px] text-hatch-secondary">行程名</Text>
                        <TextInput
                            className="h-12 rounded-lg border border-hatch-border bg-hatch-surface px-4 text-[15px] text-hatch-text"
                            placeholder="比如：京都红叶五日"
                            placeholderTextColor="#5F6664"
                            value={title}
                            onChangeText={setTitle}
                            maxLength={40}
                            returnKeyType="next"
                        />
                    </View>

                    <View>
                        <Text className="mb-2 text-[12px] text-hatch-secondary">出发日期</Text>
                        <DateInput value={startDate} onChange={setStartDate} placeholder="出发" />
                    </View>

                    <View>
                        <Text className="mb-2 text-[12px] text-hatch-secondary">返回日期</Text>
                        <DateInput value={endDate} onChange={setEndDate} placeholder="返回" />
                    </View>

                    <Text className="text-[13px] text-hatch-secondary">
                        {dayCount !== null ? `共 ${dayCount} 天` : ' '}
                    </Text>

                    {validation ? (
                        <Text className="text-[12px] text-[#F87171]">{validation}</Text>
                    ) : null}
                    {!validation && storeError ? (
                        <Text className="text-[12px] text-[#F87171]">{storeError}</Text>
                    ) : null}

                    <PrimaryButton label="创建行程" onPress={() => void submit()} disabled={!canSubmit} />
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}
