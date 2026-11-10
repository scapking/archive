/**
 * archive 业务域自建表（R9）：DDL 常量 + 行类型，与 migrations.ts 一一对应。
 *
 * v2 产品形态（商业版）：
 * - 日记 = 连续容器（journals）：一天一篇、块结构（文本 + 行内媒体）、
 *   open/closed 状态（手动"完成"或本地时区 24:00 自动收笔）；
 * - 行程（trips）：图标（emoji）、封面视频、描述；
 * - v1 的碎片流（entries/photos）为灰度前形态，v2 直接弃用（发布前 schema 重置）。
 *
 * v4 追加（DEV.md #4/#6/#7，迁移见 migrations.ts）：
 * - journals.title：笔记标题（可空）；
 * - trip_media：行程内媒体（行程独立容器化后媒体直接挂行程）；
 * - trips 持续性：end_date 支持 TRIP_OPEN_ENDED 哨兵（零 DDL，语义见常量注释）。
 *
 * v5 追加（行程逐日卡重构）：
 * - trip_day_meta：逐日展示元数据指针表（当前唯一键：日卡背景图）——背景图
 *   本体是 trip_media 的一行（复用行程媒体上传流），指针方案让媒体行可复用
 *   既有上传/软删/级联/文件清理链路，删除语义见行注释。
 *
 * v6 追加（事件实体，类似工单）：
 * - events：独立可重复新建的业务条目（时间线 + 名字 + GPS + 短描述 + 块正文 +
 *   状态 + 处理人 + 对象），blocks 复用 journal 的 JournalBlock 块 JSON 语义
 *   （媒体行挂 event_media，正文块以 mediaId 引用）；
 * - event_media：事件内媒体，列与 trip_media 对齐（图/视频/音频 + duration_ms），
 *   复用行程媒体同款落盘/软删/级联/文件清理链路。
 *
 * 约定不变：UUID 主键；日期归属用本地日期字符串 `YYYY-MM-DD`；
 * created_at/updated_at 为 epoch ms；删除一律软删除。
 */

/**
 * 媒体上传占位 id（数据层常量，v5 自 ui/editor 下沉至此打破 require cycle）：
 * 媒体块在落盘完成前以该 id 占位（journal_media 尚无对应行）；落库前由
 * store.saveJournalBlocks 过滤占位块，上传完成后屏层回填真实 mediaId。
 * 编辑器 / 屏层一律从 '../db'（或域入口）导入本常量，禁止再各自定义字面量。
 */
export const PENDING_MEDIA_ID = '__pending__';

/**
 * 持续性行程的 end_date 哨兵值（v4「行程持续性」语义，DEV.md #4）：
 * 行程可以没有固定结束日（进行中），end_date 列保持 TEXT NOT NULL 不迁移
 * （SQLite ALTER 无法去除 NOT NULL，重建表违背最小迁移），以 'open' 表示
 * 「未设结束日」。判断一律走 trip-logic.isTripOpenEnded，禁止散落字面量比较。
 */
export const TRIP_OPEN_ENDED = 'open';

/** 日记状态：open = 可继续写；closed = 已收笔（手动完成或跨日自动）。 */
export type JournalStatus = 'open' | 'closed';

/**
 * 日记内容块：文本段或行内媒体（mediaId → journal_media）。
 *
 * `id` 是块级稳定标识（编辑器 React key / 移动排序用）：旧数据无 id，由
 * parseBlocks 解析时回填，保存后随 JSON 持久化（schema 无迁移，纯 JSON 字段）。
 * `durationMs` 仅音频块使用（录音时长；媒体行无可空时长列，块级元数据即真身，
 * 避免为单一字段加表迁移）。
 * `groupId` 仅媒体块使用（自定义合并堆叠）：非空 = 显式堆叠组成员——同 groupId
 * 的媒体块渲染为一个堆叠单元（混合 kind 允许）；成员必须已被物理重排为连续段
 * （由合并操作保证，见 journal-logic.mergeStackBlocks）。纯 JSON 字段，无 DB 迁移；
 * 无 groupId 的相邻同 kind ≥2 仍按渲染层自然相邻规则自动成组。
 */
export type JournalBlock =
    | { t: 'p'; id: string; text: string }
    | { t: 'media'; id: string; mediaId: string; durationMs?: number; groupId?: string };

