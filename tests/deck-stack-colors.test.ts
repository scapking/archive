import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 堆叠 deck 颜色语言把关（v0.4.5）：层次 = theme.ts 同族实色色阶，不是透明度
 * 渐隐（v0.4.3 的 0.45 洗白）也不是描边环+高透明（v0.4.4 否案）。断言的是
 * 需求侧的视觉不变量（露条可读、光源方向一致、白字达标、hex 不落地散写），
 * 预期来自设计口径而非复制实现。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeSource = await readFile(path.join(repoRoot, 'src/features/archive/ui/theme.ts'), 'utf8');
const deckSource = await readFile(path.join(repoRoot, 'src/features/archive/ui/deck.tsx'), 'utf8');
const tripSource = await readFile(path.join(repoRoot, 'src/features/archive/trip-day-screen.tsx'), 'utf8');

/** 堆叠色阶 token（Palette 新字段，LIGHT/DARK 两块都必须齐）。 */
const DECK_TOKENS = [
    'deckEdge',
    'ongoingFrom',
    'ongoingTo',
    'pendingFrom',
    'pendingTo',
    'settledFrom',
    'settledTo',
] as const;

function block(theme: 'LIGHT' | 'DARK'): string {
    return themeSource.split(`const ${theme}: Palette = {`)[1]?.split('\n};')[0] ?? '';
}

function token(name: string, theme: 'LIGHT' | 'DARK'): string {
    const match = block(theme).match(new RegExp(`${name}: '#([0-9A-Fa-f]{6})'`));
    assert.ok(match, `token ${name} missing in ${theme} — deck 色阶不许缺档`);
    return match[1];
}

function luminance(hex: string): number {
    const channels = [0, 2, 4].map((offset) => {
        const raw = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
}

test('deck 色阶 token 双主题齐档', () => {
    for (const theme of ['LIGHT', 'DARK'] as const) {
        for (const name of DECK_TOKENS) token(name, theme);
    }
});

test('背卡露条（deckEdge）在两主题下都与页面底色/前卡底色拉开实色档次', () => {
    for (const theme of ['LIGHT', 'DARK'] as const) {
        const edge = token('deckEdge', theme);
        const page = token('sceneBg', theme);
        const surface = token('surface', theme);
        // 露条 vs 页面：不洗白（v0.4.3 病灶）——≥1.30 才有清晰纸边
        assert.ok(
            contrast(edge, page) >= 1.3,
            `${theme} deckEdge vs page ${contrast(edge, page).toFixed(3)} < 1.3 — 露条会融进页面`,
        );
        // 露条 vs 前卡纸面：层次不被同化
        assert.ok(
            contrast(edge, surface) >= 1.2,
            `${theme} deckEdge vs surface ${contrast(edge, surface).toFixed(3)} < 1.2 — 堆叠无层次`,
        );
    }
});

test('露条色落在 ink 家族色阶内（浅色沉于 border，深色亮于 border，不成孤岛色）', () => {
    // 浅色：deckEdge 必须比 border 更深（shadow 方向），且不越过 text 一档；
    // 深色：镜像——比 border 更亮（受光纸边）。两主题都仍与 surface 相邻一档。
    const light = ['deckEdge', 'border', 'surface', 'sceneBg'].map((t) => luminance(token(t, 'LIGHT')));
    assert.ok(
        light.every((v, i) => i === 0 || v > light[i - 1]),
        'LIGHT 亮度阶梯必须 base > surface > border > deckEdge',
    );
    const dark = ['deckEdge', 'border', 'surface', 'sceneBg'].map((t) => luminance(token(t, 'DARK')));
    assert.ok(
        dark.every((v, i) => i === 0 || v < dark[i - 1]),
        'DARK 亮度阶梯必须 deckEdge > border > surface > base（同族镜像）',
    );
});

test('卡面三态渐变同族同向：每主题内 from 恒亮于 to（左上受光、右下沉的单一光源）', () => {
    for (const theme of ['LIGHT', 'DARK'] as const) {
        for (const pair of ['ongoing', 'pending', 'settled'] as const) {
            const from = luminance(token(`${pair}From`, theme));
            const to = luminance(token(`${pair}To`, theme));
            assert.ok(
                from > to,
                `${theme} ${pair} 渐变必须从亮到暗（光源方向一致），got ${from.toFixed(3)} -> ${to.toFixed(3)}`,
            );
        }
    }
});

test('当前项深蓝渐变：白字在亮端达标 AA，且渐变有真实纵深（不是近似平色）', () => {
    for (const theme of ['LIGHT', 'DARK'] as const) {
        const from = token('ongoingFrom', theme);
        const to = token('ongoingTo', theme);
        assert.ok(
            contrast(from, 'FFFFFF') >= 4.5,
            `${theme} ongoingFrom 上纯白标题对比 ${contrast(from, 'FFFFFF').toFixed(2)} < 4.5`,
        );
        assert.ok(
            luminance(from) / luminance(to) >= 2,
            `${theme} ongoing 渐变纵深不足（亮/暗亮度比 < 2）`,
        );
    }
});

test('已完成卡沉入堆叠：settled 渐变的暗端（浅色）或亮端（深色）与 deckEdge 同值收口', () => {
    // 需求：整套 deck 的「沉底色」只有一个——完成的卡与背卡露条同族到同值。
    // 浅色向暗走（…→deckEdge），深色向亮起（deckEdge→…），两主题各取一端。
    for (const theme of ['LIGHT', 'DARK'] as const) {
        const edge = token('deckEdge', theme);
        const ends = [token('settledFrom', theme), token('settledTo', theme)];
        assert.ok(
            ends.includes(edge),
            `${theme} settled 渐变端点不含 deckEdge——完成卡与堆叠露条不成同一次第`,
        );
    }
});

test('deck 壳面走 palette 实色色阶，动画图不再用透明度做可见层分层', () => {
    // 可见层透明度恒 1、隐藏层位淡出：语言从「渐隐」翻转为「实色色阶」。
    // 只截取 opacity 插值表达式本体断言（注释里允许引用废案数值作史料）
    const opacityExpr = deckSource.split('opacity: values.depth.interpolate')[1]?.split('})')[0] ?? '';
    assert.ok(opacityExpr.length > 0, 'opacity 插值结构变了，测试口径需同步');
    assert.match(opacityExpr, /outputRange: \[1, 1, 0\]/);
    assert.ok(!opacityExpr.includes('0.45'), 'v0.4.3 渐隐下限回潮');
    assert.ok(!opacityExpr.includes('0.92'), 'v0.4.4 透明度顶替方案回潮');
    // 壳面色从 palette 取（背卡 deckEdge），不再用 className 双色壳
    assert.match(deckSource, /palette\.deckEdge/);
    assert.ok(!deckSource.includes('bg-ink-surface dark:bg-inkd-surface'), '壳面底色必须走 inline palette');
});

test('trip 卡面零散落 hex：三态渐变端点全部来自 palette', () => {
    assert.ok(
        !/["']#[0-9A-Fa-f]{3,8}["']/.test(tripSource),
        'trip-day-screen 出现硬编码 hex 字面量（色值必须收进 theme.ts）',
    );
    assert.match(tripSource, /\[string, string\][^\n]*=\s*isCurrent/);
    for (const name of DECK_TOKENS.filter((t) => t !== 'deckEdge')) {
        assert.ok(tripSource.includes(`palette.${name}`), `三态渐变未引用 palette.${name}`);
    }
});
