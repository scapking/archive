import type { SchemaMigration } from '@/core/database';
import {
    DAY_PLANS_DDL,
    EVENTS_DDL,
    EVENT_MEDIA_DDL,
    JOURNALS_DDL,
    JOURNAL_MEDIA_DDL,
    TRIP_DAY_META_DDL,
    TRIP_MEDIA_DDL,
    TRIPS_DDL,
} from './schema';

/**
 * archive 域迁移注册表（R9）：version 递增且只追加，历史迁移发布后禁改。
 * 迁移在事务内执行并由 core/database 记账（PRAGMA user_version）。
 */
export const ARCHIVE_MIGRATIONS: SchemaMigration[] = [
    {
        version: 1,
        statements: [
            // v1（碎片流形态）：已被 v2 取代；保留注册保证从 v1 升级的库 user_version 可推进
            `CREATE TABLE IF NOT EXISTS trips (
                id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL,
                start_date TEXT NOT NULL, end_date TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '', cover_key TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
            )`,
            `CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY NOT NULL, trip_id TEXT, local_date TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '', mood TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
            )`,
            `CREATE TABLE IF NOT EXISTS photos (
                id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL, file_key TEXT NOT NULL,
                width INTEGER NOT NULL, height INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, deleted_at INTEGER
            )`,
            DAY_PLANS_DDL,
            'CREATE INDEX IF NOT EXISTS idx_entries_local_date ON entries(local_date)',
            'CREATE INDEX IF NOT EXISTS idx_day_plans_trip_date ON day_plans(trip_id, local_date)',
        ],
    },
    {
        version: 2,
        statements: [
            // v2（商业版连续容器）：v1 碎片流为灰度前形态，无生产数据，直接重置
            'DROP TABLE IF EXISTS photos',
            'DROP TABLE IF EXISTS entries',
            'DROP TABLE IF EXISTS trips',
            TRIPS_DDL,
            JOURNALS_DDL,
            JOURNAL_MEDIA_DDL,
            'CREATE INDEX IF NOT EXISTS idx_journals_local_date ON journals(local_date)',
            'CREATE INDEX IF NOT EXISTS idx_journals_trip_id ON journals(trip_id)',
            'CREATE INDEX IF NOT EXISTS idx_journal_media_journal ON journal_media(journal_id)',
            'CREATE INDEX IF NOT EXISTS idx_day_plans_trip_date_v2 ON day_plans(trip_id, local_date)',
        ],
    },
    {
        version: 3,
        statements: [
            // v3：journals 同日唯一（修复 ensureJournal get-then-insert 并发竞态产生同日重复日记）。
            // 表达式 COALESCE(trip_id, '')：SQLite UNIQUE 将 NULL 视为互不相等，不归一的话
            // （NULL, local_date）的日常日记拦不住；部分索引 WHERE deleted_at IS NULL：
            // 软删行不占唯一名额（对齐「删除一律软删除」的域约定）。
            // 升级前先清史：对升级时已存在的同日重复行，保留最早一条（created_at、rowid 升序），
            // 其余软删（数据不销毁）——否则存量重复会让 CREATE UNIQUE INDEX 直接失败、库打不开。
            `UPDATE journals SET deleted_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
             WHERE deleted_at IS NULL
               AND EXISTS (
                   SELECT 1 FROM journals AS keeper
                   WHERE COALESCE(keeper.trip_id, '') = COALESCE(journals.trip_id, '')
                     AND keeper.local_date = journals.local_date
                     AND keeper.deleted_at IS NULL
                     AND (keeper.created_at < journals.created_at
                          OR (keeper.created_at = journals.created_at AND keeper.rowid < journals.rowid))
               )`,
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_journals_trip_date_unique
             ON journals(COALESCE(trip_id, ''), local_date) WHERE deleted_at IS NULL`,
        ],
    },
    {
        version: 4,
        statements: [
            // v4（DEV.md #4/#6/#7）：
            // ① journals.title 笔记标题：可空（NULL = 未命名），存量行 ALTER 后自动为 NULL，
            //    无需回填；列表/搜索侧对 NULL 回退到日期与正文预览（UI 层决策）。
            'ALTER TABLE journals ADD COLUMN title TEXT',
            // ② trip_media 行程内媒体：行程独立容器化后，图/视频/录音直接挂行程。
            //    deleted_at 列对齐域约定「删除一律软删除」（软删行不参与任何查询）。
            TRIP_MEDIA_DDL,
            'CREATE INDEX IF NOT EXISTS idx_trip_media_trip ON trip_media(trip_id)',
            // ③ trips 持续性（end_date 语义扩展为 TRIP_OPEN_ENDED 哨兵）：零 DDL——
            //    end_date 列保持 TEXT NOT NULL，SQLite ALTER 无法去除 NOT NULL 约束，
            //    重建表（copy+drop+rename）违背最小迁移且对存量数据高风险；
            //    'open' 哨兵自解释、不会与漏填的空串混淆，且存量 end_date 均为真实
            //    日期无需迁移。语义与派生逻辑集中在 schema.ts / trip-logic.ts。
        ],
    },
    {
        version: 5,
        statements: [
            // v5（行程逐日卡重构）：日卡背景指针表。背景图本体 = trip_media 的一行
            // （复用行程媒体上传流与软删/文件清理链路），本表只存
            // (trip_id, local_date) → background_media_id 指针；复合主键即
            // 「一天至多一张背景」的唯一约束，同时是按行程取全部逐日指针的前缀索引，
            // 无需额外二级索引。指针行无内容、清除 = 删行，故不设 deleted_at
            // （对域约定的显式例外，决策与删除链路见 schema.ts 注释）。
            TRIP_DAY_META_DDL,
        ],
    },
    {
        version: 6,
        statements: [
            // v6（事件实体，类似工单）：独立可重复新建的业务条目（时间线 + 名字 +
            // GPS + 短描述 + 块正文 + 状态 + 处理人 + 对象）。blocks 复用 journal
            // 块 JSON 语义（媒体引用挂 event_media），event_media 列与 trip_media
            // 对齐（含 duration_ms），复用既有落盘/软删/级联/文件清理链路。
            // 纯新增两张表 + 两个索引，不动历史表（append-only，无数据回填）。
            EVENTS_DDL,
            EVENT_MEDIA_DDL,
            // 列表按状态筛选（进行中/已完成）与按事件取媒体的常规路径
            'CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)',
            'CREATE INDEX IF NOT EXISTS idx_event_media_event ON event_media(event_id)',
        ],
    },
    {
        version: 7,
        statements: [
            // v7（事件联系方式，用户反馈「新建事件增加手机号以及邮箱」）：events
            // 追加两个可选文本列 phone / email——独立于 subject 对象词表（对象 =
            // 跟谁有关的一句话；手机号/邮箱 = 可直接触达的联系方式，各自成列利
            // 检索与展示）。可空、无默认值：存量行 ALTER 后自动 NULL（未填），
            // 无需数据回填；LIKE 搜索通道在 db.searchEvents 同步扩充（联系方式
            // 可被搜索，工单语义自然）。schema.ts 的 EVENTS_DDL 保持 v6 建表形状
            // 不动（journals.title 同款先例：全新装 v6 建表后再跑本迁移 ALTER，
            // DDL 若带新列会 duplicate column 崩迁移链）。append-only，不改历史。
            'ALTER TABLE events ADD COLUMN phone TEXT',
            'ALTER TABLE events ADD COLUMN email TEXT',
        ],
    },
];
