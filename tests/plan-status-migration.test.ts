import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
// schema.ts 运行时零依赖（纯 DDL 常量），node 可直接 import——迁移语句在这里
// 跑的是**注册表原文**（从 migrations.ts 抽取），不是测试内手抄的副本。
import { JOURNALS_DDL } from '../src/features/archive/db/schema.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsSource = readFileSync(
    path.join(repoRoot, 'src/features/archive/db/migrations.ts'),
    'utf8',
);

/** 取注册表里全部 version 数字（按出现顺序）。 */
function registeredVersions(): number[] {
    return [...migrationsSource.matchAll(/^\s+version:\s*(\d+),/gm)].map((m) => Number(m[1]));
}

/** 截取某个 version 对象的源码块（从 `version: N,` 到下一个 version 或表尾）。 */
function migrationBlock(version: number): string {
    const start = migrationsSource.search(new RegExp(`^\\s+version: ${version},`, 'm'));
    assert.notEqual(start, -1, `migration v${version} not registered`);
    const next = /\n\s+version: \d+,/.exec(migrationsSource.slice(start + 1));
    return next ? migrationsSource.slice(start, start + 1 + next.index) : migrationsSource.slice(start);
}

/**
 * 抽取某版本块内的模板/引号语句原文（归一空白便于执行与断言）。
 * 注册表现状：语句体内不含需转义的引号（kind/description ALTER 的 'daily'/''
 * 在双引号串内、CREATE/DROP INDEX 为反引号模板），简单三形态捕获即够用；
 * 真出现转义引号时本捕获会断在转义处——测试红字可见，届时收口迁移文本或
 * 换解析（宁可测试先叫，不让抽取静默吞语句）。
 */
