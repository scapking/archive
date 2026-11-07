import type { JournalBlock, JournalRow, JournalStatus } from './db';
// 运行时常量取自 schema（纯常量文件，无 core/native 依赖，不破坏本模块
// 「可独立单测」纪律）；禁止从 './db'（index）导入——那会拖入整个 SQL 出口。
import { PENDING_MEDIA_ID } from './db/schema';
import { addDaysLocal, formatDateParts, todayLocal } from './trip-logic';

/**
 * 日记（连续容器）纯逻辑（R8）：块模型、收笔规则、展示格式化。
 * 禁止 import react / react-native（可独立单测）。
 */

// ─── 块模型 ──────────────────────────────────────────────────────────────────

export type { JournalBlock, JournalRow, JournalStatus } from './db';

/**
 * 块 id 生成（v4 随机 UUID）：编辑器 React key 与移动排序的稳定标识。
 * 纯 JS 实现（journal-logic 禁 import react/native，也不引 core 依赖）：
 * 优先 crypto.randomUUID（native / 安全上下文 web 可用），非安全上下文
 * 回退 Math.random 拼装（id 仅用于 key/排序，非安全凭证，碰撞概率可接受）。
 */
export function newBlockId(): string {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    if (g.crypto?.randomUUID) return g.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/** 块结构校验（parseBlocks 过滤用）：t 合法且媒体块 mediaId 为非空字符串。 */
function isBlockShape(block: unknown): block is JournalBlock {
    if (typeof block !== 'object' || block === null) return false;
    const t = (block as { t?: unknown }).t;
    if (t === 'p') return true;
    if (t === 'media') {
        const mediaId = (block as { mediaId?: unknown }).mediaId;
        return typeof mediaId === 'string' && mediaId.length > 0;
    }
    return false;
}

/**
 * 解析块 JSON（坏数据降级为空容器——日记正文损坏不该打不开页面）。
 * 旧数据块无 id：解析时统一回填（保存后随 JSON 持久化，此后稳定）。
 */
export function parseBlocks(json: string): JournalBlock[] {
    try {
        const parsed: unknown = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(isBlockShape)
            .map((block) => (block.id ? block : { ...block, id: newBlockId() }));
    } catch {
        // 手写 JSON 损坏按空日记处理：内容仍在 DB，可编辑重写
        return [];
    }
}

export function serializeBlocks(blocks: JournalBlock[]): string {
    return JSON.stringify(blocks);
}

/** 新建文本块（空段/续写统一入口，id 必填）。 */
export function newParagraphBlock(text = ''): JournalBlock {
    return { t: 'p', id: newBlockId(), text };
}

/**
 * 稳定排序：把 id 对应块上移/下移一格（-1/+1），越界原样返回。
 * React key = 块 id，移动不换 key → TextInput 实例不重建，焦点与光标保持。
 */
export function moveBlock(blocks: JournalBlock[], id: string, direction: -1 | 1): JournalBlock[] {
    const index = blocks.findIndex((block) => block.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= blocks.length) return blocks;
    const next = [...blocks];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    return next;
}

/**
 * 删除块（移块不删文件：媒体行与二进制保留，软删除语义防误删丢失）。
 * 编辑器至少留一个可落笔段：删到空、或删完只剩媒体块（无任何文本段，
 * 用户将永远无法再写字）时，补一个空文本段兜底。
 */
export function removeBlock(blocks: JournalBlock[], id: string): JournalBlock[] {
    const next = blocks.filter((block) => block.id !== id);
    if (next.length === 0 || !next.some((block) => block.t === 'p')) {
        return [...next, newParagraphBlock()];
    }
    return next;
}

/** 字数 = 全部文本块长度（中文按字计，商业口径简单诚实）。 */
export function wordCount(blocks: JournalBlock[]): number {
    return blocks.reduce((sum, block) => (block.t === 'p' ? sum + block.text.length : sum), 0);
}

// ─── 笔记标题（v4，DEV.md #6）────────────────────────────────────────────────

/** 标题长度上限（输入框 maxLength 与此同源；store 落库前钳制，防绕过 UI 直写）。 */
export const JOURNAL_TITLE_MAX = 60;

/**
 * 标题规范化：trim 后空串视为清除（返回 null = 未命名态）；超长钳制
 * （标题是展示性元数据，截断优于让保存失败——UI 侧 maxLength 只是第一道闸）。
 */
export function normalizeJournalTitle(title: string): string | null {
    const trimmed = title.trim();
    if (trimmed.length === 0) return null;
    return trimmed.slice(0, JOURNAL_TITLE_MAX);
}

/** 是否可继续写：只有 open 状态的日记可编辑（手动完成 / 24:00 自动收笔后只读）。 */
export function isEditable(status: JournalStatus): boolean {
    return status === 'open';
}

/**
 * 收笔页能否重开：仅当天的页可重开（Day One 同款语义）——
 * 昨天及更早的页是历史，重开破坏「24:00 收笔」的产品承诺。
 */
export function canReopen(row: Pick<JournalRow, 'status' | 'local_date'>, today = todayLocal()): boolean {
    return row.status === 'closed' && row.local_date >= today;
}

/**
 * 在末尾追加媒体块 + 一个空文本段（媒体先落库拿到 mediaId 再进块）。
 * 返回新文本段的 id 供编辑器自动聚焦续写；媒体块可携带 durationMs（音频时长元数据）。
 */
export function withMediaAppended(
    blocks: JournalBlock[],
    mediaId: string,
    options?: { durationMs?: number },
): { blocks: JournalBlock[]; textId: string } {
    const textId = newBlockId();
    const mediaBlock: JournalBlock = {
        t: 'media',
        id: newBlockId(),
        mediaId,
        ...(options?.durationMs != null ? { durationMs: options.durationMs } : {}),
    };
    return { blocks: [...blocks, mediaBlock, newParagraphBlock()], textId };
}

/** 末尾若是空文本块则复用（避免连续空段堆积）。 */
export function withTextAppended(blocks: JournalBlock[], text: string): JournalBlock[] {
    const last = blocks[blocks.length - 1];
    if (last && last.t === 'p' && last.text === '') {
        return [...blocks.slice(0, -1), { t: 'p', id: last.id, text }];
    }
    return [...blocks, newParagraphBlock(text)];
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

// ─── 图片数量上限与媒体插入落点（v8，编辑器插入流纯函数）─────────────────────

/**
 * 单篇日记的图片数量上限（微信九图口径）：限制的是**日记图片总量**
 * （blocks 中引用的图片媒体数，含堆叠组内的每一张——限制在数据层不在
 * 展示层，堆叠展示本身不设限）。9 = 主流 IM 相册单选上限的用户心智档，
 * 商业版可调常量放开。与屏层 MAX_MEDIA（全媒体总量防误触爆量）并存：
 * 图片路径两道闸都过，视频/音频仍只受 MAX_MEDIA 约束。
 */
export const JOURNAL_IMAGE_LIMIT = 9;

/**
 * 图片插入配额校验：现有图片数 + 本次待插张数超过上限 → 拒绝。
 * 判定语义 = 「插完 ≤ 9 张放行」：恰好插满 9 张允许，第 10 张起拒绝。
 *
 * @param imageCount 现有图片媒体数（屏层经 mediaById 判 kind 后传入，见
 *   countImageBlocks——本模块禁运行时 db 依赖，kind 判定注入）。
 * @param incoming 本次待插张数（拍照/单选取 1；未来相册多选传批量数）。
 */
export function canInsertImages(imageCount: number, incoming: number): boolean {
    return imageCount + incoming <= JOURNAL_IMAGE_LIMIT;
}

/**
 * 统计 blocks 引用的图片媒体数（配额校验与首页 meta 口径的单一实现）：
 * isImage 由调用方注入（mediaById.get(id)?.kind === 'image'，pending 占位
 * id 查不到行 → false，天然不计入）。
 */
export function countImageBlocks(
    blocks: JournalBlock[],
    isImage: (mediaId: string) => boolean,
): number {
    let count = 0;
    for (const block of blocks) {
        if (block.t === 'media' && isImage(block.mediaId)) count += 1;
    }
    return count;
}

/**
 * pending 占位插入落点（插入流第一步，v8 修复「堆叠后无法新增图片」）：
 * - 图片：**最后一个图片媒体块之后**（无图片块则文档末尾）——回填后新图
 *   与既有连续图片串相邻，经渲染层 buildRenderUnits 的连续相邻判定并入
 *   堆叠组（组在中间也成立；孤立图 + 新图 = 成新组，同一语义）。v7 实现
 *   恒追加文档末尾：组后还有文本时新图与组隔离永不成组、且落在可视区外
 *   （「点了没反应/不出现」的体感根因之一）；
 * - 视频/音频：不参与堆叠，恒落文档末尾（不落图片串内部，不打断既有
 *   连续性）。
 * isImage 注入 kind 判定（同 countImageBlocks）；pending 占位 id 查不到行
 * → false，不被当作落点锚（在途占位不参与下一次落点计算）。
 */
export function insertPendingBlock(
    blocks: JournalBlock[],
    kind: 'image' | 'video' | 'audio',
    pendingId: string,
    isImage: (mediaId: string) => boolean,
): JournalBlock[] {
    const pending: JournalBlock = {
        t: 'media',
        id: pendingId,
        mediaId: PENDING_MEDIA_ID,
    };
    if (kind !== 'image') return [...blocks, pending];
    let insertAt = blocks.length;
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block.t === 'media' && isImage(block.mediaId)) {
            insertAt = i + 1;
            break;
        }
    }
    const next = [...blocks];
    next.splice(insertAt, 0, pending);
    return next;
}

/**
 * pending 占位原位回填（插入流收口步，v8）：pendingId 块**原位替换**为
 * 真实媒体块——落点语义「按插入位置成组」由占位与回填共用同一下标保证
 * （v7 回填恒追加文档末尾，占位在中间时真实块与串隔开、还从原位「跳」到
 * 文末）。mediaId 为 null（落库失败，store 已上浮 error）时仅移除占位。
 * 只处理本 pendingId：不误伤其他在途占位（并发通道防御），占位已不在
 * （防御）时原样返回、不重建数组。
 */
export function resolvePendingBlock(
    blocks: JournalBlock[],
    pendingId: string,
    media: { blockId: string; mediaId: string; durationMs?: number } | null,
): JournalBlock[] {
    const index = blocks.findIndex((block) => block.id === pendingId);
    if (index < 0) return blocks;
    const next = [...blocks];
    if (!media) {
        next.splice(index, 1);
        return next;
    }
    next[index] = {
        t: 'media',
        id: media.blockId,
        mediaId: media.mediaId,
        ...(media.durationMs != null ? { durationMs: media.durationMs } : {}),
    };
    return next;
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
