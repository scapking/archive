import { useEffect, useMemo, useRef, useState } from 'react';
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
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { BouncyPressable, LucideBack, LucideCheck } from '@/core/icons';
import { imagePicker } from '@/core/image-picker';
import { useArchiveRevision, useArchiveStore } from './store';
import {
    canReopen,
    isEditable,
    parseBlocks,
    todayEntryDate,
    wordCount,
    withMediaAppended,
    type JournalBlock,
} from './journal-logic';
import { formatDateParts, todayLocal } from './trip-logic';
import { getJournal, getTrip, mediaByJournalIds } from './db';
import type { JournalMediaRow, JournalRow, TripRow } from './db';
import { BlockEditor, EditorToolbar, PENDING_MEDIA_ID } from './ui/editor';
import { useAccentGradient } from './ui/theme';

/** 每篇日记的媒体上限（防误触爆量；商业版放开为分页）。 */
const MAX_MEDIA = 12;

/**
 * 连续日记编辑器（行程/日常通用）——三种入口：不传参 = 今天日常；
 * tripId+date = 行程某天；journalId = 直达某篇。
 *
 * 交互承诺：
 * - 当天收笔页可「重新打开」（历史页不可，24:00 承诺不破坏）；
 * - 只读态不渲染禁用按钮（不呈现看起来坏掉的控件）；
 * - 媒体插入 pending 占位，异常落 store.error 上浮（picker 失败可见）；
 * - 800ms 防抖 + 失焦即存双通道。
 */