function statementsOf(version: number): string[] {
    const block = migrationBlock(version);
    return [...block.matchAll(/`([^`]*)`|"([^"]*)"|'([^']*)'/g)]
        .map((m) => (m[1] ?? m[2] ?? m[3] ?? '').replace(/\s+/g, ' ').trim())
        .filter((s) => /^(ALTER|UPDATE|CREATE|DROP)/i.test(s));
}

test('migration registry is append-only and strictly increasing up to v11', () => {
    const versions = registeredVersions();
    assert.deepEqual(versions, [...Array(11).keys()].map((n) => n + 1));
    for (let i = 1; i < versions.length; i += 1) {
        assert.ok(versions[i] === versions[i - 1] + 1, 'registration order must not change');
    }
});

test('v11 registers exactly one data-normalizing UPDATE scoped to plan rows', () => {
    const statements = statementsOf(11);
    assert.equal(statements.length, 1, 'v11 must be zero-DDL: only the value-domain backfill');
    const [sql] = statements;
    assert.match(sql, /^UPDATE journals SET status = 'open'/);
    assert.match(sql, /kind = 'note'/);
    assert.match(sql, /status NOT IN \('open', 'closed', 'failed'\)/);
});

test('legacy upgrade path: existing note rows survive v8→v11, unknown plan status normalizes to open', () => {
    const db = new DatabaseSync(':memory:');
    try {
        // ① v2 建表形状 + 存量日记行（v8 之前表里只有 daily 语义的行）
        db.exec(JOURNALS_DDL);
        db.prepare(
            `INSERT INTO journals (id, trip_id, local_date, blocks, status, word_count, created_at, updated_at, completed_at)
             VALUES (?, NULL, '2026-11-01', '[]', 'open', 0, 1, 1, NULL)`,
        ).run('daily-old');
        db.prepare(
            `INSERT INTO journals (id, trip_id, local_date, blocks, status, word_count, created_at, updated_at, completed_at)
             VALUES (?, NULL, '2026-11-02', '[]', 'closed', 0, 1, 2, 2)`,
        ).run('daily-closed');

        // ② v4 的 title ALTER + v8 的两条 ALTER（注册表原文抽取）：存量行
        //    kind 自动落 'daily'、title 自动 NULL，无数据回填
        const journalAlters = [...statementsOf(4), ...statementsOf(8)].filter((s) =>
            /^ALTER TABLE journals ADD COLUMN/i.test(s),
        );
        assert.deepEqual(
            journalAlters.map((s) => (/kind/.test(s) ? 'kind' : /description/.test(s) ? 'description' : 'title')),
            ['title', 'kind', 'description'],
            'journals ALTER chain must stay title→kind→description',
        );
        for (const sql of journalAlters) db.exec(sql);

        // ③ v8~v10 期间的计划存量：createPlan 的 'open' 行、旧「完成计划」的
        //    'closed' 行，外加一行手改库/坏包混入的域外值 'archived'
        db.prepare(
            `INSERT INTO journals (id, trip_id, local_date, title, kind, description, blocks, status, word_count, created_at, updated_at)
             VALUES (?, NULL, '2026-11-03', '买机票', 'note', '', '[]', 'open', 0, 1, 1)`,
        ).run('plan-open');
        db.prepare(
            `INSERT INTO journals (id, trip_id, local_date, title, kind, description, blocks, status, word_count, created_at, updated_at, completed_at)
             VALUES (?, NULL, '2026-11-04', '办签证', 'note', '', '[]', 'closed', 0, 1, 2, 2)`,
        ).run('plan-done');
        db.prepare(
            `INSERT INTO journals (id, trip_id, local_date, title, kind, description, blocks, status, word_count, created_at, updated_at)
             VALUES (?, NULL, '2026-11-05', '坏值行', 'note', '', '[]', 'archived', 0, 1, 1)`,
        ).run('plan-dirty');

        // ④ v11 迁移（注册表原文）：只归位域外值，合法行一律原样保留
        const [v11] = statementsOf(11);
        db.exec(v11);
        db.exec(v11); // 幂等：重跑不改结果

        const rows = Object.fromEntries(
            (db
                .prepare('SELECT id, status FROM journals ORDER BY id')
                .all() as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]),
        );
        assert.deepEqual(rows, {
            'daily-closed': 'closed', // daily 行不进 WHERE——收笔语义不被触碰
            'daily-old': 'open',
            'plan-dirty': 'open', // 域外值归进行中（最保守档：内容仍可读可写）
            'plan-done': 'closed', // 旧「完成计划」读出为已完成，不回填不销毁
            'plan-open': 'open', // 存量 kind='note' 行默认视为进行中
        });

        // ⑤ 'failed' 新值走 TEXT 列零 DDL 往返（status 无 CHECK，应用层约束）
        db.prepare(
            `INSERT INTO journals (id, trip_id, local_date, title, kind, description, blocks, status, word_count, created_at, updated_at, completed_at)
             VALUES ('plan-failed', NULL, '2026-11-06', '修相机', 'note', '', '[]', 'failed', 0, 1, 3, 3)`,
        ).run();
        const failed = db
            .prepare("SELECT status, completed_at FROM journals WHERE id = 'plan-failed'")
            .get() as { status: string; completed_at: number };
        assert.equal(failed.status, 'failed');
        assert.equal(failed.completed_at, 3);
    } finally {
        db.close();
    }
});

test('backup round-trip: plan status (incl. failed) survives export→JSON→INSERT OR IGNORE restore', () => {
    const source = new DatabaseSync(':memory:');
    const target = new DatabaseSync(':memory:');
    try {
        source.exec(JOURNALS_DDL);
        // 同列链：v4 title → v8 kind/description（注册表原文，非手抄副本）
        for (const sql of [...statementsOf(4), ...statementsOf(8)].filter((s) =>
            /^ALTER TABLE journals ADD COLUMN/i.test(s),
        )) {
            source.exec(sql);
        }
        for (const status of ['open', 'closed', 'failed']) {
            source.prepare(
                `INSERT INTO journals (id, trip_id, local_date, title, kind, description, blocks, status, word_count, created_at, updated_at, completed_at)
                 VALUES (?, NULL, '2026-11-06', ?, 'note', '描述', '[]', ?, 1, 1, 2, ?)`,
            ).run(`plan-${status}`, `计划-${status}`, status, status === 'open' ? null : 2);
        }

        // 导出 = 库存原样字节（restoreBackupData 语义：同列 INSERT OR IGNORE）
        const exported = JSON.parse(
            JSON.stringify(
                source
                    .prepare(
                        'SELECT id, trip_id, local_date, title, kind, description, blocks, status, word_count, created_at, updated_at, completed_at FROM journals',
                    )
                    .all(),
            ),
        ) as Array<Record<string, unknown>>;
        assert.equal(exported.length, 3);

        target.exec(JOURNALS_DDL);
        for (const sql of [...statementsOf(4), ...statementsOf(8)].filter((s) =>
            /^ALTER TABLE journals ADD COLUMN/i.test(s),
        )) {
            target.exec(sql);
        }
        for (const row of exported) {
            target
                .prepare(
                    `INSERT OR IGNORE INTO journals (id, trip_id, local_date, title, kind, description, blocks, status, word_count, created_at, updated_at, completed_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
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
                );
        }
        // node:sqlite 行对象是 null-prototype（deepEqual 严格比原型）——展开成
        // 普通对象再断言，断言内容不变
        const restored = (
            target
                .prepare('SELECT id, kind, status FROM journals ORDER BY id')
                .all() as Array<{ id: string; kind: string; status: string }>
        ).map((row) => ({ ...row }));
        assert.deepEqual(restored, [
            { id: 'plan-closed', kind: 'note', status: 'closed' },
            { id: 'plan-failed', kind: 'note', status: 'failed' },
            { id: 'plan-open', kind: 'note', status: 'open' },
        ]);
    } finally {
        source.close();
        target.close();
    }
});
