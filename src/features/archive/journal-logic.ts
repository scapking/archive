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
 * 媒体块 groupId 规范化（parseBlocks 透传旁路的唯一清洗点）：空串/非串的
 * groupId 一律剥除（「无组」语义统一为字段缺席，渲染层判定不必防脏值）；
 * 合法非空串原样透传（自定义合并堆叠的成员资格随 JSON 持久化）。
 */
function normalizeBlockGroup(block: JournalBlock): JournalBlock {
    if (block.t !== 'media' || block.groupId == null) return block;
    if (typeof block.groupId === 'string' && block.groupId.length > 0) return block;
    const { groupId: _dropped, ...rest } = block;
    return rest;
}

/**
 * 解析块 JSON（坏数据降级为空容器——日记正文损坏不该打不开页面）。
 * 旧数据块无 id：解析时统一回填（保存后随 JSON 持久化，此后稳定）。
 * groupId 随 JSON 透传（仅做空值清洗，见 normalizeBlockGroup；无 DB 迁移）。
 */
export function parseBlocks(json: string): JournalBlock[] {
    try {
        const parsed: unknown = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(isBlockShape)
            .map((block) =>
                normalizeBlockGroup(block.id ? block : { ...block, id: newBlockId() }),
            );
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
 * 稳定排序（**连续段版**，2026-11-11 堆叠「整组移动」）：把 [firstIndex,
 * lastIndex] 闭区间整段上移/下移一格（-1/+1），段与相邻的**段外单块**换位
 * ——媒体堆（deck）由多个相邻独立块构成（渲染层合并、数据仍是独立块），
 * 整段同进退 = 堆叠作为一组越过相邻块，组内顺序与连续性零变化（组不解散、
 * 不重排）。越界/非法区间原样返回。单块段的退化行为与 moveBlock 逐位一致
 * （段长 1 时本函数即 moveBlock 的下标直传版）。
 */
export function moveBlockRun(
    blocks: JournalBlock[],
    firstIndex: number,
    lastIndex: number,
    direction: -1 | 1,
): JournalBlock[] {
    if (firstIndex < 0 || firstIndex > lastIndex || lastIndex >= blocks.length) return blocks;
    const target = direction === -1 ? firstIndex - 1 : lastIndex + 1;
    if (target < 0 || target >= blocks.length) return blocks;
    const next = [...blocks];
    const run = next.splice(firstIndex, lastIndex - firstIndex + 1);
    // 上移：段插到原前邻块（移除后位于 firstIndex - 1）之前；下移：段插到
    // 原后邻块（移除后位于 firstIndex + 1）之后——两种方向都恰好换过一位
    const insertAt = direction === -1 ? firstIndex - 1 : firstIndex + 1;
    next.splice(insertAt, 0, ...run);
    return next;
}

/**
 * 删除块（移块不删文件：媒体行与二进制保留，软删除语义防误删丢失）。
 * 编辑器至少留一个可落笔段：删到空、或删完只剩媒体块（无任何文本段，
 * 用户将永远无法再写字）时，补一个空文本段兜底。
 */
export function removeBlock(blocks: JournalBlock[], id: string): JournalBlock[] {
    return removeBlocks(blocks, [id]);
}

/**
 * 批量删块（2026-11-11 堆叠「批量删除」）：一次摘除多个块引用——媒体堆整组
 * 删除即传入组内全部块 id（deck 是独立块序列，删除 = 全员摘引用；媒体行与
 * 二进制不删，与单块删除同一软删除语义）。ids 内不存在的 id 忽略（幂等）。
 * 「至少留一个可落笔段」兜底与 removeBlock 完全同口径（本函数是其批量事实源，
 * 单块版委托至此防双实现漂移）。
 */
export function removeBlocks(blocks: JournalBlock[], ids: readonly string[]): JournalBlock[] {
    const idSet = new Set(ids);
    const next = blocks.filter((block) => !idSet.has(block.id));
    if (next.length === 0 || !next.some((block) => block.t === 'p')) {
        return [...next, newParagraphBlock()];
    }
    return next;
}

/** 字数 = 全部文本块长度（中文按字计，商业口径简单诚实）。 */
export function wordCount(blocks: JournalBlock[]): number {
    return blocks.reduce((sum, block) => (block.t === 'p' ? sum + block.text.length : sum), 0);
}

// ─── 计划标题（v4，DEV.md #6）────────────────────────────────────────────────

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

/**
 * 独立计划（v8，journals.kind = 'note'）描述长度上限：定位类似行程 description
 * 的摘要行（正文细节在 blocks）。创建与更新均「超长整体拒绝不走截断」（对齐
 * 事件标题的校验口径——表单里用户明确输入的独立字段，静默截断会造成「以为存
 * 上了」的错觉；UI maxLength 与此同源，这里是绕过 UI 直写的第二道闸）。
 */
export const PLAN_DESCRIPTION_MAX = 500;

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

// ─── 媒体插入落点（编辑器插入流纯函数；媒体数量上限已按用户指令全域移除，
// 2026-11-20：屏层不再设插入配额，本模块不再提供任何数量闸纯函数）──────────────

/**
 * pending 占位插入落点（插入流第一步，v9 语义回正，用户裁决推翻 v8）：
 * **真实文末追加**——图片占位恒 append 到 blocks 末尾，不再「跳位」到最后
 * 一个图片块之后。v8 的跳位行为被明确否决：堆叠在文档中间、其后又加了
 * 输入框/音频/视频时，新图会越过这些新内容并入旧堆叠，打断文档时间线。
 * 回填后是否并入堆叠组只由**自然相邻**决定（渲染层 buildRenderUnits 的
 * 连续相邻判定，本函数不预设组）：前一块是同 kind 就绪媒体 → 回填后自然
 * 并入堆叠组（堆叠恰在文末的场景）；中间有任何文本/音频/视频 → 不成组，
 * 新图在文末独立成段（堆叠在中间的场景）。
 * kind 参数已随跳位落点逻辑移除（三种 kind 落点统一文末，占位块结构相同）；
 * 回填走 resolvePendingBlock 原位替换（v8 修复保留：占位不被后续编辑挤
 * 漂移，真实媒体块留在插入位置）。
 */
export function insertPendingBlock(blocks: JournalBlock[], pendingId: string): JournalBlock[] {
    const pending: JournalBlock = {
        t: 'media',
        id: pendingId,
        mediaId: PENDING_MEDIA_ID,
    };
    return [...blocks, pending];
}

/**
 * pending 占位原位回填（插入流收口步，v8 引入、v9 保留）：pendingId 块
 * **原位替换**为真实媒体块——防漂移：插入后用户继续写字/插其他媒体会把
 * 占位挤离文末，恒追加文末的回填会让真实块从占位位置「跳」走；原位替换
 * 保证真实媒体块留在占位出现的位置，成组与否交由渲染层 buildRenderUnits
 * 按自然相邻判定（本函数不预设组）。mediaId 为 null（落库失败，store 已
 * 上浮 error）时仅移除占位。只处理本 pendingId：不误伤其他在途占位（并发
 * 通道防御），占位已不在（防御）时原样返回、不重建数组。
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

// ─── 自定义合并堆叠（显式 groupId 组的物化/解散，纯函数）────────────────────

/**
 * 合并堆叠（多选确认的物化步）：把选中媒体块按**选择顺序**物理重排到
 * 「第一选中块」的原位置成连续段，并统一打上 groupId。
 *
 * 语义细则：
 * - 只接受媒体块（t === 'media'）；选中清单里混入的文本/pending 块按无效条目
 *   忽略（多选模式 UI 侧本就不给文本/音频勾选，这里是数据层防御）；
 * - 有效成员 < 2 时原样返回（堆叠 min 2，无上限）；
 * - 连续段落点 = 第一选中块在原数组中的位置——先把未选中块按原序收拢，再把
 *   选中序列插到「第一选中块之前的保留块数」处（等价于其原位置，不受移除
 *   抖动影响，anchor 前的相对顺序零变化）；
 * - groupId 覆盖写（重复合并 = 并入新组，旧组随成员迁移自然消散）。
 * 渲染层 buildRenderUnits 按「连续同 groupId」派生堆叠单元（混合 kind 允许）。
 */
export function mergeStackBlocks(
    blocks: JournalBlock[],
    orderedIds: string[],
    groupId: string,
): JournalBlock[] {
    const byId = new Map(blocks.map((block) => [block.id, block] as const));
    const selected = orderedIds.filter((id) => byId.get(id)?.t === 'media');
    if (selected.length < 2) return blocks;
    const selectedSet = new Set(selected);
    // 落点：第一选中块之前的未选中块数（物理重排不扰动该锚点之前的顺序）
    const anchorId = selected[0];
    let insertAt = 0;
    for (const block of blocks) {
        if (block.id === anchorId) break;
        if (!selectedSet.has(block.id)) insertAt += 1;
    }
    const moved: (JournalBlock | null)[] = selected.map((id) => {
        const block = byId.get(id);
        if (!block || block.t !== 'media') {
            // 不可达（上方 filter 保证媒体块），防御性跳过
            return null;
        }
        return { t: 'media' as const, id: block.id, mediaId: block.mediaId, groupId };
    });
    const others = blocks.filter((block) => !selectedSet.has(block.id));
    const next = [...others];
    const movable = moved.filter((block): block is JournalBlock => block != null);
    next.splice(insertAt, 0, ...movable);
    return next;
}

/**
 * 解散堆叠（仅显式组）：剥掉该 groupId 全部成员的 groupId（无论成员当前是否
 * 连续——用户可能已把成员手动移散），位置零变化。
 * 注意：解散后同 kind 且相邻的成员会立即按渲染层自然相邻规则**重新自动成组**
 * （buildRenderUnits 既有行为），想要完全散开需再手动移开——这是默认分组语义
 * 的既定口径，非缺陷。
 */
export function dissolveStackBlocks(blocks: JournalBlock[], groupId: string): JournalBlock[] {
    let changed = false;
    const next = blocks.map((block) => {
        if (block.t !== 'media' || block.groupId !== groupId) return block;
        changed = true;
        const { groupId: _dropped, ...rest } = block;
        return rest;
    });
    return changed ? next : blocks;
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
