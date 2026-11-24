import { openDatabase } from '@/core/database';
// v8 createPlan 的行 id 生成走 core 随机源（web 非安全上下文有 getRandomValues 兜底，
// 异常原样上抛由 store 层转 error 通道）
import { crypto } from '@/core/crypto';
import { ARCHIVE_MIGRATIONS } from './migrations';
// PENDING_MEDIA_ID 本模块消毒逻辑自用（下方同时 re-export 供域内其他层取用）
import { PENDING_MEDIA_ID } from './schema';
// v8 独立计划：初始正文复用日记块模型纯函数、local_date 的「当天」口径复用
// trip-logic。db（SQL 层）→ 纯函数模块是向下依赖；由此形成的模块环（唯一环边
// 是 trip-logic → './db' 取 TRIP_OPEN_ENDED 常量的 v5 遗留引用）上所有跨模块取值
// 都在函数体内（调用期求值），各模块体只做常量/函数定义、无顶层跨模块求值，
// Metro/Babel 的模块环解析下运行时安全——纪律：勿在环上任何模块体里取跨模块值。
import { newParagraphBlock, serializeBlocks } from '../journal-logic';
import { todayLocal } from '../trip-logic';
import type {
    DayPlanRow,
    EventMediaRow,
    EventRow,
    EventStatus,
    JournalKind,
    JournalMediaRow,
    JournalRow,
    PlanStatus,
    TripDayMetaRow,
    TripItemRow,
    TripItemStatus,
    TripMediaRow,
    TripRow,
} from './schema';

export type {
    DayPlanRow,
    EventMediaKind,
    EventMediaRow,
    EventRow,
    EventStatus,
    EventSubjectKind,
    JournalBlock,
    JournalKind,
    JournalMediaKind,
    JournalMediaRow,
    JournalRow,
    JournalStatus,
    PlanStatus,
    TripDayMetaRow,
    TripItemRow,
    TripItemStatus,
    TripMediaKind,
    TripMediaRow,
    TripRow,
} from './schema';
// 数据层常量收口：编辑器/屏层的占位 id 与持续性行程哨兵一律从这里（或域入口）拿，
// 禁止在 ui 层自定义字面量（v5 打破 require cycle 后的唯一事实源）
export { PENDING_MEDIA_ID, TRIP_OPEN_ENDED } from './schema';

/**
 * archive 域数据库（R9）：域内唯一 SQL 出口。
 * 文件按域隔离为 archive.db，与 core 五件套（almightydb.db）互不混用；
 * 迁移经 core/database 注册表在事务内执行。
 */
const DATABASE_NAME = 'archive.db';

let dbPromise: ReturnType<typeof openDatabase> | null = null;

function getDb(): ReturnType<typeof openDatabase> {
    if (!dbPromise) {
        dbPromise = openDatabase(DATABASE_NAME, { migrations: ARCHIVE_MIGRATIONS });
    }
    return dbPromise;
}

// ─── trips ───────────────────────────────────────────────────────────────────

export async function listTrips(): Promise<TripRow[]> {
    const db = await getDb();
    return db.getAll<TripRow>(
        'SELECT * FROM trips WHERE deleted_at IS NULL ORDER BY start_date DESC',
    );
}

export async function getTrip(id: string): Promise<TripRow | null> {
    const db = await getDb();
    return db.getFirst<TripRow>('SELECT * FROM trips WHERE id = ? AND deleted_at IS NULL', [id]);
}

