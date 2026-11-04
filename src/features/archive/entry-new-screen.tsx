import { useMemo, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BouncyPressable, LucideClose, LucideImage } from '@/core/icons';
import { imagePicker, type ImagePickerResult } from '@/core/image-picker';
import { useArchiveStore, type PickedPhoto } from './store';
import { isEntrySaveable, MOODS, todayEntryDate } from './entry-logic';
import { formatDateParts, todayLocal } from './trip-logic';
import { ScreenHeader } from './ui/screen-header';
import { PrimaryButton } from './ui/primary-button';

/** 每条碎片的图片上限（时间线取前 3 + 溢出数，撰写时对齐该口径）。 */
const MAX_PHOTOS = 9;

/**
 * 写一条：碎片式记录——打开即写，文字/图至少其一。
 * 时间线入口不传参（归今天、不挂行程）；行程详情入口经路由适配层显式传
 * tripId + date（参数由路径段而来，三端一致）。
 */
export function EntryNewScreen({
    tripId,
    date,
}: {
    tripId?: string;
    date?: string;
} = {}) {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const createEntry = useArchiveStore((s) => s.createEntry);
    const trips = useArchiveStore((s) => s.trips);
    const storeError = useArchiveStore((s) => s.error);

    const localDate = date ?? todayEntryDate();
    const trip = tripId ? trips.find((t) => t.id === tripId) ?? null : null;

    const [content, setContent] = useState('');
    const [mood, setMood] = useState<(typeof MOODS)[number]['key'] | null>(null);
    const [photos, setPhotos] = useState<PickedPhoto[]>([]);
    const [submitting, setSubmitting] = useState(false);

    const dateLabel = useMemo(() => {
        const isToday = localDate === todayLocal();
        const { monthDay, weekday } = formatDateParts(localDate);
        return `${monthDay} ${weekday}${isToday ? ' · 今天' : ''}`;
    }, [localDate]);

    const canSave = !submitting && isEntrySaveable(content, photos.length);

    const pickPhotos = async () => {
        const permission = await imagePicker.getMediaLibraryPermissionAsync();
        if (!permission.granted && !permission.accessPrivileges) {
            // 首次未授权则请求；仍拒绝时保持按钮可用（下次再请求）
            const requested = await imagePicker.requestMediaLibraryPermissionAsync();
            if (!requested.granted) return;
        }
        const result: ImagePickerResult = await imagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsMultipleSelection: true,
            selectionLimit: MAX_PHOTOS - photos.length,
            quality: 1,
            exif: false,
        });
        if (result.canceled) return;
        const next = result.assets.map((asset) => ({
            uri: asset.uri,
            width: asset.width ?? 0,
            height: asset.height ?? 0,
        }));
        setPhotos((current) => [...current, ...next].slice(0, MAX_PHOTOS));
    };

    const submit = async () => {
        if (!canSave) return;
        setSubmitting(true);
        const ok = await createEntry({
            tripId: trip?.id ?? null,
            localDate,
            content,
            mood,
            photos,
        });
        setSubmitting(false);
        if (ok) router.back();
    };

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-hatch-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <ScreenHeader title="写一条" subtitle={dateLabel} />

                <ScrollView
                    contentContainerStyle={{
                        paddingHorizontal: 24,
                        paddingBottom: insets.bottom + 24,
                    }}
                    keyboardShouldPersistTaps="handled"
                >
                    {trip ? (
                        <View className="mb-3 flex-row items-center self-start rounded-md border border-hatch-border bg-hatch-surface px-2.5 py-1.5">
                            <Text className="text-[11px] text-hatch-secondary">行程 · {trip.title}</Text>
                        </View>
                    ) : null}

                    <TextInput
                        autoFocus
                        multiline
                        className="min-h-[132px] rounded-lg border border-hatch-border bg-hatch-surface px-4 py-3 text-[15px] leading-6 text-hatch-text"
                        placeholder="此刻值得记下的…"
                        placeholderTextColor="#5F6664"
                        value={content}
                        onChangeText={setContent}
                        textAlignVertical="top"
                    />

                    {/* 心情：点色是数据（色只上数据） */}
                    <View className="mt-4 flex-row items-center">
                        <Text className="mr-3 text-[12px] text-hatch-secondary">心情</Text>
                        <View className="flex-row items-center gap-3">
                            {MOODS.map((item) => {
                                const active = mood === item.key;
                                return (
                                    <Pressable
                                        key={item.key}
                                        onPress={() => setMood(active ? null : item.key)}
                                        className="h-9 w-9 items-center justify-center rounded-full border"
                                        accessibilityRole="button"
                                        accessibilityLabel={item.label}
                                        accessibilityState={{ selected: active }}
                                        style={{
                                            borderColor: active ? item.color : 'transparent',
                                            backgroundColor: active ? `${item.color}1F` : 'transparent',
                                        }}
                                    >
                                        <View
                                            className="h-2.5 w-2.5 rounded-full"
                                            style={{ backgroundColor: item.color }}
                                        />
                                    </Pressable>
                                );
                            })}
                        </View>
                    </View>

                    {/* 图片行 */}
                    <View className="mt-4 flex-row flex-wrap items-center gap-2">
                        {photos.map((photo, index) => (
                            <View key={`${photo.uri}-${index}`}>
                                <Image
                                    source={{ uri: photo.uri }}
                                    className="h-[72px] w-[72px] rounded-md border border-hatch-border bg-hatch-raised"
                                    resizeMode="cover"
                                />
                                <View className="absolute -right-2 -top-2">
                                    <BouncyPressable
                                        scaleTo={0.85}
                                        onPress={() => setPhotos((cur) => cur.filter((_, i) => i !== index))}
                                    >
                                        <View className="h-6 w-6 items-center justify-center rounded-full border border-hatch-border bg-hatch-raised">
                                            <LucideClose size={12} color="#E6E8E7" />
                                        </View>
                                    </BouncyPressable>
                                </View>
                            </View>
                        ))}
                        {photos.length < MAX_PHOTOS ? (
                            <BouncyPressable onPress={() => void pickPhotos()} scaleTo={0.94}>
                                <View
                                    className="h-[72px] w-[72px] items-center justify-center rounded-md border border-dashed border-hatch-border bg-hatch-surface active:bg-hatch-raised"
                                    accessibilityRole="button"
                                    accessibilityLabel="添加图片"
                                >
                                    <LucideImage size={20} color="#5F6664" />
                                </View>
                            </BouncyPressable>
                        ) : null}
                    </View>

                    {storeError ? (
                        <Text className="mt-3 text-[12px] text-[#F87171]">{storeError}</Text>
                    ) : null}

                    <View className="mt-6">
                        <PrimaryButton label="保存" onPress={() => void submit()} disabled={!canSave} />
                    </View>
                </ScrollView>
            </View>
        </KeyboardAvoidingView>
    );
}