export function JournalEditScreen({
    tripId,
    date,
    journalId,
}: {
    tripId?: string;
    date?: string;
    journalId?: string;
} = {}) {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const revision = useArchiveRevision();
    const store = useArchiveStore;
    const error = store((s) => s.error);
    const ensureTodayJournal = store((s) => s.ensureTodayJournal);
    const ensureJournal = store((s) => s.ensureJournal);
    const [gradientFrom, gradientTo] = useAccentGradient();

    const [journal, setJournal] = useState<JournalRow | null>(null);
    const [trip, setTrip] = useState<TripRow | null>(null);
    const [blocks, setBlocks] = useState<JournalBlock[]>([]);
    const [media, setMedia] = useState<JournalMediaRow[]>([]);
    const [busy, setBusy] = useState(false);
    const [savedAt, setSavedAt] = useState<number | null>(null);
    const [focusTextIndex, setFocusTextIndex] = useState<number | null>(null);

    // 载入日记 + 行程上下文
    useEffect(() => {
        let active = true;
        void (async () => {
            let row: JournalRow | null = null;
            if (journalId) {
                row = await getJournal(journalId);
            } else if (tripId || date) {
                row = await ensureJournal(tripId ?? null, date ?? todayEntryDate());
            } else {
                row = await ensureTodayJournal();
            }
            if (!active) return;
            setJournal(row);
            setBlocks(row ? parseBlocks(row.blocks) : []);
            if (row?.trip_id) setTrip(await getTrip(row.trip_id));
        })();
        return () => {
            active = false;
        };
    }, [journalId, tripId, date, ensureJournal, ensureTodayJournal]);

    // 媒体行随 revision 重载
    useEffect(() => {
        if (!journal) return;
        let active = true;
        mediaByJournalIds([journal.id]).then((grouped) => {
            if (active) setMedia(grouped.get(journal.id) ?? []);
        });
        return () => {
            active = false;
        };
    }, [journal, revision]);

    // 防抖自动保存（800ms）：跳过载入回填帧
    const firstRender = useRef(true);
    useEffect(() => {
        if (firstRender.current) {
            firstRender.current = false;
            return;
        }
        if (!journal || !isEditable(journal.status)) return;
        const timer = setTimeout(() => {
            void store
                .getState()
                .saveJournalBlocks(journal.id, blocks)
                .then(() => setSavedAt(Date.now()));
        }, 800);
        return () => clearTimeout(timer);
    }, [blocks, journal, store]);

    const editable = journal ? isEditable(journal.status) : false;
    const reopenable = journal ? canReopen(journal) : false;
    const saving = store((s) => s.savingJournal);
    const mediaById = useMemo(() => new Map(media.map((row) => [row.id, row])), [media]);
    const chars = useMemo(() => wordCount(blocks), [blocks]);
    const { monthDay, weekday } = formatDateParts(journal?.local_date ?? todayEntryDate());
    const isToday = journal?.local_date === todayLocal();
    const savedLabel = savedAt
        ? `已保存 ${String(new Date(savedAt).getHours()).padStart(2, '0')}:${String(new Date(savedAt).getMinutes()).padStart(2, '0')}`
        : '自动保存开启';

    const pick = async (kind: 'image' | 'video') => {
        if (!journal || busy) return;
        const mediaCount = blocks.filter((b) => b.t === 'media').length;
        if (mediaCount >= MAX_MEDIA) return;
        setBusy(true);
        try {
            const permission = await imagePicker.getMediaLibraryPermissionAsync();
            if (!permission.granted) {
                const requested = await imagePicker.requestMediaLibraryPermissionAsync();
                if (!requested.granted) {
                    store.setState({ error: '没有相册权限，去系统设置里开一下。' });
                    return;
                }
            }
            const result = await imagePicker.launchImageLibraryAsync({
                mediaTypes: [kind === 'video' ? 'videos' : 'images'],
                quality: 1,
                exif: false,
            });
            if (result.canceled || result.assets.length === 0) return;
            const asset = result.assets[0];
            // 先插 pending 占位（不阻塞继续写字），落盘后回填真实块
            setBlocks((current) => withMediaAppended(current, PENDING_MEDIA_ID));
            const mediaId = await store.getState().attachJournalMedia(
                journal.id,
                kind,
                asset.uri,
                asset.width ?? null,
                asset.height ?? null,
            );
            setBlocks((current) => {
                const replaced = current.map((block) =>
                    block.t === 'media' && block.mediaId === PENDING_MEDIA_ID
                        ? mediaId
                            ? { t: 'media' as const, mediaId }
                            : null
                        : block,
                );
                const cleaned = replaced.filter((block): block is JournalBlock => block !== null);
                // 媒体后补一个空文本段，聚焦续写（大厂编辑器的"接着写"手感）
                const withText = [...cleaned, { t: 'p' as const, text: '' }];
                setFocusTextIndex(withText.length - 1);
                return withText;
            });
        } catch (caught) {
            // picker 失败（环境/权限/取消异常）必须可见，不能是"点了没反应"
            store.setState({
                error: `${kind === 'video' ? '视频' : '图片'}选取失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
            // 回滚 pending 占位
            setBlocks((current) => current.filter((b) => !(b.t === 'media' && b.mediaId === PENDING_MEDIA_ID)));
        } finally {
            setBusy(false);
        }
    };

    const complete = async () => {
        if (!journal) return;
        await store.getState().saveJournalBlocks(journal.id, blocks);
        await store.getState().completeJournal(journal.id);
        router.back();
    };

    const reopen = () => {
        if (!journal) return;
        void store
            .getState()
            .reopenJournal(journal.id)
            .then(() => getJournal(journal.id))
            .then((row) => {
                if (row) setJournal(row);
            });
    };

    if (!journal) {
        return (
            <View className="flex-1 items-center justify-center bg-ink-base dark:bg-inkd-base">
                <ActivityIndicator color="#3B82F6" />
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-ink-base dark:bg-inkd-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={{ paddingTop: insets.top }} className="flex-1">
                {/* 悬浮返回（无 header 盒子） */}
                <BouncyPressable onPress={() => router.back()} scaleTo={0.9}>
                    <View
                        className="absolute left-4 z-10 h-10 w-10 items-center justify-center rounded-full"
                        style={{ top: insets.top + 4 }}
                    >
                        <LucideBack size={22} color="#8B939C" />
                    </View>
                </BouncyPressable>

                {/* 报头 masthead + 行程上下文（在写谁的哪一天） */}
                <View className="px-6 pb-4" style={{ paddingTop: insets.top + 44 }}>
                    <View className="flex-row items-baseline justify-between">
                        <Text className="text-[30px] font-semibold tracking-wide text-ink-text dark:text-inkd-text">
                            {monthDay}
                        </Text>
                        <Text
                            className={`text-[11px] font-medium ${
                                editable
                                    ? 'text-ink-accent dark:text-inkd-accent'
                                    : 'text-ink-muted dark:text-inkd-muted'
                            }`}
                        >
                            {editable ? '进行中' : '已收笔'}
                        </Text>
                    </View>
                    <Text className="mt-0.5 text-[13px] text-ink-secondary dark:text-inkd-secondary">
                        {weekday}
                        {isToday ? ' · 今天' : ''}
                    </Text>
                    {trip ? (
                        <Text className="mt-1 text-[12px] text-ink-muted dark:text-inkd-muted">
                            {trip.icon ?? '🧭'} {trip.title}
                        </Text>
                    ) : null}
                </View>
                {error ? (
                    <Text className="px-6 pb-2 text-[12px] text-ink-negative dark:text-inkd-negative">
                        {error}
                    </Text>
                ) : null}
                {!editable ? (
                    <Text className="px-6 pb-3 text-[12px] text-ink-muted dark:text-inkd-muted">
                        本页已收笔（只读）。当天 24:00 自动收笔；历史页收笔后不可重开。
                    </Text>
                ) : null}

                <ScrollView
                    contentContainerStyle={{
                        paddingHorizontal: 24,
                        paddingBottom: insets.bottom + 24,
                    }}
                    keyboardShouldPersistTaps="handled"
                >
                    {/* 阅读列：桌面端行长 ≤80 字符（frontend-design 可读性口径） */}
                    <View className="mx-auto w-full max-w-[620px]">
                        <BlockEditor
                            blocks={blocks}
                            mediaById={mediaById}
                            editable={editable}
                            focusTextIndex={focusTextIndex}
                            onChange={setBlocks}
                            onFocusText={(index) => setFocusTextIndex(null)}
                            onBlurText={() => {
                                if (journal && isEditable(journal.status)) {
                                    void store
                                        .getState()
                                        .saveJournalBlocks(journal.id, blocks)
                                        .then(() => setSavedAt(Date.now()));
                                }
                            }}
                            onPickImage={() => void pick('image')}
                            onPickVideo={() => void pick('video')}
                            busy={busy}
                        />
                    </View>
                </ScrollView>

                {/* 工具坞：键盘上方常驻（只读态不含工具 chips） */}
                <View style={{ paddingBottom: insets.bottom }}>
                    <EditorToolbar
                        editable={editable}
                        busy={busy}
                        saving={saving}
                        savedLabel={savedLabel}
                        charCount={chars}
                        onPickImage={() => void pick('image')}
                        onPickVideo={() => void pick('video')}
                        primary={
                            editable ? (
                                <BouncyPressable onPress={() => void complete()} scaleTo={0.95}>
                                    <LinearGradient
                                        start={{ x: 0, y: 0.5 }}
                                        end={{ x: 1, y: 0.5 }}
                                        colors={[gradientFrom, gradientTo]}
                                        className="h-10 items-center justify-center rounded-lg px-5"
                                        accessibilityRole="button"
                                        accessibilityLabel="完成收笔"
                                    >
                                        <Text className="text-[13px] font-semibold text-ink-base dark:text-inkd-base">
                                            完成
                                        </Text>
                                    </LinearGradient>
                                </BouncyPressable>
                            ) : reopenable ? (
                                <BouncyPressable onPress={reopen} scaleTo={0.95}>
                                    <View className="h-10 items-center justify-center rounded-lg border border-ink-accent bg-ink-accent-bg px-4 dark:border-inkd-accent dark:bg-inkd-accent-bg">
                                        <View className="flex-row items-center gap-1">
                                            <LucideCheck size={12} color="#3B82F6" />
                                            <Text className="text-[13px] font-medium text-ink-accent dark:text-inkd-accent">
                                                重新打开
                                            </Text>
                                        </View>
                                    </View>
                                </BouncyPressable>
                            ) : (
                                <Pressable onPress={() => router.back()}>
                                    <Text className="text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        返回
                                    </Text>
                                </Pressable>
                            )
                        }
                    />
                </View>
            </View>
        </KeyboardAvoidingView>
    );
}