export async function insertTrip(row: Omit<TripRow, 'deleted_at'>): Promise<void> {
    const db = await getDb();
    await db.run(
        `INSERT INTO trips (id, title, start_date, end_date, note, description, icon, video_key, cover_key, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
            row.id,
            row.title,
            row.start_date,
            row.end_date,
            row.note,
            row.description,
            row.icon,
            row.video_key,
            row.cover_key,
            row.created_at,
            row.updated_at,
        ],
    );
}

export async function updateTrip(
    id: string,
    patch: Partial<Pick<TripRow, 'title' | 'start_date' | 'end_date' | 'description' | 'icon' | 'video_key'>>,
): Promise<void> {
    const db = await getDb();
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [column, value] of Object.entries(patch)) {
        fields.push(`${column} = ?`);
        params.push(value as string | number | null);
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    params.push(Date.now(), id);
    await db.run(`UPDATE trips SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function softDeleteTrip(id: string): Promise<void> {
    const db = await getDb();
    await db.run('UPDATE trips SET deleted_at = ?, updated_at = ? WHERE id = ?', [Date.now(), Date.now(), id]);
}

/**
 * 删除行程的行级级联（DEV.md #1.1：删行程必须连内容一起删，不留孤儿引用）：
 * 行删除（软删，对齐域约定）在一个事务内完成；文件清理由 store 层在事务外
 * 逐个 fileStorage.remove（失败不回滚行删除，见 store.deleteTrip）。
 * 注意必须在调用前收集齐 file_key（本函数之后行已不可见——所有语句过滤 deleted_at IS NULL）。
 * @param at 统一的删除时间戳（同一事件一个时间，审计口径一致）
 */
export async function softDeleteTripCascade(
    id: string,
    at: number,
): Promise<void> {
    const db = await getDb();
    await db.withTransaction(async () => {
        // 行程内媒体（直挂行程的部分；日卡背景图也是 trip_media 行，随此软删，
        // 其 file_key 由 store.deleteTrip 在调用前经 listTripMediaByTrip 收集——
        // 指针行不拦文件回收）
        await db.run('UPDATE trip_media SET deleted_at = ? WHERE trip_id = ? AND deleted_at IS NULL', [at, id]);
        // 日记媒体：子查询不经 deleted_at 过滤（先删日记行也不丢媒体行）
        await db.run(
            `UPDATE journal_media SET deleted_at = ?
             WHERE deleted_at IS NULL
               AND journal_id IN (SELECT id FROM journals WHERE trip_id = ?)`,
            [at, id],
        );
        // 逐日计划（行程删则骨架计划一并失效，避免 tripStats 留孤儿分组）
        await db.run('UPDATE day_plans SET deleted_at = ?, updated_at = ? WHERE trip_id = ? AND deleted_at IS NULL', [at, at, id]);
        // 行程项（v9）：行程删则逐条安排一并失效（对齐 day_plans 的级联口径）；
        // 关联媒体（trip_media.item_id）已在上面 trip_media 段随行程软删，媒体行
        // 的 item_id 无需摘除——行已软删，关联不可见
        await db.run('UPDATE trip_items SET deleted_at = ?, updated_at = ? WHERE trip_id = ? AND deleted_at IS NULL', [at, at, id]);
        // 逐日指针（v5 trip_day_meta）：指针行无内容可回收，随行程硬删（域约定例外，
        // 见 schema.ts 注释）；其指向的媒体行已在上面走常规软删
        await db.run('DELETE FROM trip_day_meta WHERE trip_id = ?', [id]);
        // 日记行（最后删：上面 journal_media 的子查询依赖 trip_id 可查）
        await db.run('UPDATE journals SET deleted_at = ?, updated_at = ? WHERE trip_id = ? AND deleted_at IS NULL', [at, at, id]);
        // 行程本体收尾
        await db.run('UPDATE trips SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, at, id]);
    });
}

/** 删除单篇日记的行级级联：日记行 + 其媒体行（软删，同上事务语义）。 */
export async function softDeleteJournalCascade(id: string, at: number): Promise<void> {
    const db = await getDb();
    await db.withTransaction(async () => {
        await db.run('UPDATE journal_media SET deleted_at = ? WHERE journal_id = ? AND deleted_at IS NULL', [at, id]);
        await db.run('UPDATE journals SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [at, at, id]);
    });
}

/** 各行程的日记天数与计划完成度（行程卡 / me 页）。 */
export interface TripStats {
    journalDays: number;
    plansTotal: number;
    plansDone: number;
}

export async function tripStats(): Promise<Map<string, TripStats>> {
    const db = await getDb();
    // 统计窗口 = 行程自身日期区间（2026-11-11 反馈四配套修正）：调整行程天数
    // （改 start/end）后，落在窗外（原区间多出的日子）的日记/计划行仍留库——
    // 详情页逐日骨架只渲染窗内日（tripDayList），统计若全量计数就会出现
    // 「已写 6/5 天」「计划完成 2/10 但行程只有 5 天」的旧值/超分母错位。
    // 修后按 local_date ∈ [start_date, end_date] 过滤，与详情页骨架口径一致；
    // 持续性行程 end_date = 'open'（字典序恒大于任何 YYYY-MM-DD），显式
    // OR end_date = 'open' 表达「无上界」（同 searchTrips 的写法，不靠隐式巧合）。
    const journalCounts = await db.getAll<{ trip_id: string; n: number }>(
        `SELECT j.trip_id AS trip_id, COUNT(DISTINCT j.local_date) AS n
         FROM journals j
         JOIN trips t ON t.id = j.trip_id AND t.deleted_at IS NULL
         WHERE j.deleted_at IS NULL AND j.trip_id IS NOT NULL
           AND j.local_date >= t.start_date
           AND (j.local_date <= t.end_date OR t.end_date = 'open')
         GROUP BY j.trip_id`,
    );
    const planRows = await db.getAll<{ trip_id: string; total: number; done: number }>(
        `SELECT p.trip_id AS trip_id, COUNT(*) AS total, COALESCE(SUM(p.done), 0) AS done
         FROM day_plans p
         JOIN trips t ON t.id = p.trip_id AND t.deleted_at IS NULL
         WHERE p.deleted_at IS NULL
           AND p.local_date >= t.start_date
           AND (p.local_date <= t.end_date OR t.end_date = 'open')
         GROUP BY p.trip_id`,
    );
    const map = new Map<string, TripStats>();
    for (const row of journalCounts) {
        map.set(row.trip_id, { journalDays: row.n, plansTotal: 0, plansDone: 0 });
    }
    for (const row of planRows) {
        const existing = map.get(row.trip_id) ?? { journalDays: 0, plansTotal: 0, plansDone: 0 };
        map.set(row.trip_id, { ...existing, plansTotal: row.total, plansDone: row.done });
    }
    return map;
}

// ─── journals（v8 起为日记 + 独立计划双实体容器，kind 列区分；本段 daily 专属
// ─── 取径已逐一过滤，按 id/关键词的共用出口不筛 kind）──────────────────────────

export async function getJournalByDate(tripId: string | null, localDate: string): Promise<JournalRow | null> {
    const db = await getDb();
    // v8 kind 过滤（daily 取页路径专属）：独立计划的 trip_id 同样为 NULL、local_date
    // 同样可能落在今天——不筛 kind 的话打开 /write 的 LIMIT 1 可能命中当天新建的
    // 计划行，日记页被张冠李戴（计划无「一天一篇」语义，不经本入口，走 createPlan）。
    const row = await db.getFirst<JournalRow>(
        "SELECT * FROM journals WHERE deleted_at IS NULL AND kind = 'daily' AND trip_id IS ? AND local_date = ? LIMIT 1",
        [tripId, localDate],
    );
    // 载入消毒（上传中断恢复）：PENDING 占位块正常只存在于编辑器内存，落库即脏数据
    return row ? { ...row, blocks: sanitizeBlocksJson(row.blocks) } : null;
}

/**
 * 幂等插入日记：撞同日唯一索引（迁移 v3）时不覆盖已有行，返回 false 交调用方回读。
 * INSERT OR IGNORE 对（trip_id, local_date）并发的双插入只放行一条——ensureJournal 的竞态兜底。
 */
export async function insertJournalIfAbsent(row: Omit<JournalRow, 'deleted_at'>): Promise<boolean> {
    const db = await getDb();
    const result = await db.run(
        `INSERT OR IGNORE INTO journals (id, trip_id, local_date, title, kind, description, blocks, status, word_count, created_at, updated_at, completed_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [row.id, row.trip_id, row.local_date, row.title, row.kind, row.description, row.blocks, row.status, row.word_count, row.created_at, row.updated_at, row.completed_at],
    );
    return result.changes > 0;
}

export async function updateJournalBlocks(id: string, blocks: string, wordCount: number): Promise<void> {
    const db = await getDb();
    await db.run('UPDATE journals SET blocks = ?, word_count = ?, updated_at = ? WHERE id = ?', [
        blocks,
        wordCount,
        Date.now(),
        id,
    ]);
}

/** 计划标题（v4，DEV.md #6）：null = 清除标题（未命名态）。 */
export async function updateJournalTitle(id: string, title: string | null): Promise<void> {
    const db = await getDb();
    await db.run('UPDATE journals SET title = ?, updated_at = ? WHERE id = ?', [title, Date.now(), id]);
}

/**
 * 手动收笔（日记专属语义，v8 起带 kind 过滤）：收笔/重开是「一天一篇」日记的
 * 状态机。v11 起计划三态由 updatePlanMeta(status) 收口（标记完成/失败走计划
 * 自己的写入口），本函数不再是计划的完成通道——kind 过滤后对计划的误调用
 * UPDATE 命中 0 行静默不生效，计划保持自身状态（优于无过滤时把计划误写成
 * 日记口径的 closed 收笔）。
 */
/** 完成日记（历史注：2026-11-19 产品变更曾让计划也走本函数落 closed；v11 起
    计划完成走 updatePlanMeta——closed 值沿用，存量已完成计划不迁移）。 */
export async function completeJournal(id: string): Promise<void> {
    const db = await getDb();
    await db.run(
        "UPDATE journals SET status = 'closed', completed_at = ?, updated_at = ? WHERE id = ? AND kind = 'daily'",
        [Date.now(), Date.now(), id],
    );
}

/** 重开收笔页（仅当天可重开，判定在 journal-logic.canReopen；日记专属，见 completeJournal）。 */
export async function reopenJournal(id: string): Promise<void> {
    const db = await getDb();
    await db.run("UPDATE journals SET status = 'open', completed_at = NULL, updated_at = ? WHERE id = ? AND kind = 'daily'", [
        Date.now(),
        id,
    ]);
}

export async function getJournal(id: string): Promise<JournalRow | null> {
    const db = await getDb();
    const row = await db.getFirst<JournalRow>('SELECT * FROM journals WHERE id = ? AND deleted_at IS NULL', [id]);
    // 载入消毒（上传中断恢复）：同 getJournalByDate，编辑器/详情的单一载入口统一摘占位块
    return row ? { ...row, blocks: sanitizeBlocksJson(row.blocks) } : null;
}

/**
 * 本地时区 24:00 自动收笔：所有 open 且日期早于今天的**日记**（kind = 'daily'）收口。
 * v8 关键正确性点：独立计划的 local_date 只是创建日，不参与收笔机——不筛 kind
 * 会把昨天建的计划也「收笔」成只读，违背计划不受收笔语义约束的产品定义
 * （v11 起计划有自持的三态状态机，与收笔扫描更不可互扰）。
 */
export async function closeStaleOpenJournals(today: string): Promise<number> {
    const db = await getDb();
    const result = await db.run(
        "UPDATE journals SET status = 'closed', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE status = 'open' AND local_date < ? AND kind = 'daily'",
        [Date.now(), Date.now(), today],
    );
    return result.changes;
}

/** 行程内逐日日记（行程详情时间线）。 */
export async function listJournalsByTrip(tripId: string): Promise<JournalRow[]> {
    const db = await getDb();
    return db.getAll<JournalRow>(
        'SELECT * FROM journals WHERE deleted_at IS NULL AND trip_id = ? ORDER BY local_date DESC, created_at ASC',
        [tripId],
    );
}

/** 日常日记（无行程）最近列表（v8 起带 kind 过滤：计划 trip_id 同为 NULL，
 *  不筛会混入日常日记时间线——计划列表走 listPlans，两条列表互不混入）。 */
export async function listDailyJournals(limit = 60): Promise<JournalRow[]> {
    const db = await getDb();
    return db.getAll<JournalRow>(
        "SELECT * FROM journals WHERE deleted_at IS NULL AND kind = 'daily' AND trip_id IS NULL ORDER BY local_date DESC LIMIT ?",
        [limit],
    );
}

// ─── 独立计划（v8：journals.kind = 'note'，复用日记容器与媒体/块管线）───────
// 复用面：getJournal / updateJournalBlocks / updateJournalTitle /
// softDeleteJournalCascade / mediaByJournalIds / searchJournals（按 id/关键词
// 查询不筛 kind——计划可被搜索，期望行为）均对 note 行同样适用，无需按 kind
// 复制一套出口。状态口径（v11）：计划三态 open/closed/failed 由本模块
// updatePlanMeta 收口写入；复用面里 isEditable 闸天然承接「非 open 即只读」
// （已终态计划的正文保存/改名被 store 预检挡住，与日记收笔同机制）。

/**
 * 新建独立计划（store.createPlan 编排）：kind 'note'，trip_id 恒 null（计划不从属
 * 行程），local_date = 创建当天（todayLocal，仅展示/排序用——计划无「归属日」
 * 语义，不受同日唯一索引与 24:00 自动收笔约束）。title/description 由调用方
 * 校验后传入，此处 trim 后直落（v0.4.5 起 store 校验标题必填、对齐事件建页
 * 口径；db 保留空串弹性——历史未命名行与改名清除语义都靠展示层
 * 「未命名计划」兜底）。
 * 正文初始化为单个空文本段（复用日记块模型，编辑器至少留一个可落笔段）。
 *
 * 分工说明：id 在本函数内生成（签名只收 title/description；core/crypto 的
 * randomUUID 自带 web 非安全上下文兜底，异常原样上抛由 store 层 try 转 error
 * 通道——与 createTrip/createEvent 的 error 口径一致）；blocks 初始化复用
 * journal-logic 纯函数（依赖方向见文件头 import 注）。直接 INSERT 不带
 * OR IGNORE：计划被同日唯一索引排除（部分索引只圈 daily），无冲突可撞。
 */
export async function createPlan(input: { title: string; description: string }): Promise<JournalRow> {
    const db = await getDb();
    const now = Date.now();
    const row: JournalRow = {
        id: crypto.randomUUID(),
        kind: 'note',
        trip_id: null,
        local_date: todayLocal(),
        title: input.title.trim(),
        description: input.description.trim(),
        blocks: serializeBlocks([newParagraphBlock()]),
        status: 'open',
        word_count: 0,
        created_at: now,
        updated_at: now,
        completed_at: null,
        deleted_at: null,
    };
    await db.run(
        `INSERT INTO journals (id, trip_id, local_date, title, kind, description, blocks, status, word_count, created_at, updated_at, completed_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
            row.id,
            row.trip_id,
            row.local_date,
            row.title,
            row.kind,
            row.description,
            row.blocks,
            row.status,
            row.word_count,
            row.created_at,
            row.updated_at,
            row.completed_at,
        ],
    );
    return row;
}

/** 独立计划列表（updated_at DESC = 最近活动在前，对齐 listEvents 排序口径）。 */
export async function listPlans(limit = 200): Promise<JournalRow[]> {
    const db = await getDb();
    return db.getAll<JournalRow>(
        "SELECT * FROM journals WHERE deleted_at IS NULL AND kind = 'note' ORDER BY updated_at DESC LIMIT ?",
        [limit],
    );
}

/**
 * 独立计划状态计数（v11，Me 计划行尾用）：未删 note 行按 status 一次 GROUP BY
 * 出三档（open = 进行中 / closed = 完成 / failed = 失败），缺档补 0——口径对齐
 * eventStatusCounts（事件行尾同款「进行 N · 完成 N · 失败 N」）。
 */
export async function noteStatusCounts(): Promise<{
    open: number;
    closed: number;
    failed: number;
}> {
    const db = await getDb();
    const rows = await db.getAll<{ status: PlanStatus; n: number }>(
        "SELECT status, COUNT(*) AS n FROM journals WHERE kind = 'note' AND deleted_at IS NULL GROUP BY status",
    );
    const byStatus = new Map(rows.map((row) => [row.status, row.n]));
    return {
        open: byStatus.get('open') ?? 0,
        closed: byStatus.get('closed') ?? 0,
        failed: byStatus.get('failed') ?? 0,
    };
}

/**
 * 独立计划元信息更新（store.updatePlanMeta 编排，v11 起含状态）：title null =
 * 清除为未命名（对齐 updateJournalTitle 的可空语义）；任一写入都 bump
 * updated_at。status（v11，计划三态）：终态（closed/failed）落 completed_at =
 * 此刻（对齐 completeJournal 的收笔锚点语义，标记即归档时刻）；回 open 清
 * completed_at（对齐 reopenJournal）。枚举合法性由 store 预检（isPlanStatus），
 * 「目标必须是计划」的 kind 校验同样在 store 层（db 认列值、业务校验在 store，
 * 分层同 updateJournalTitle 的 isEditable 预检）。
 */
export async function updatePlanMeta(
    id: string,
    patch: { title?: string | null; description?: string; status?: PlanStatus },
): Promise<void> {
    const db = await getDb();
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.title !== undefined) {
        fields.push('title = ?');
        params.push(patch.title);
    }
    if (patch.description !== undefined) {
        fields.push('description = ?');
        params.push(patch.description);
    }
    if (patch.status !== undefined) {
        fields.push('status = ?');
        params.push(patch.status);
        // completed_at 与 status 同批写（终态 = 进入终态的时刻；回 open 清空）
        fields.push('completed_at = ?');
        params.push(patch.status === 'open' ? null : Date.now());
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    params.push(Date.now(), id);
    await db.run(`UPDATE journals SET ${fields.join(', ')} WHERE id = ?`, params);
}

// ─── 导出全量读取（M3 数据导出专用）──────────────────────────────────────────
// 与列表查询的唯一差异：无 LIMIT、无归属过滤——导出是全量备份语义，一次读齐
// 全部未删除行（软删行不进导出，与「删除不留孤儿引用」的域约定一致）。
// 块 JSON 不做载入消毒：导出的是库存原样字节（消费方为备份/迁移工具，不是渲染层）。

/** 全量日记（导出）：行程内 + 日常两类，本地日期升序（导出文档自然时序）。 */
export async function listAllJournals(): Promise<JournalRow[]> {
    const db = await getDb();
    return db.getAll<JournalRow>(
        'SELECT * FROM journals WHERE deleted_at IS NULL ORDER BY local_date ASC, created_at ASC',
    );
}

/** 全量逐日计划（导出）。 */
export async function listAllDayPlansForExport(): Promise<DayPlanRow[]> {
    const db = await getDb();
    return db.getAll<DayPlanRow>(
        'SELECT * FROM day_plans WHERE deleted_at IS NULL ORDER BY trip_id ASC, local_date ASC, sort_order ASC',
    );
}

/** 全量日记媒体行（导出；二进制不内嵌，file_key 是落盘位置的引用）。 */
export async function listAllJournalMediaForExport(): Promise<JournalMediaRow[]> {
    const db = await getDb();
    return db.getAll<JournalMediaRow>(
        'SELECT * FROM journal_media WHERE deleted_at IS NULL ORDER BY journal_id ASC, created_at ASC',
    );
}

/** 全量行程媒体行（导出）。 */
export async function listAllTripMediaForExport(): Promise<TripMediaRow[]> {
    const db = await getDb();
    return db.getAll<TripMediaRow>(
        'SELECT * FROM trip_media WHERE deleted_at IS NULL ORDER BY trip_id ASC, created_at ASC',
    );
}

/** 全量日卡背景指针（导出）。 */
export async function listAllTripDayMetaForExport(): Promise<TripDayMetaRow[]> {
    const db = await getDb();
    return db.getAll<TripDayMetaRow>(
        'SELECT * FROM trip_day_meta ORDER BY trip_id ASC, local_date ASC',
    );
}

/** 全量事件（导出）。 */
export async function listAllEventsForExport(): Promise<EventRow[]> {
    const db = await getDb();
    return db.getAll<EventRow>(
        'SELECT * FROM events WHERE deleted_at IS NULL ORDER BY created_at ASC',
    );
}

/** 全量行程项（导出）。 */
export async function listAllTripItemsForExport(): Promise<TripItemRow[]> {
    const db = await getDb();
    return db.getAll<TripItemRow>(
        'SELECT * FROM trip_items WHERE deleted_at IS NULL ORDER BY trip_id ASC, local_date ASC, time ASC',
    );
}

/** 全量事件媒体行（导出）。 */
export async function listAllEventMediaForExport(): Promise<EventMediaRow[]> {
    const db = await getDb();
    return db.getAll<EventMediaRow>(
        'SELECT * FROM event_media WHERE deleted_at IS NULL ORDER BY event_id ASC, created_at ASC',
    );
}

// ─── 备份恢复写入（M3 导入专用）──────────────────────────────────────────────

/** 备份包恢复行集（与导出 payload 同构；行内 deleted_at 恒 null，不参与写入）。 */
export interface BackupRestorePayload {
    trips: TripRow[];
    journals: JournalRow[];
    journalMedia: JournalMediaRow[];
    dayPlans: DayPlanRow[];
    tripMedia: TripMediaRow[];
    tripDayMeta: TripDayMetaRow[];
    tripItems: TripItemRow[];
    events: EventRow[];
    eventMedia: EventMediaRow[];
}

export interface BackupRestoreCounts {
    trips: number;
    journals: number;
    journalMedia: number;
    dayPlans: number;
    tripMedia: number;
    tripDayMeta: number;
    tripItems: number;
    events: number;
    eventMedia: number;
}

/**
 * 备份恢复（导入）：全部行在**一个事务**内 INSERT OR IGNORE 落库（UUID 主键
 * 冲突 / journals 同日唯一索引冲突 / trip_day_meta 主键冲突一律跳过）。
 *
 * **合并语义（existing wins）**：已存在的行原样保留、包内新行补齐——导入后
 * 与既有数据无缝共存（「无缝继续使用」口径）；不提供「包覆盖本机」的破坏性
 * 语义（备份导入是恢复增强，不是清库重置）。事务失败整体回滚，无半恢复态。
 * 行级最小校验：缺 id 的行直接跳过（防御手改包的坏行拖垮整个事务）。
 */
export async function restoreBackupData(payload: BackupRestorePayload): Promise<BackupRestoreCounts> {
    const db = await getDb();
    const counts: BackupRestoreCounts = {
        trips: 0,
        journals: 0,
        journalMedia: 0,
        dayPlans: 0,
        tripMedia: 0,
        tripDayMeta: 0,
        tripItems: 0,
        events: 0,
        eventMedia: 0,
    };
    await db.withTransaction(async () => {
        for (const row of payload.trips) {
            if (!row.id) continue;
            const result = await db.run(
                `INSERT OR IGNORE INTO trips (id, title, start_date, end_date, note, description, icon, video_key, cover_key, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [row.id, row.title, row.start_date, row.end_date, row.note, row.description, row.icon, row.video_key, row.cover_key, row.created_at, row.updated_at],
            );
            counts.trips += result.changes;
        }
        for (const row of payload.journals) {
            if (!row.id) continue;
            const result = await db.run(
                `INSERT OR IGNORE INTO journals (id, trip_id, local_date, title, kind, description, blocks, status, word_count, created_at, updated_at, completed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    row.id,
                    row.trip_id,
                    row.local_date,
                    row.title,
                    // v8 前的备份包行里没有 kind/description 字段（JSON 运行时缺位，
                    // 类型上不可见）——按当时的行语义补默认（v8 前全部是日记）；
                    // 新包原样保真，计划恢复后仍是计划（同日多篇不撞收窄后的唯一索引）
                    row.kind ?? 'daily',
                    row.description ?? '',
                    row.blocks,
                    row.status,
                    row.word_count,
                    row.created_at,
                    row.updated_at,
                    row.completed_at,
                ],
            );
            counts.journals += result.changes;
        }
        for (const row of payload.journalMedia) {
            if (!row.id) continue;
            const result = await db.run(
                `INSERT OR IGNORE INTO journal_media (id, journal_id, file_key, kind, width, height, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [row.id, row.journal_id, row.file_key, row.kind, row.width, row.height, row.created_at],
            );
            counts.journalMedia += result.changes;
        }
        for (const row of payload.dayPlans) {
            if (!row.id) continue;
            const result = await db.run(
                `INSERT OR IGNORE INTO day_plans (id, trip_id, local_date, content, sort_order, done, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [row.id, row.trip_id, row.local_date, row.content, row.sort_order, row.done, row.created_at, row.updated_at],
            );
            counts.dayPlans += result.changes;
        }
        for (const row of payload.tripMedia) {
            if (!row.id) continue;
            // item_id（v9）：新包原样保真行程项关联；v9 前的包行内无该字段（JSON
            // 运行时缺位）按 NULL 补默认（无主媒体）
            const result = await db.run(
                `INSERT OR IGNORE INTO trip_media (id, trip_id, file_key, kind, width, height, duration_ms, item_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [row.id, row.trip_id, row.file_key, row.kind, row.width, row.height, row.duration_ms, row.item_id ?? null, row.created_at],
            );
            counts.tripMedia += result.changes;
        }
        for (const row of payload.tripDayMeta) {
            if (!row.trip_id || !row.local_date) continue;
            const result = await db.run(
                `INSERT OR IGNORE INTO trip_day_meta (trip_id, local_date, background_media_id, updated_at)
                 VALUES (?, ?, ?, ?)`,
                [row.trip_id, row.local_date, row.background_media_id, row.updated_at],
            );
            counts.tripDayMeta += result.changes;
        }
        for (const row of payload.tripItems) {
            if (!row.id) continue;
            const result = await db.run(
                `INSERT OR IGNORE INTO trip_items (id, trip_id, local_date, time, title, description, status, completed_at, wrap_closed_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [row.id, row.trip_id, row.local_date, row.time, row.title, row.description, row.status, row.completed_at, row.wrap_closed_at, row.created_at, row.updated_at],
            );
            counts.tripItems += result.changes;
        }
        for (const row of payload.events) {
            if (!row.id) continue;
            const result = await db.run(
                `INSERT OR IGNORE INTO events (id, title, status, description, blocks, gps_lat, gps_lng, gps_accuracy, handled_by, subject_kind, subject_value, phone, email, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [row.id, row.title, row.status, row.description, row.blocks, row.gps_lat, row.gps_lng, row.gps_accuracy, row.handled_by, row.subject_kind, row.subject_value, row.phone, row.email, row.created_at, row.updated_at],
            );
            counts.events += result.changes;
        }
        for (const row of payload.eventMedia) {
            if (!row.id) continue;
            const result = await db.run(
                `INSERT OR IGNORE INTO event_media (id, event_id, file_key, kind, width, height, duration_ms, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [row.id, row.event_id, row.file_key, row.kind, row.width, row.height, row.duration_ms, row.created_at],
            );
            counts.eventMedia += result.changes;
        }
    });
    return counts;
}

/** 搜索的时间范围过滤（闭区间，本地日期 YYYY-MM-DD）。 */
export interface SearchDateRange {
    from?: string; // local_date >= from
    to?: string; // local_date <= to
}

/**
 * me 页搜索（DEV.md #5 扩展）：块 JSON 与标题双通道 LIKE + 本地日期范围过滤。
 * 范围参数合法性（YYYY-MM-DD）由调用方（store 层）校验，db 层不做日期解析。
 */
export async function searchJournals(
    query: string,
    range: SearchDateRange = {},
    limit = 20,
): Promise<JournalRow[]> {
    const db = await getDb();
    const conditions: string[] = ["deleted_at IS NULL", "(blocks LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')"];
    const params: string[] = [`%${escapeLike(query)}%`, `%${escapeLike(query)}%`];
    if (range.from) {
        conditions.push('local_date >= ?');
        params.push(range.from);
    }
    if (range.to) {
        conditions.push('local_date <= ?');
        params.push(range.to);
    }
    params.push(String(limit));
    return db.getAll<JournalRow>(
        `SELECT * FROM journals WHERE ${conditions.join(' AND ')}
         ORDER BY local_date DESC LIMIT ?`,
        params,
    );
}

/**
 * 行程搜索（DEV.md #5 扩展）：标题+描述 LIKE + 时间范围过滤。
 * 范围语义 = 行程区间与 [from, to] 相交：start_date <= to 且（end_date >= from 或持续性）。
 * 持续性行程无固定结束（TRIP_OPEN_ENDED 哨兵，字典序恒大于任何 YYYY-MM-DD），
 * 显式 OR end_date = 'open' 表达「仍进行中即落在范围内」，不依赖隐式字典序巧合。
 */
export async function searchTrips(
    query: string,
    range: SearchDateRange = {},
    limit = 20,
): Promise<TripRow[]> {
    const db = await getDb();
    const conditions: string[] = [
        "deleted_at IS NULL",
        "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')",
    ];
    const params: string[] = [`%${escapeLike(query)}%`, `%${escapeLike(query)}%`];
    if (range.to) {
        conditions.push("start_date <= ?");
        params.push(range.to);
    }
    if (range.from) {
        conditions.push("(end_date >= ? OR end_date = 'open')");
        params.push(range.from);
    }
    params.push(String(limit));
    return db.getAll<TripRow>(
        `SELECT * FROM trips WHERE ${conditions.join(' AND ')}
         ORDER BY start_date DESC LIMIT ?`,
        params,
    );
}

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 载入消毒（上传中断恢复，防御性兜底）：过滤 blocks JSON 里的 PENDING_MEDIA_ID
 * 占位媒体块。占位块正常只存在于编辑器内存（saveJournalBlocks 落库前已滤除、
 * 屏层上传完成后回填真实 mediaId），落库即脏数据（历史版本/未来路径绕过保存
 * 过滤的残渣）——读取侧统一摘除：编辑器不再渲染坏引用，且下次保存会把消毒
 * 结果写回，行自愈。
 *
 * 落点说明：消毒的理想位置是 journal-logic.parseBlocks（所有读取方的单一解析口），
 * 但该文件不在本次改动权限内，且屏层（journal-edit-screen 等）直连 db 不经 store——
 * 故收口在本文件的两个单条日记载入函数（getJournal / getJournalByDate）。
 * 列表出口（listJournalsByTrip / listDailyJournals / searchJournals）仅喂预览文案
 * （占位块降级 '[媒体]'，不渲染、不再持久化），不做消毒省去逐行 JSON 往返。
 *
 * 坏 JSON 原样放行：读侧 parseBlocks 已有「损坏 → 空容器」降级语义，不在此重复兜底；
 * 无占位块时原串返回（快路径，避免无谓的 stringify 重排）。
 */
function sanitizeBlocksJson(blocks: string): string {
    try {
        const parsed: unknown = JSON.parse(blocks);
        if (!Array.isArray(parsed)) return blocks;
        const cleaned = (parsed as unknown[]).filter(
            (block) =>
                !(
                    typeof block === 'object' &&
                    block !== null &&
                    (block as { t?: unknown }).t === 'media' &&
                    (block as { mediaId?: unknown }).mediaId === PENDING_MEDIA_ID
                ),
        );
        return cleaned.length === parsed.length ? blocks : JSON.stringify(cleaned);
    } catch {
        return blocks;
    }
}

/** me 页 30 天写作曲线：按日的字数总和（日记口径，v8 起带 kind 过滤——计划
 *  字数不计入，me 页指标的「日记」语义保持不变，计划指标待产品定义后另立）。 */
export async function wordCountByDate(sinceDate: string): Promise<Map<string, number>> {
    const db = await getDb();
    const rows = await db.getAll<{ local_date: string; total: number }>(
        "SELECT local_date, SUM(word_count) AS total FROM journals WHERE deleted_at IS NULL AND kind = 'daily' AND local_date >= ? GROUP BY local_date",
        [sinceDate],
    );
    return new Map(rows.map((row) => [row.local_date, row.total]));
}

/**
 * 有日记的日期集合（search 页日历打点专用，装饰性数据；streak 口径走
 * activityDates 不走这里）。v8 起不筛 kind：计划与日记同为可搜索内容
 * （searchJournals 不筛 kind），打点口径与搜索结果保持一致——当天建了计划同样点亮。
 */
export async function journalDates(limitDays = 400): Promise<Set<string>> {
    const db = await getDb();
    const rows = await db.getAll<{ local_date: string }>(
        'SELECT DISTINCT local_date FROM journals WHERE deleted_at IS NULL ORDER BY local_date DESC LIMIT ?',
        [limitDays],
    );
    return new Set(rows.map((row) => row.local_date));
}

/** 累计字数（me 页 KPI「累计字数」）：全部未软删日记的字数总和（空页 word_count=0
 *  自然贡献 0；v8 起带 kind 过滤，计划字数不计入——口径同 wordCountByDate）。 */
export async function journalTotalWords(): Promise<number> {
    const db = await getDb();
    const row = await db.getFirst<{ words: number }>(
        "SELECT COALESCE(SUM(word_count), 0) AS words FROM journals WHERE deleted_at IS NULL AND kind = 'daily'",
    );
    return row?.words ?? 0;
}

/**
 * 「写过日记 N 天」的记录日并集（me 页 journalDays 与 streak 的同一数据源，
 * 2026-11 口径重修）：用户有**内容活动**的本地日期集合，单条 SQL UNION 去重
 * 一次出（无 N+1）。分支与语义：
 *
 * ① 有内容的日记（日常 + 行程日记同表 journals，天然并集，无「行程日记」独立分支）：
 *    local_date，且必须留下过内容——word_count > 0（写了字）∨ title 非空（只写了
 *    标题）∨ 有未软删媒体（只贴了图/音/视频）。**排除空页**：ensureJournal 在用户
 *    打开日记页时即自动建行（空段落 + word_count 0），旧口径 `WHERE deleted_at
 *    IS NULL` 把「打开但没写」的日子也计入 → journalDays/streak 被打开行为灌水
 *    （每天进一次首页 streak 就 +1）——2026-11 用户反馈「写过的日记天数有逻辑
 *    bug」的本体，此处修掉。v8 起另带 kind = 'daily' 过滤：独立计划不计入本并集
 *    （KPI 名目是「写过日记」，计划指标待产品定义后另立，口径同 wordCountByDate）。
 * ②③ 事件创建日/更新日：updated_at 全部为用户编辑触碰（createEvent /
 *    updateEventBlocks / updateEventMeta，见 store 事件编排），无系统触碰路径；
 *    软删行排除。
 * ④⑤ 行程创建日/更新日：updated_at 全部为用户编辑触碰（createTrip / updateTrip，
 *    封面视频 attachTripVideo 亦走 updateTrip；行程媒体上传只落 trip_media 行、
 *    不触碰 trips.updated_at，故媒体日单列 ⑥）；软删行排除。
 * ⑥⑦ 行程/事件媒体上传日：上传为纯用户动作（内容活动总纲：行程里只传了照片
 *    的日子同样算活动日）。
 *
 * 未纳入：trip_day_meta（换背景指针行，无 deleted_at、行程删除即硬删）、
 * day_plans（勾计划）——行程内轻操作，与「写过」语义距离较远，暂不进口径。
 *
 * 时间戳 → 本地日期：epoch ms 整数除 1000 得秒（SQLite 对 INTEGER `/` 整数
 * 截断），`date(..., 'unixepoch', 'localtime')` 取设备时区日期，与 todayLocal()
 * （JS 本地日期）同源一致；个别 web 环境若 'localtime' 不可用会降级为 UTC 日
 * （日记分支用 local_date 原串不受影响，事件/行程日可能偏一天——可接受降级）。
 */
export async function activityDates(): Promise<Set<string>> {
    const db = await getDb();
    const rows = await db.getAll<{ date: string }>(
        `SELECT d FROM (
            SELECT j.local_date AS d
              FROM journals j
             WHERE j.deleted_at IS NULL
               AND j.kind = 'daily'
               AND (j.word_count > 0
                    OR (j.title IS NOT NULL AND j.title <> '')
                    OR j.id IN (SELECT jm.journal_id FROM journal_media jm WHERE jm.deleted_at IS NULL))
            UNION
            SELECT date(e.created_at / 1000, 'unixepoch', 'localtime') FROM events e WHERE e.deleted_at IS NULL
            UNION
            SELECT date(e.updated_at / 1000, 'unixepoch', 'localtime') FROM events e WHERE e.deleted_at IS NULL
            UNION
            SELECT date(t.created_at / 1000, 'unixepoch', 'localtime') FROM trips t WHERE t.deleted_at IS NULL
            UNION
            SELECT date(t.updated_at / 1000, 'unixepoch', 'localtime') FROM trips t WHERE t.deleted_at IS NULL
            UNION
            SELECT date(tm.created_at / 1000, 'unixepoch', 'localtime') FROM trip_media tm WHERE tm.deleted_at IS NULL
            UNION
            SELECT date(em.created_at / 1000, 'unixepoch', 'localtime') FROM event_media em WHERE em.deleted_at IS NULL
        )`,
    );
    return new Set(rows.map((row) => row.date));
}

// ─── journal media ───────────────────────────────────────────────────────────

export async function insertJournalMedia(row: Omit<JournalMediaRow, 'deleted_at'>): Promise<void> {
    const db = await getDb();
    await db.run(
        'INSERT INTO journal_media (id, journal_id, file_key, kind, width, height, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
        [row.id, row.journal_id, row.file_key, row.kind, row.width, row.height, row.created_at],
    );
}

export async function getJournalMedia(id: string): Promise<JournalMediaRow | null> {
    const db = await getDb();
    return db.getFirst<JournalMediaRow>('SELECT * FROM journal_media WHERE id = ? AND deleted_at IS NULL', [id]);
}

/** 指定日记集合的媒体（按 journal_id 分组）。 */
export async function mediaByJournalIds(journalIds: string[]): Promise<Map<string, JournalMediaRow[]>> {
    const grouped = new Map<string, JournalMediaRow[]>();
    if (journalIds.length === 0) return grouped;
    const db = await getDb();
    const placeholders = journalIds.map(() => '?').join(', ');
    const rows = await db.getAll<JournalMediaRow>(
        `SELECT * FROM journal_media WHERE deleted_at IS NULL AND journal_id IN (${placeholders}) ORDER BY created_at ASC`,
        journalIds,
    );
    for (const row of rows) {
        const bucket = grouped.get(row.journal_id);
        if (bucket) bucket.push(row);
        else grouped.set(row.journal_id, [row]);
    }
    return grouped;
}

/**
 * 批量软删日记媒体行（store.saveJournalBlocks 落库后的引用对账专用，DEV.md #1.1）：
 * 编辑器删块只摘 blocks 引用（journal-logic.removeBlock 软删语义，不动媒体行），
 * 孤儿行由对账在此统一回收。单条 UPDATE 原子完成，无需事务；journal_media 无
 * updated_at 列，仅落 deleted_at（对齐 softDeleteTripMedia 口径）。
 * @param at 统一的删除时间戳（同一事件一个时间，审计口径一致）
 */
export async function softDeleteJournalMediaByIds(ids: string[], at: number): Promise<void> {
    if (ids.length === 0) return;
    const db = await getDb();
    const placeholders = ids.map(() => '?').join(', ');
    await db.run(
        `UPDATE journal_media SET deleted_at = ? WHERE deleted_at IS NULL AND id IN (${placeholders})`,
        [at, ...ids],
    );
}

// ─── trip media（v4：行程内媒体，DEV.md #4）─────────────────────────────────

export async function insertTripMedia(row: Omit<TripMediaRow, 'deleted_at'>): Promise<void> {
    const db = await getDb();
    await db.run(
        'INSERT INTO trip_media (id, trip_id, file_key, kind, width, height, duration_ms, item_id, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
        [row.id, row.trip_id, row.file_key, row.kind, row.width, row.height, row.duration_ms, row.item_id, row.created_at],
    );
}

export async function getTripMedia(id: string): Promise<TripMediaRow | null> {
    const db = await getDb();
    return db.getFirst<TripMediaRow>('SELECT * FROM trip_media WHERE id = ? AND deleted_at IS NULL', [id]);
}

/**
 * 单条行程媒体软删（行程媒体卡删除入口；表无 updated_at 列，仅落 deleted_at）。
 * 文件清理由 store 层在行删除后尽力执行（对齐 softDeleteTripCascade 的分工：
 * 调用前先收集 file_key，行删后不可再查）。
 * @param at 统一的删除时间戳（同一事件一个时间，审计口径一致）
 */
export async function softDeleteTripMedia(id: string, at: number): Promise<void> {
    const db = await getDb();
    await db.run('UPDATE trip_media SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [at, id]);
}

/** 行程内媒体时间线（旧→新，行程详情按此顺序铺卡片）。 */
export async function listTripMediaByTrip(tripId: string): Promise<TripMediaRow[]> {
    const db = await getDb();
    return db.getAll<TripMediaRow>(
        'SELECT * FROM trip_media WHERE deleted_at IS NULL AND trip_id = ? ORDER BY created_at ASC, rowid ASC',
        [tripId],
    );
}

// ─── trip day meta（v5：逐日卡背景指针）─────────────────────────────────────

/**
 * 某行程全部日卡背景（local_date → 背景媒体行）：指针 INNER JOIN 媒体行，
 * 悬挂指针（媒体行已软删/缺失）不返回——读取侧对该日降级文字卡，不炸列表。
 * 行查询走主键前缀 (trip_id)，无额外索引需求。
 */
export async function getTripDayBackgroundsByTrip(
    tripId: string,
): Promise<Map<string, TripMediaRow>> {
    const db = await getDb();
    const rows = await db.getAll<TripMediaRow & { local_date: string }>(
        `SELECT d.local_date AS local_date,
                m.id AS id, m.trip_id AS trip_id, m.file_key AS file_key, m.kind AS kind,
                m.width AS width, m.height AS height, m.duration_ms AS duration_ms,
                m.created_at AS created_at, m.deleted_at AS deleted_at
         FROM trip_day_meta d
         JOIN trip_media m ON m.id = d.background_media_id AND m.deleted_at IS NULL
         WHERE d.trip_id = ? AND d.background_media_id IS NOT NULL
         ORDER BY d.local_date ASC`,
        [tripId],
    );
    return new Map(rows.map((row) => [row.local_date, row]));
}

/** 单天背景指针（store 换背景前取旧 mediaId 用）；无指针行 / 指针为空 → null。 */
export async function getTripDayBackgroundMediaId(
    tripId: string,
    localDate: string,
): Promise<string | null> {
    const db = await getDb();
    const row = await db.getFirst<{ background_media_id: string | null }>(
        'SELECT background_media_id FROM trip_day_meta WHERE trip_id = ? AND local_date = ?',
        [tripId, localDate],
    );
    return row?.background_media_id ?? null;
}

/**
 * 写入/替换某天背景指针（upsert，主键冲突即替换）。调用方（store）负责编排
 * 顺序：新媒体行落库 → 本指针切换 → 旧行软删 + 文件清理，保证任何时刻指针
 * 都指向活行。
 */
export async function upsertTripDayBackground(
    tripId: string,
    localDate: string,
    mediaId: string,
    at: number,
): Promise<void> {
    const db = await getDb();
    await db.run(
        `INSERT INTO trip_day_meta (trip_id, local_date, background_media_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(trip_id, local_date) DO UPDATE SET
             background_media_id = excluded.background_media_id,
             updated_at = excluded.updated_at`,
        [tripId, localDate, mediaId, at],
    );
}

/**
 * 按媒体 id 摘背景指针（removeTripMedia 的兜底联动）：任何路径软删行程媒体后
 * 调用，指针清零让该日卡降级文字卡——防「指针在、媒体行不在」的悬挂引用。
 * at 仅落 updated_at 审计时间戳（指针行无 deleted_at）。
 */
export async function detachTripDayBackgroundByMediaId(mediaId: string, at: number): Promise<void> {
    const db = await getDb();
    await db.run(
        'UPDATE trip_day_meta SET background_media_id = NULL, updated_at = ? WHERE background_media_id = ?',
        [at, mediaId],
    );
}

// ─── trip items（v9：行程项，行程表页）──────────────────────────────────────
// 备份边界说明：行程项暂不进导出/恢复（BackupRestorePayload 扩充需同步改
// export.ts 的装配面，该文件不在本轮改动权限内）——恢复 v9 后备份包不携带
// trip_items 行，导入后行程项为空属已知限制（媒体行的 item_id 关联照常进出，
// 行程项本体待后续轮补齐备份链路）。

/** 某天的行程项（行程表页数据源）：按 time ASC（排序即优先级，UI 层再按状态重排）。 */
export async function listTripItemsByDay(tripId: string, date: string): Promise<TripItemRow[]> {
    const db = await getDb();
    return db.getAll<TripItemRow>(
        'SELECT * FROM trip_items WHERE deleted_at IS NULL AND trip_id = ? AND local_date = ? ORDER BY time ASC',
        [tripId, date],
    );
}

/** 某行程全部行程项（删行程前收集通知 identifier 用，对齐 deleteTrip 的先收集后级联口径）。 */
export async function listTripItemsByTrip(tripId: string): Promise<TripItemRow[]> {
    const db = await getDb();
    return db.getAll<TripItemRow>(
        'SELECT * FROM trip_items WHERE deleted_at IS NULL AND trip_id = ? ORDER BY local_date ASC, time ASC',
        [tripId],
    );
}

export async function getTripItem(id: string): Promise<TripItemRow | null> {
    const db = await getDb();
    return db.getFirst<TripItemRow>('SELECT * FROM trip_items WHERE id = ? AND deleted_at IS NULL', [id]);
}

/**
 * 插入行程项（store.createTripItem 编排）：id 由调用方生成（对齐 createTrip /
 * createEvent 口径），title/time/日期合法性校验在 store 层（db 认列值）。
 */
export async function insertTripItem(row: Omit<TripItemRow, 'deleted_at'>): Promise<void> {
    const db = await getDb();
    await db.run(
        `INSERT INTO trip_items (id, trip_id, local_date, time, title, description, status, completed_at, wrap_closed_at, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [row.id, row.trip_id, row.local_date, row.time, row.title, row.description, row.status, row.completed_at, row.wrap_closed_at, row.created_at, row.updated_at],
    );
}

/**
 * 行程项「进入收尾」（store.startTripItemWrap 编排）：completed_at = now
 * （幂等：已非空则 COALESCE 保持原值）。前置校验（阶段/锁定）在 store 层，
 * 这里只落列值 + updated_at。
 */
export async function startTripItemWrap(id: string, at: number): Promise<void> {
    const db = await getDb();
    await db.run(
        'UPDATE trip_items SET completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND deleted_at IS NULL',
        [at, at, id],
    );
}

/**
 * 行程项「结束收尾」（store.closeTripItemWrap 编排）：wrap_closed_at = now
 * = 终态；completed_at 同拍兜底（防御路径上先收尾后结束的空窗）。
 */
export async function closeTripItemWrap(id: string, at: number): Promise<void> {
    const db = await getDb();
    await db.run(
        'UPDATE trip_items SET completed_at = COALESCE(completed_at, ?), wrap_closed_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
        [at, at, at, id],
    );
}

/**
 * 单条行程项软删（store.deleteTripItem 编排）：软删域约定（deleted_at +
 * updated_at 同拍落）。关联媒体的摘除（item_id 置空、媒体行保留）由 store 层
 * 调用 detachTripMediaByItemId 编排，通知取消亦在 store 层。
 * @param at 统一的删除时间戳（同一事件一个时间，审计口径一致）
 */
export async function softDeleteTripItem(id: string, at: number): Promise<void> {
    const db = await getDb();
    await db.run('UPDATE trip_items SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [at, at, id]);
}

/**
 * 按行程项摘媒体关联（store.deleteTripItem 编排）：只摘 item_id 指向（置 NULL），
 * 媒体行保留——图片/视频本体仍是行程媒体，删除行程项不连带删媒体（产品口径：
 * 记录留档，挂靠关系随项消失）。
 */
export async function detachTripMediaByItemId(itemId: string): Promise<void> {
    const db = await getDb();
    await db.run('UPDATE trip_media SET item_id = NULL WHERE item_id = ? AND deleted_at IS NULL', [itemId]);
}

// ─── events（v6：事件实体，类似工单）────────────────────────────────────────

/**
 * 插入事件行（store.createEvent 编排，blocks 由调用方初始化为单空文本段 JSON）。
 * created_at/updated_at 由调用方统一给同一时刻（时间线审计口径）。
 */
export async function insertEvent(row: Omit<EventRow, 'deleted_at'>): Promise<void> {
    const db = await getDb();
    await db.run(
        `INSERT INTO events (id, title, status, description, blocks, gps_lat, gps_lng, gps_accuracy, handled_by, subject_kind, subject_value, phone, email, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
            row.id,
            row.title,
            row.status,
            row.description,
            row.blocks,
            row.gps_lat,
            row.gps_lng,
            row.gps_accuracy,
            row.handled_by,
            row.subject_kind,
            row.subject_value,
            row.phone,
            row.email,
            row.created_at,
            row.updated_at,
        ],
    );
}

export async function getEvent(id: string): Promise<EventRow | null> {
    const db = await getDb();
    const row = await db.getFirst<EventRow>('SELECT * FROM events WHERE id = ? AND deleted_at IS NULL', [id]);
    // 载入消毒（上传中断恢复）：与 getJournal 同口径，单条载入入口统一摘 PENDING 占位块
    return row ? { ...row, blocks: sanitizeBlocksJson(row.blocks) } : null;
}

/**
 * 事件正文落库（store.updateEventBlocks 编排）：blocks 为已序列化 JSON。
 * 事件表无 word_count 冗余列（v6 字段设计：字数按需由 blocks 派生），故只落
 * blocks + updated_at（对齐 updateJournalBlocks 的 updated_at 口径）。
 */
export async function updateEventBlocks(id: string, blocks: string): Promise<void> {
    const db = await getDb();
    await db.run('UPDATE events SET blocks = ?, updated_at = ? WHERE id = ?', [blocks, Date.now(), id]);
}

/**
 * updateEventMeta 的可变字段集合：标题（v6.1 设置卡改名）/ 状态 / 短描述 /
 * GPS 三列 / 处理人 / 对象对 / 联系方式（v7：phone/email）。原子对与 GPS 的
 * 清空语义由 store 层归一化后落库（db 层只认列值，不做解析）；title 的必填/
 * 长度校验同样在 store 层。
 */
export type EventMetaPatch = Partial<
    Pick<
        EventRow,
        | 'title'
        | 'status'
        | 'description'
        | 'gps_lat'
        | 'gps_lng'
        | 'gps_accuracy'
        | 'handled_by'
        | 'subject_kind'
        | 'subject_value'
        | 'phone'
        | 'email'
    >
>;

/** 事件元信息更新（动态 patch，对齐 updateTrip 风格）：任一写入都 bump updated_at。 */
export async function updateEventMeta(id: string, patch: EventMetaPatch): Promise<void> {
    const db = await getDb();
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [column, value] of Object.entries(patch)) {
        fields.push(`${column} = ?`);
        params.push(value as string | number | null);
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    params.push(Date.now(), id);
    await db.run(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`, params);
}

/**
 * 删除事件的行级级联（对齐 softDeleteJournalCascade 的事务语义）：事件行 + 其
 * 媒体行在一个事务内软删；文件清理由 store 层在事务外尽力执行（失败不回滚
 * 行删除，见 store.deleteEvent）。调用方必须先收集 file_key——本函数之后行
 * 已不可见（所有语句过滤 deleted_at IS NULL）。
 * @param at 统一的删除时间戳（同一事件一个时间，审计口径一致）
 */
export async function softDeleteEventCascade(id: string, at: number): Promise<void> {
    const db = await getDb();
    await db.withTransaction(async () => {
        await db.run('UPDATE event_media SET deleted_at = ? WHERE event_id = ? AND deleted_at IS NULL', [at, id]);
        await db.run('UPDATE events SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, at, id]);
    });
}

/**
 * 事件列表（updated_at DESC = 最近活动在前，v6 时间线排序口径）。
 * status 缺省 = 全量（未删行）；status 传 EventStatus（open/done/failed）按状态过滤。
 */
export async function listEvents(filter: { status?: EventStatus } = {}): Promise<EventRow[]> {
    const db = await getDb();
    if (filter.status) {
        return db.getAll<EventRow>(
            'SELECT * FROM events WHERE deleted_at IS NULL AND status = ? ORDER BY updated_at DESC',
            [filter.status],
        );
    }
    return db.getAll<EventRow>(
        'SELECT * FROM events WHERE deleted_at IS NULL ORDER BY updated_at DESC',
    );
}

/**
 * 事件状态计数（Me 指标卡用）：未删行按 status 一次 GROUP BY 出三档
 * （open = 进行中 / done = 完成 / failed = 失败），缺档补 0。
 */
export async function eventStatusCounts(): Promise<{
    open: number;
    done: number;
    failed: number;
}> {
    const db = await getDb();
    const rows = await db.getAll<{ status: EventStatus; n: number }>(
        'SELECT status, COUNT(*) AS n FROM events WHERE deleted_at IS NULL GROUP BY status',
    );
    const byStatus = new Map(rows.map((row) => [row.status, row.n]));
    return {
        open: byStatus.get('open') ?? 0,
        done: byStatus.get('done') ?? 0,
        failed: byStatus.get('failed') ?? 0,
    };
}

/**
 * 事件搜索（v6，v7 扩充为六通道）：关键词 LIKE（title / description /
 * subject_value / handled_by / phone / email——联系方式可被搜索，工单语义
 * 自然）+ 可选状态过滤，updated_at DESC LIMIT。
 * 空 keyword 允许（= 纯状态筛选查询）；keyword 与 status 均缺省时不做无界全量
 * （返回空——全量列表语义走 listEvents，防调用方误用扫全表）。
 */
export async function searchEvents(
    keyword: string,
    filter: { status?: EventStatus } = {},
    limit = 20,
): Promise<EventRow[]> {
    const db = await getDb();
    const conditions: string[] = ['deleted_at IS NULL'];
    const params: (string | number | null)[] = [];
    const trimmed = keyword.trim();
    if (trimmed.length > 0) {
        conditions.push(
            "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR subject_value LIKE ? ESCAPE '\\' OR handled_by LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')",
        );
        const needle = `%${escapeLike(trimmed)}%`;
        params.push(needle, needle, needle, needle, needle, needle);
    }
    if (filter.status) {
        conditions.push('status = ?');
        params.push(filter.status);
    }
    if (conditions.length === 1) return [];
    params.push(String(limit));
    return db.getAll<EventRow>(
        `SELECT * FROM events WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC LIMIT ?`,
        params,
    );
}

// ─── event media（v6：事件内媒体，列对齐 trip_media）────────────────────────

export async function insertEventMedia(row: Omit<EventMediaRow, 'deleted_at'>): Promise<void> {
    const db = await getDb();
    await db.run(
        'INSERT INTO event_media (id, event_id, file_key, kind, width, height, duration_ms, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
        [row.id, row.event_id, row.file_key, row.kind, row.width, row.height, row.duration_ms, row.created_at],
    );
}

export async function getEventMedia(id: string): Promise<EventMediaRow | null> {
    const db = await getDb();
    return db.getFirst<EventMediaRow>('SELECT * FROM event_media WHERE id = ? AND deleted_at IS NULL', [id]);
}

/** 事件内媒体时间线（旧→新，事件详情按此顺序铺卡片，对齐 listTripMediaByTrip）。 */
export async function listEventMediaByEvent(eventId: string): Promise<EventMediaRow[]> {
    const db = await getDb();
    return db.getAll<EventMediaRow>(
        'SELECT * FROM event_media WHERE deleted_at IS NULL AND event_id = ? ORDER BY created_at ASC, rowid ASC',
        [eventId],
    );
}

/**
 * 单条事件媒体软删（事件媒体卡删除入口；表无 updated_at 列，仅落 deleted_at，
 * 对齐 softDeleteTripMedia 口径）。文件清理由 store 层在行删除后尽力执行。
 * @param at 统一的删除时间戳（同一事件一个时间，审计口径一致）
 */
export async function softDeleteEventMedia(id: string, at: number): Promise<void> {
    const db = await getDb();
    await db.run('UPDATE event_media SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [at, id]);
}

/**
 * 批量软删事件媒体行（store.updateEventBlocks 落库后的引用对账专用，对齐
 * softDeleteJournalMediaByIds）：事件正文删媒体块只摘 blocks 引用，孤儿行由
 * 对账统一回收。单条 UPDATE 原子完成，无需事务；表无 updated_at 列，仅落
 * deleted_at。
 * @param at 统一的删除时间戳（同一事件一个时间，审计口径一致）
 */
export async function softDeleteEventMediaByIds(ids: string[], at: number): Promise<void> {
    if (ids.length === 0) return;
    const db = await getDb();
    const placeholders = ids.map(() => '?').join(', ');
    await db.run(
        `UPDATE event_media SET deleted_at = ? WHERE deleted_at IS NULL AND id IN (${placeholders})`,
        [at, ...ids],
    );
}

// ─── 启动孤儿文件 GC（上传中断恢复）─────────────────────────────────────────

/**
 * 孤儿文件 GC 的引用集（存续文件白名单，元素 = file-storage key）。
 * 五路 UNION（UNION 自带去重，同一文件被多处引用只出现一次）：
 * ① 日记媒体：journal_media 未删 且 所属 journals 未删——日记已删时其媒体行即使
 *    因级联中断残留存活，文件也不再受保护（读取侧本就不可见，交 GC 回收）；
 * ② 行程媒体：trip_media 未删（日卡背景图本体也是 trip_media 行，随此覆盖）；
 * ③ 行程封面视频：未删行程的 video_key（可空列，NULL 不产生行）；
 * ④ 日卡背景指针兜底：trip_day_meta.background_media_id → 未删 trip_media 的
 *    file_key。与 ② 当前恒等（活指针必指向活行，编排顺序见 upsertTripDayBackground），
 *    属防御性冗余：防未来指针/行编排改动把背景文件漏出引用集；
 * ⑤ 事件媒体（v6）：event_media 未删（对齐 ② 的行程媒体口径——级联软删保证
 *    事件删除后媒体行同批失效，残留行不保护文件，交 GC 回收）。
 *
 * 语义边界：孤儿媒体行（行未删但 blocks JSON 不再引用，如保存对账前的窗口态）
 * 的文件仍在白名单内——行级对账归 saveJournalBlocks / updateEventBlocks（该容器
 * 下次保存时触发），GC 只负责「已落盘但无任何行引用」的孤儿文件（put 落盘后被杀、
 * insert 未及执行的窗口态）。
 */
export async function listReferencedMediaFileKeys(): Promise<Set<string>> {
    const db = await getDb();
    const rows = await db.getAll<{ file_key: string }>(
        `SELECT jm.file_key AS file_key
         FROM journal_media jm
         JOIN journals j ON j.id = jm.journal_id AND j.deleted_at IS NULL
         WHERE jm.deleted_at IS NULL
         UNION
         SELECT tm.file_key FROM trip_media tm WHERE tm.deleted_at IS NULL
         UNION
         SELECT t.video_key FROM trips t WHERE t.deleted_at IS NULL AND t.video_key IS NOT NULL
         UNION
         SELECT pm.file_key
         FROM trip_day_meta d
         JOIN trip_media pm ON pm.id = d.background_media_id AND pm.deleted_at IS NULL
         WHERE d.background_media_id IS NOT NULL
         UNION
         SELECT em.file_key FROM event_media em WHERE em.deleted_at IS NULL`,
    );
    return new Set(rows.map((row) => row.file_key));
}

// ─── day plans ───────────────────────────────────────────────────────────────

export async function listDayPlansByTrip(tripId: string): Promise<DayPlanRow[]> {
    const db = await getDb();
    return db.getAll<DayPlanRow>(
        'SELECT * FROM day_plans WHERE deleted_at IS NULL AND trip_id = ? ORDER BY local_date ASC, sort_order ASC',
        [tripId],
    );
}

export async function setDayPlanDone(id: string, done: boolean): Promise<void> {
    const db = await getDb();
    await db.run('UPDATE day_plans SET done = ?, updated_at = ? WHERE id = ?', [done ? 1 : 0, Date.now(), id]);
}

/**
 * 单条逐日计划软删（行程详情计划行长按删除入口）：软删域约定（对齐
 * softDeleteTripCascade 的 day_plans 段——deleted_at + updated_at 同拍落，
 * 列结构见 migrations 的 day_plans 建表段），轻量行级操作**不经 store**，
 * 由屏层（trip-detail-screen）直连调用——同本节 setDayPlanDone
 * 的既有取径。删除后的刷新广播由调用方负责（列表重载 +
 * data-revision.notifyDataRevision 中立层广播）。
 * @param at 统一的删除时间戳（同一事件一个时间，审计口径一致）
 */
export async function softDeleteDayPlan(id: string, at: number): Promise<void> {
    const db = await getDb();
    // 绑定参数 = 占位符逐一对应（deleted_at / updated_at / WHERE id）：此前漏传
    // WHERE 段的 id（[at, id] 两个参数对三个 ?），SQLite 未绑定参数按 NULL 处理
    // ——WHERE id = NULL 永假，UPDATE 静默 0 行（不抛错）→ 屏层横幅报成功但行
    // 未删、进度统计不动的整条链路假象（2026-11-11 反馈三根因）。
    await db.run(
        'UPDATE day_plans SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
        [at, at, id],
    );
}