export interface TripRow {
    id: string;
    title: string;
    start_date: string; // YYYY-MM-DD
    /**
     * 结束日：YYYY-MM-DD，或 TRIP_OPEN_ENDED（'open'）= 持续性行程（无固定结束，
     * 出发后恒为进行中）。哨兵语义见本文件顶部常量注释；派生逻辑集中在 trip-logic。
     */
    end_date: string;
    note: string; // 兼容 v1 列，v2 语义并入 description
    description: string;
    icon: string | null; // emoji
    video_key: string | null; // file-storage key（封面视频）
    cover_key: string | null; // 兼容 v1 列（未使用）
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
}

export interface JournalRow {
    id: string;
    trip_id: string | null; // null = 日常日记
    local_date: string; // YYYY-MM-DD
    /** 笔记标题（v4，DEV.md #6）：可空，null = 未命名（列表回退到日期/预览）。 */
    title: string | null;
    blocks: string; // JSON: JournalBlock[]
    status: JournalStatus;
    word_count: number; // 冗余指标（me 页曲线），保存时同步
    created_at: number;
    updated_at: number;
    completed_at: number | null;
    deleted_at: number | null;
}

/** 媒体种类：kind 列为 TEXT，新增 'audio' 无需迁移（约束在应用层）。 */
export type JournalMediaKind = 'image' | 'video' | 'audio';

export interface JournalMediaRow {
    id: string;
    journal_id: string;
    file_key: string; // file-storage key
    kind: JournalMediaKind;
    width: number | null;
    height: number | null;
    created_at: number;
    deleted_at: number | null;
}

export interface DayPlanRow {
    id: string;
    trip_id: string;
    local_date: string; // YYYY-MM-DD
    content: string;
    sort_order: number;
    done: number; // 0 | 1
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
}

export const TRIPS_DDL = `CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    icon TEXT,
    video_key TEXT,
    cover_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
)`;

// 同日唯一约束不在建表 DDL 内（表达式索引建不进 CREATE TABLE），由迁移 v3 保证：
// idx_journals_trip_date_unique ON journals(COALESCE(trip_id, ''), local_date)
// WHERE deleted_at IS NULL——NULL trip_id 归一、软删行不占名额（详见 migrations.ts v3）。
export const JOURNALS_DDL = `CREATE TABLE IF NOT EXISTS journals (
    id TEXT PRIMARY KEY NOT NULL,
    trip_id TEXT,
    local_date TEXT NOT NULL,
    blocks TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open',
    word_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    deleted_at INTEGER
)`;

export const JOURNAL_MEDIA_DDL = `CREATE TABLE IF NOT EXISTS journal_media (
    id TEXT PRIMARY KEY NOT NULL,
    journal_id TEXT NOT NULL,
    file_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
)`;

/** 行程媒体与日记媒体同构：kind 域一致（图/视频/音频），新增种类无需迁移。 */
export type TripMediaKind = JournalMediaKind;

/**
 * 行程内媒体（v4，DEV.md #4）：行程独立成「容器」后，照片/视频/录音直接挂行程
 * （不经过日记块模型），列与 journal_media 对齐并补 duration_ms（音视频时长，
 * 日记侧该元数据在块 JSON 内，行程侧无块模型故落列）。
 * deleted_at 对齐「删除一律软删除」域约定（规范清单未列，属域内既有纪律的延续）。
 */
export interface TripMediaRow {
    id: string;
    trip_id: string;
    file_key: string; // file-storage key
    kind: TripMediaKind;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    created_at: number;
    deleted_at: number | null;
}

export const DAY_PLANS_DDL = `CREATE TABLE IF NOT EXISTS day_plans (
    id TEXT PRIMARY KEY NOT NULL,
    trip_id TEXT NOT NULL,
    local_date TEXT NOT NULL,
    content TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
)`;

export const TRIP_MEDIA_DDL = `CREATE TABLE IF NOT EXISTS trip_media (
    id TEXT PRIMARY KEY NOT NULL,
    trip_id TEXT NOT NULL,
    file_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
)`;

/**
 * 逐日元数据指针表（v5，行程逐日卡重构）：一行 = 行程某天的可变展示指针
 * （当前唯一键：日卡背景图）。
 *
 * 落位决策：背景图本体 = trip_media 的一行（复用行程媒体上传流：manipulator
 * 缩边 + file-storage 落盘 + 软删语义），本表只存「(trip_id, local_date) →
 * media_id」指针——相比给 trip_media 加 day_date/is_background 列：
 * ①媒体行完全复用既有上传/删除/行程级联/文件清理链路，不为单一视图特化列；
 * ②删除语义清晰：换背景 = 新行落库后指针切换 + 旧行软删（文件按「删除媒体」
 * 口径尽力清理），清除 = 摘指针 + 行软删；③指针天然一对一（主键约束），
 * 列方案需要部分唯一索引才能表达「一天至多一张背景」。
 *
 * 指针行不设 deleted_at（对「删除一律软删除」域约定的显式例外）：它不是内容
 * 行、自身无内容可回收——清除 = 直接删行；行程删除时随 softDeleteTripCascade
 * 硬删（其指向的媒体行走常规软删 + 文件清理）。悬挂指针（媒体行已被删）在
 * 读取侧 JOIN 不到行即按无背景降级，store.removeTripMedia 同步摘指针兜底。
 */
