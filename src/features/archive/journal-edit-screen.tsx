import { useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    Text,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BouncyPressable } from '@/core/icons';
import { imagePicker } from '@/core/image-picker';
import { useArchiveRevision, useArchiveStore } from './store';
import {
    isEditable,
    parseBlocks,
    todayEntryDate,
    wordCount,
    withMediaAppended,
    type JournalBlock,
} from './journal-logic';
import { formatDateParts, todayLocal } from './trip-logic';
import { getJournal, mediaByJournalIds } from './db';
import type { JournalMediaRow, JournalRow } from './db';
import { BlockEditor } from './ui/editor';
import { ScreenHeader } from './ui/screen-header';

/** 每篇日记的媒体上限（防误触爆量；商业版放开为分页）。 */
const MAX_MEDIA = 12;

/**
 * 连续日记编辑器（行程/日常通用）：打开即续写对应归属日的一页，
 * 块内容 800ms 防抖自动落库；「完成」收笔后只读；跨日由 store 加载时自动收笔。
 * 三种入口：不传参 = 今天日常；tripId+date = 行程某天；journalId = 直达某篇。
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

    const [journal, setJournal] = useState<JournalRow | null>(null);
    const [blocks, setBlocks] = useState<JournalBlock[]>([]);
    const [media, setMedia] = useState<JournalMediaRow[]>([]);
    const [busy, setBusy] = useState(false);
    const [savedAt, setSavedAt] = useState<number | null>(null);

    // 载入：按 journalId / tripId+date / 今天 三种入口（deps 全显式，无动态依赖）
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

    // 防抖自动保存（800ms）：跳过首帧（载入回填不做无谓写库）
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
    const mediaById = useMemo(() => new Map(media.map((row) => [row.id, row])), [media]);
    const dateLabel = useMemo(() => {
        const { monthDay, weekday } = formatDateParts(journal?.local_date ?? todayEntryDate());
        const isToday = journal?.local_date === todayLocal();
        return `${monthDay} ${weekday}${isToday ? ' · 今天' : ''}`;
    }, [journal?.local_date]);

    const pick = async (kind: 'image' | 'video') => {
        if (!journal || busy) return;
        if (media.length >= MAX_MEDIA) return;
        setBusy(true);
        try {
            const permission = await imagePicker.getMediaLibraryPermissionAsync();
            if (!permission.granted) {
                const requested = await imagePicker.requestMediaLibraryPermissionAsync();
                if (!requested.granted) return;
            }
            const result = await imagePicker.launchImageLibraryAsync({
                mediaTypes: [kind === 'video' ? 'videos' : 'images'],
                quality: 1,
                exif: false,
            });
            if (result.canceled || result.assets.length === 0) return;
            const asset = result.assets[0];
            const mediaId = await store.getState().attachJournalMedia(
                journal.id,
                kind,
                asset.uri,
                asset.width ?? null,
                asset.height ?? null,
            );
            if (mediaId) setBlocks((current) => withMediaAppended(current, mediaId));
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
                <ScreenHeader
                    title={dateLabel}
                    subtitle={`${wordCount(blocks)} 字 · ${
                        savedAt
                            ? `已自动保存 ${new Date(savedAt).getHours()}:${String(new Date(savedAt).getMinutes()).padStart(2, '0')}`
                            : '自动保存开启'
                    }`}
                    back
                    right={
                        editable ? (
                            <BouncyPressable onPress={() => void complete()} scaleTo={0.94}>
                                <View className="rounded-md border border-ink-accent bg-ink-accent-bg px-3 py-1.5 dark:border-inkd-accent dark:bg-inkd-accent-bg">
                                    <Text className="text-[12px] font-medium text-ink-accent dark:text-inkd-accent">
                                        完成
                                    </Text>
                                </View>
                            </BouncyPressable>
                        ) : null
                    }
                />
                {error ? (
                    <Text className="px-6 pb-2 text-[12px] text-ink-negative dark:text-inkd-negative">
                        {error}
                    </Text>
                ) : null}
                {!editable ? (
                    <Text className="px-6 pb-2 text-[12px] text-ink-muted dark:text-inkd-muted">
                        本页已收笔（只读）。当天 24:00 自动收笔，或手动「完成」提前结束。
                    </Text>
                ) : null}

                <ScrollView
                    contentContainerStyle={{
                        paddingHorizontal: 24,
                        paddingBottom: insets.bottom + 48,
                    }}
                    keyboardShouldPersistTaps="handled"
                >
                    <BlockEditor
                        blocks={blocks}
                        mediaById={mediaById}
                        editable={editable}
                        onChange={setBlocks}
                        onPickImage={() => void pick('image')}
                        onPickVideo={() => void pick('video')}
                        busy={busy}
                    />
                </ScrollView>
            </View>
        </KeyboardAvoidingView>
    );
}
