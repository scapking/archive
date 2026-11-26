import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * v0.5.2 轮 B 源码头闸（用户令 2/5/8：顶部导航栏统一 + 介绍文案退场 +
 * 极简收拢）——纯源码正则闸，不渲染不跑 Metro：
 *
 * 1. 本组所辖屏文件不得再出现「返回钮侧手写屏题带」（ml-2.5 + 22~26px +
 *    semibold 的内联标题，即 ScreenHeader 展开态的签名类串）；
 * 2. ScreenHeader 调用不得再传 subtitle，且 ui/screen-header.tsx 自身不再
 *    定义 subtitle prop（副标通道整体退役，防复活）；
 * 3. 原内联屏头的屏（plan-form / library / event-detail / me）必须走
 *    ScreenHeader（迁移的正向断言）;
 * 4. 每屏 primary 按钮（palette.primaryBtn / PrimaryButton）≤1；
 * 5. 本轮删除的介绍/口号句原文不得回流。
 *
 * 文件清单口径：A/C 独占的 trip-day-screen / trip-detail-screen /
 * journal-edit-screen / alarm-fullscreen-screen 不在闸内（它们的内联屏头
 * 差量已移交并写入 v0.5.2 交付报告，落闸会撞并行改动）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');

/** 本组（轮 B）所有的屏文件（相对 src/）。 */
const OWNED_SCREENS = [
    'features/archive/archive-screen.tsx',
    'features/archive/app-lock.tsx',
    'features/archive/event-detail-screen.tsx',
    'features/archive/event-form-screen.tsx',
    'features/archive/events-screen.tsx',
    'features/archive/library-screen.tsx',
    'features/archive/me-screen.tsx',
    'features/archive/plan-form-screen.tsx',
    'features/archive/recording-session.tsx',
    'features/archive/search-results-screen.tsx',
    'features/archive/search-screen.tsx',
    'features/archive/settings-screen.tsx',
    'features/archive/trip-form-screen.tsx',
];

/** primary 按钮 ≤1 的写死豁免清单：当前为空——如需豁免必须在此列名并在
 *  交付报告说明（同「例外要写死例外清单」要求）。 */
const PRIMARY_BUTTON_EXEMPTIONS: string[] = [];

/** v0.5.2 轮 B 删除的介绍/口号文案（rel → 原文子串，均不得回流）。
 *  注意：断言串避开各文件退役注释里的转述写法，只锁原文。 */
const RETIRED_COPY: Array<[string, string[]]> = [
    ['features/archive/plan-form-screen.tsx', ['起个名字、补句描述', '描述可以留空，进计划页后随时补']],
    ['features/archive/library-screen.tsx', ['计划是一件要做的事', '旅途从一段日期开始']],
    ['features/archive/search-results-screen.tsx', ['不限关键词、时间与状态', '· 全状态可见']],
    ['features/archive/archive-screen.tsx', ['今天的记录都在这里', '明天会翻开新的一页']],
    ['features/archive/me-screen.tsx', ['别断', '从今天开始连续记录']],
    ['features/archive/search-screen.tsx', ['键盘「搜索」查当前条件，点日历某天看那天']],
];

async function readSrc(rel: string): Promise<string> {
    return readFile(path.join(srcRoot, rel), 'utf8');
}

/** ScreenHeader 展开态手写屏题的签名：返回钮右邻（ml-2.5）+ 22~26px +
 *  semibold，同一 className 字符串内（ui/screen-header.tsx 本体除外——
 *  清单不含它）。 */
const INLINE_BAND_TITLE = /ml-2\.5[^"]*text-\[2[2-6]px\][^"]*font-semibold/;

test('v0.5.2 屏头统一：本组屏文件无内联手写屏题带', async () => {
    for (const rel of OWNED_SCREENS) {
        const source = await readSrc(rel);
        assert.ok(!INLINE_BAND_TITLE.test(source), `${rel}: 仍存在 ml-2.5 + 22-26px 内联屏题带，应迁 ScreenHeader`);
    }
});

test('v0.5.2 屏头统一：ScreenHeader 调用零 subtitle，组件不再定义 subtitle prop', async () => {
    const headerSource = await readSrc('features/archive/ui/screen-header.tsx');
    // prop 定义面：`subtitle?: string` / `subtitle: string` 之类一律不得存在
    assert.ok(!/subtitle\??\s*:/.test(headerSource), 'screen-header.tsx 仍定义 subtitle prop');

    for (const rel of OWNED_SCREENS) {
        const source = await readSrc(rel);
        for (const match of source.matchAll(/<ScreenHeader\b/g)) {
            const callWindow = source.slice(match.index ?? 0, (match.index ?? 0) + 600);
            assert.ok(!/\bsubtitle\s*=/.test(callWindow), `${rel}: ScreenHeader 调用传入 subtitle（副标已退役）`);
        }
    }
});

test('v0.5.2 屏头统一：原内联屏头的屏已收口 ScreenHeader', async () => {
    for (const rel of [
        'features/archive/plan-form-screen.tsx',
        'features/archive/library-screen.tsx',
        'features/archive/event-detail-screen.tsx',
        'features/archive/me-screen.tsx',
    ]) {
        const source = await readSrc(rel);
        assert.ok(source.includes('<ScreenHeader'), `${rel}: 未使用 ScreenHeader`);
    }
});

test('v0.5.2 极简收拢：每屏 primary 按钮 ≤1', async () => {
    for (const rel of OWNED_SCREENS) {
        if (PRIMARY_BUTTON_EXEMPTIONS.includes(rel)) continue;
        const source = await readSrc(rel);
        const count =
            (source.match(/palette\.primaryBtn\b/g) ?? []).length +
            (source.match(/<PrimaryButton\b/g) ?? []).length;
        assert.ok(count <= 1, `${rel}: primary 按钮样式 ${count} 处（>1），违反「同屏至多一个主行动」`);
    }
});

test('v0.5.2 介绍文案退场：已删口号/指引句不回流', async () => {
    for (const [rel, phrases] of RETIRED_COPY) {
        const source = await readSrc(rel);
        for (const phrase of phrases) {
            assert.ok(!source.includes(phrase), `${rel}: 退役介绍句回流「${phrase}」`);
        }
    }
});
