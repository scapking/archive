import type { JournalBlock, JournalRow, JournalStatus } from './db';
import { addDaysLocal, formatDateParts, todayLocal } from './trip-logic';

/**
 * 日记（连续容器）纯逻辑（R8）：块模型、收笔规则、展示格式化。
 * 禁止 import react / react-native（可独立单测）。
 */

// ─── 块模型 ──────────────────────────────────────────────────────────────────

export type { JournalBlock, JournalRow, JournalStatus } from './db';

/** 解析块 JSON（坏数据降级为空容器——日记正文损坏不该打不开页面）。 */
export function parseBlocks(json: string): JournalBlock[] {
    try {
        const parsed: unknown = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (block): block is JournalBlock =>
                typeof block === 'object' &&
                block !== null &&
                ((block as JournalBlock).t === 'p' || (block as JournalBlock).t === 'media'),
        );
    } catch {
        // 手写 JSON 损坏按空日记处理：内容仍在 DB，可编辑重写
        return [];
    }
}

export function serializeBlocks(blocks: JournalBlock[]): string {
    return JSON.stringify(blocks);
}

/** 字数 = 全部文本块长度（中文按字计，商业口径简单诚实）。 */
export function wordCount(blocks: JournalBlock[]): number {
    return blocks.reduce((sum, block) => (block.t === 'p' ? sum + block.text.length : sum), 0);
}

/** 是否可继续写：只有 open 状态的日记可编辑（手动完成 / 24:00 自动收笔后只读）。 */
export function isEditable(status: JournalStatus): boolean {
    return status === 'open';
}

/** 在末尾追加媒体块（媒体先落库拿到 mediaId 再进块）。 */
export function withMediaAppended(blocks: JournalBlock[], mediaId: string): JournalBlock[] {
    return [...blocks, { t: 'media' as const, mediaId }];
}

/** 末尾若是空文本块则复用（避免连续空段堆积）。 */
export function withTextAppended(blocks: JournalBlock[], text: string): JournalBlock[] {
    const last = blocks[blocks.length - 1];
    if (last && last.t === 'p' && last.text === '') {
        return [...blocks.slice(0, -1), { t: 'p' as const, text }];
    }
    return [...blocks, { t: 'p' as const, text }];
}

/** 纯文本预览（卡片/搜索结果）：取前 N 字，媒体以「[图片]/[视频]」占位。 */
export function previewText(blocks: JournalBlock[], max = 80): string {
    const parts: string[] = [];
    let length = 0;
    for (const block of blocks) {
        if (block.t === 'media') {
            parts.push('[媒体]');
            length += 4;
        } else if (block.text.trim()) {
            parts.push(block.text.trim());
            length += block.text.trim().length;
        }
        if (length >= max) break;
    }
    const joined = parts.join(' ');
    return joined.length > max ? `${joined.slice(0, max)}…` : joined;
}

/** 媒体块计数（卡片角标）。 */
export function mediaCount(blocks: JournalBlock[]): number {
    return blocks.filter((block) => block.t === 'media').length;
}

// ─── 收笔规则 ────────────────────────────────────────────────────────────────

/**
 * 日记的归属日是否已过（本地时区 24:00 自动收笔的判定基准）：
 * local_date 严格早于今天即视为跨日（当天 23:59 仍可写）。
 */
export function isPastDay(localDate: string, today = todayLocal()): boolean {
    return localDate < today;
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

/** 当前时刻的日记归属：今天。 */
export function todayEntryDate(): string {
    return todayLocal();
}

/** 连续记录 streak：从今天（或昨天）往回数有日记的连续天数。 */
export function streakFromDates(dates: Set<string>, today = todayLocal()): number {
    let streak = 0;
    let cursor = dates.has(today) ? today : prevDay(today);
    if (!dates.has(cursor)) return 0;
    while (dates.has(cursor)) {
        streak += 1;
        cursor = prevDay(cursor);
    }
    return streak;
}

function prevDay(value: string): string {
    return addDaysLocal(value, -1);
}

/** me 页曲线：最近 days 天逐日字数（缺日补 0，诚实呈现断档）。 */
export function curveSeries(
    byDate: Map<string, number>,
    days = 30,
    today = todayLocal(),
): Array<{ date: string; value: number }> {
    const series: Array<{ date: string; value: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
        const date = addDaysLocal(today, -i);
        series.push({ date, value: byDate.get(date) ?? 0 });
    }
    return series;
}