export interface TripDayMetaRow {
    trip_id: string;
    /** 本地日期 YYYY-MM-DD（与 day_plans / journals 同口径）。 */
    local_date: string;
    /** 日卡背景图 → trip_media.id；NULL = 未设置（该日渲染文字卡）。 */
    background_media_id: string | null;
    updated_at: number;
}

export const TRIP_DAY_META_DDL = `CREATE TABLE IF NOT EXISTS trip_day_meta (
    trip_id TEXT NOT NULL,
    local_date TEXT NOT NULL,
    background_media_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (trip_id, local_date)
)`;

// ─── events（v6：事件实体，类似工单）────────────────────────────────────────

/**
 * 事件状态：open = 进行中；done = 已完成；failed = 已失败（第四态：结局是
 * 没办成——与 done 同属终态，但语义是「结果」不是「归档」，UI 不按已完成降级）。
 * 与日记的 open/closed 无关：事件状态由用户手动切换（类似行程的进行/结束，
 * 但不按日期派生、不锁定内容）。
 * 约束在应用层（对齐 journals.status 风格，DDL 不加 CHECK）；判断一律走
 * event-logic 的派生函数，禁止散落字面量比较。
 */
export type EventStatus = 'open' | 'done' | 'failed';

/**
 * 事件对象（subject）类型词表：手机 / 邮箱 / 现实地址 / GPS 坐标；NULL = 未设置。
 * subject_kind 与 subject_value 是**原子对**：任一侧缺失即视为未设置
 * （归一化在 event-logic.normalizeEventSubject，写入口一律成对落库）。
 */
export type EventSubjectKind = 'custom' | 'phone' | 'email' | 'address' | 'gps';

/**
 * 事件行（v6）：独立、可重复新建的工单式条目。字段语义：
 * - description：可空短描述（用户手写的摘要行），正文细节在 blocks；
 * - blocks：正文块 JSON（JournalBlock[]，journal 同款块模型——文本段 + 行内
 *   媒体块，mediaId → event_media），复用 parse/serialize/摘要口径；
 * - gps_lat/gps_lng/gps_accuracy：完整经纬度（可空——定位失败/用户不填允许
 *   无 GPS；无地址列，地址语义走 subject 的 address/gps 词表）；
 * - handled_by：处理人自由文本（可空）；
 * - subject_kind/subject_value：对象类型与值（原子对，见上）。
 */
export interface EventRow {
    id: string;
    title: string;
    status: EventStatus;
    description: string | null;
    blocks: string; // JSON: JournalBlock[]
    gps_lat: number | null;
    gps_lng: number | null;
    gps_accuracy: number | null;
    handled_by: string | null;
    subject_kind: EventSubjectKind | null;
    subject_value: string | null;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
}

/** 媒体种类：kind 列为 TEXT，对齐 trip_media（图/视频/音频），新增种类无需迁移。 */
export type EventMediaKind = JournalMediaKind;

/**
 * 事件内媒体行（v6）：列与 trip_media 完全对齐（含 duration_ms 音视频时长列——
 * 事件媒体无「块级元数据即真身」的历史包袱，直接落列，行程侧口径）。
 * 落盘 key 约定 `event-media/<eventId>/<mediaId>.<ext>`（store 上传入口）。
 */
export interface EventMediaRow {
    id: string;
    event_id: string;
    file_key: string; // file-storage key
    kind: EventMediaKind;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    created_at: number;
    deleted_at: number | null;
}

export const EVENTS_DDL = `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    description TEXT,
    blocks TEXT NOT NULL DEFAULT '[]',
    gps_lat REAL,
    gps_lng REAL,
    gps_accuracy REAL,
    handled_by TEXT,
    subject_kind TEXT,
    subject_value TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
)`;

export const EVENT_MEDIA_DDL = `CREATE TABLE IF NOT EXISTS event_media (
    id TEXT PRIMARY KEY NOT NULL,
    event_id TEXT NOT NULL,
    file_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
)`;
