import type { EntryRow, EntryMood, PhotoRow } from './db';
import { formatDateParts, todayLocal, toLocalDate } from './trip-logic';

/**
 * 日记碎片纯逻辑（R8）：心情元数据、时间线分组、展示格式化。
 * 禁止 import react / react-native（可独立单测）。
 */

// ─── 心情（色只上数据：点色是时间线上唯一的常驻色彩）────────────────────────

export interface MoodMeta {
    key: EntryMood;
    label: string;
    /** 数据色（app-screens：色只上数据；design-linear：克制、低饱和） */
    color: string;
}

export const MOODS: MoodMeta[] = [
    { key: 'great', label: '太好了', color: '#34D399' },
    { key: 'good', label: '不错', color: '#60A5FA' },
    { key: 'flat', label: '平淡', color: '#9BA1A0' },
    { key: 'low', label: '低落', color: '#F87171' },
];

export function moodMeta(key: EntryMood | null): MoodMeta | null {
    if (!key) return null;
    return MOODS.find((mood) => mood.key === key) ?? null;
}

// ─── 时间线分组 ──────────────────────────────────────────────────────────────

export interface EntryWithPhotos extends EntryRow {
    photos: PhotoRow[];
}

/** 一天的碎片集合（同一 local_date 的聚合，"碎片流按日期归档"）。 */
export interface TimelineGroup {
    localDate: string;
    entries: EntryWithPhotos[];
}

/**
 * 碎片按 local_date 分组：日期倒序（新的一天在前），日内按 created_at 正序（像写日记）。
 * 输入不要求有序。
 */
export function groupEntriesByDate(
    entries: EntryRow[],
    photosByEntry: Map<string, PhotoRow[]>,
): TimelineGroup[] {
    const byDate = new Map<string, EntryWithPhotos[]>();
    for (const entry of entries) {
        const bucket = byDate.get(entry.local_date);
        const withPhotos: EntryWithPhotos = {
            ...entry,
            photos: photosByEntry.get(entry.id) ?? [],
        };
        if (bucket) bucket.push(withPhotos);
        else byDate.set(entry.local_date, [withPhotos]);
    }
    return [...byDate.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([localDate, groupEntries]) => ({ localDate, entries: groupEntries }));
}

// ─── 展示格式化 ──────────────────────────────────────────────────────────────

/** 日期组头：主 '11月5日' / 副 '周四' / 角标 '今天' | '昨天'。 */
export function formatDateGroupLabel(localDate: string, today = todayLocal()): {
    monthDay: string;
    weekday: string;
    relative: '今天' | '昨天' | null;
} {
    const { monthDay, weekday } = formatDateParts(localDate);
    const diff = Date.parse(`${localDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`);
    const days = Math.round(diff / 86_400_000);
    const relative = days === 0 ? '今天' : days === -1 ? '昨天' : null;
    return { monthDay, weekday, relative };
}

/** epoch ms → 'HH:mm'（本地时间）。 */
export function formatTime(created_at: number): string {
    const date = new Date(created_at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 碎片是否可保存：文字或图片至少有一项（"照片先行，文字后补"）。 */
export function isEntrySaveable(content: string, photoCount: number): boolean {
    return content.trim().length > 0 || photoCount > 0;
}

/** 当前时刻的碎片归属：今天（时间线默认）。 */
export function todayEntryDate(): string {
    return toLocalDate(new Date());
}
