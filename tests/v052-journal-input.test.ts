import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    PREFETCH_LOOKAHEAD,
    PREFETCH_SET_MAX,
    deckItemsEqual,
    nextPrefetchWindow,
    prefetchRestartLine,
} from '../src/features/archive/ui/deck-prefetch.ts';

/**
 * v0.5.2 令 6 把关（用户原话两条）：
 * A. 「每次换行都会导致上面的字会刷新一下或者往前面闪烁一下」——换行提交
 *    （200ms 防抖拍）后，非聚焦文本行必须零重渲、TextInput 值必须相等短路、
 *    native 击键必须零 setState / 零高度 JS 回环；React key 禁止掺入内容或
 *    序号（换行/重排换 key = 整块 remount = 光标与文本闪回）。
 * B. 「图片以及视频堆叠，每次切换都会刷新一下。改成预先加载但是有上限，
 *    到上限后不再预载，但切换超过 50% 后重新预载」——预载窗口常数在案、
 *    50% 重启是纯函数（本文件直接单测边界）、native 有同步 URI memo（换张
 *    首帧不再 loading 占位）、deck 相等器断掉文字提交对堆叠的重渲。
 *
 * 结构断言口径与 editor-input.test.ts 一致：预期来自指令，不复制实现细节；
 * 纯函数断言覆盖边界（total=1/2、恰好过半、回退不过半、上限停载）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const editorSource = await readFile(
    path.join(repoRoot, 'src/features/archive/ui/editor.tsx'),
    'utf8',
);
const useFileUrlSource = await readFile(
    path.join(repoRoot, 'src/features/archive/ui/use-file-url.ts'),
    'utf8',
);
const screenSource = await readFile(
    path.join(repoRoot, 'src/features/archive/journal-edit-screen.tsx'),
    'utf8',
);
const journalLogicSource = await readFile(
    path.join(repoRoot, 'src/features/archive/journal-logic.ts'),
    'utf8',
);

/** TextBlock 函数体（自声明起截到 TextBlockRow 前，与旧口径同源）。 */
const textBlockSrc = (() => {
    const start = editorSource.indexOf('function TextBlock({');
    assert.ok(start > 0, 'TextBlock 结构变了，测试口径需同步');
    const end = editorSource.indexOf('const TextBlockRow = memo(', start);
    assert.ok(end > start, 'TextBlockRow 结构变了，测试口径需同步');
    return editorSource.slice(start, end);
})();

/* ────────────────────────── A. 换行闪烁 ────────────────────────── */

test('A0 块 id 生成与内容无关（journal-logic 事实源：随机 UUID，禁内容哈希/序号）', () => {
    const idSrc = journalLogicSource.split('export function newBlockId')[1]?.split('\n}')[0] ?? '';
    assert.ok(idSrc.length > 0, 'newBlockId 结构变了，测试口径需同步');
    assert.match(idSrc, /randomUUID|random/);
    assert.ok(!/text|hash|indexOf\('\\\\n'\)|split/.test(idSrc), '块 id 掺入内容 = 换行换 id 换 key 的病灶');
});

test('A1 React key 白名单：editor.tsx 的 key 只能是稳定 id，禁止内容/序号入 key', () => {
    const keys = [...editorSource.matchAll(/key=\{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(keys.length >= 10, `key 提取异常（${keys.length} 个）——口径需同步`);
    const allowed = /^(\s*)(block\.id|unit\.items\[0\]\.block\.id|frontItem\.media\.id|leftItem\.media\.id|rightItem\.media\.id|media\.id)(\s*)$/;
    for (const key of keys) {
        assert.match(
            key,
            allowed,
            `key={${key}} 不是稳定块/媒体 id——含内容或序号的 key 在换行/重排时换实例，「上面的字闪回」的病灶之一`,
        );
    }
});

test('A2 行级 memo：非聚焦文本行经 TextBlockRow 浅比较短路（上方文本零重渲）', () => {
    assert.match(editorSource, /const TextBlockRow = memo\(/);
    // BlockEditor 只下传原始值 + 恒定回调（memo 契约的调用侧）
    assert.match(editorSource, /focused=\{activeBlockId === block\.id\}/);
    assert.match(editorSource, /value=\{block\.text\}/);
    // 稳定通道：updateText 经 ref 中转、操作卡入口 useCallback([])——行回调
    // 引用不随渲染换代（inline 箭头会击穿每一行 memo）
    assert.match(editorSource, /const handleCommitText = useCallback\([\s\S]*?\[\],?\s*\);/);
    assert.match(editorSource, /const openActionBlock = useCallback\([\s\S]*?\[\],?\s*\);/);
    assert.match(editorSource, /updateTextRef\.current = updateText;/);
});

test('A3 防抖写回不在输入事件里同步 setBlocks 全量（native 击键零 setState）', () => {
    const changeSrc = textBlockSrc.split('onChangeText={(text) => {')[1] ?? '';
    assert.ok(changeSrc.length > 0, 'onChangeText 结构变了，测试口径需同步');
    const body = changeSrc.split('\n            }}')[0];
    // 提交只排防抖拍；禁止直接上抛/直写屏层
    assert.ok(body.includes('scheduleCommit();'), 'onChangeText 必须走防抖提交');
    assert.ok(!/onChange\(/.test(body), '输入事件里同步上抛 = 每键全画布重渲回潮');
    assert.ok(!/applyBlocks/.test(body), '输入事件里直写屏层块表回潮');
    // native：草稿只进 draftRef（提交事实源），setState 仅 web——native 每键
    // 一次重渲 = TextInput 重提交 + 旧值闪烁的直接病灶
    assert.match(body, /draftRef\.current = text;/);
    assert.match(body, /if \(Platform\.OS === 'web'\) setDraft\(text\);/);
    assert.match(textBlockSrc, /if \(Platform\.OS === 'web'\) draftRef\.current = draft;/);
});

test('A4 值相等短路：采纳闸保持「未编辑 + 异值才灌」，native 高度零 JS 回环', () => {
    // 采纳条件仍是 shouldAdoptExternalText（focused/pendingCommit/等值三闸）
    assert.match(textBlockSrc, /shouldAdoptExternalText\(\{/);
    assert.match(textBlockSrc, /committedRef\.current = value;\s*\n\s*setDraft\(value\);/);
    // web 受控 value=draft：React/RNW 对同值 textarea 写入天然跳过（HTML
    // value setter 同串早退），此处闸的是 native——固定 height 的 setState
    // 回环必须收窄到 web，native 走 minHeight 原生自长
    assert.match(
        textBlockSrc,
        /if \(Platform\.OS === 'web'\) \{\s*\n\s*setContentHeight\(/,
        'native 的 contentHeight setState 回潮：换行后「旧盒裁切一帧 → 扩容一帧」闪动的病灶',
    );
    assert.match(textBlockSrc, /Platform\.OS === 'web' \? \{ height \} : \{ minHeight: height \}/);
    // selection prop 绝不进 TextInput（受控 selection 每帧重写 = 光标扰动面）
    assert.ok(
        !/selection=\{/.test(textBlockSrc),
        'TextBlock 里出现 selection prop——光标被每帧重置的入口',
    );
});

/* ────────────────────────── B. 堆叠有界预载 ────────────────────────── */

test('B1 预载窗口常数在案（改常数必须连带改本闸与调度注释）', () => {
    assert.equal(PREFETCH_LOOKAHEAD, 3, '前瞻窗口深度口径：覆盖连滑 2~3 张短爆发');
    assert.equal(PREFETCH_SET_MAX, 6, '已预载集合上限 = 2×窗口（撑到过半重启线）');
    assert.match(editorSource, /PREFETCH_SET_MAX/);
    assert.match(editorSource, /nextPrefetchWindow\(/);
});

test('B2 50% 重启线：ceil(total/2)，恰好过半触发、回退不过半不触发', () => {
    assert.equal(prefetchRestartLine(9), 5);
    assert.equal(prefetchRestartLine(10), 5);
    assert.equal(prefetchRestartLine(1), 1);
    // total=1 无堆叠语义：空窗口（函数早退，与重启线解耦）
    assert.deepEqual(nextPrefetchWindow(0, 1, []), { cleared: false, indices: [] });
    // total=10：index=4 不过半（含回退到 4 也不算）
    const before = nextPrefetchWindow(4, 10, [0, 1, 2, 3, 4]);
    assert.equal(before.cleared, false);
    // index=5 恰好过半 → 重启清账，以新位为窗口起点
    const atHalf = nextPrefetchWindow(5, 10, [0, 1, 2, 3, 4, 5]);
    assert.equal(atHalf.cleared, true);
    assert.deepEqual(atHalf.indices, [5, 6, 7, 8]);
    // 重启后回退不过半（5→3）：集合已清账重记 [3]，无二次 cleared 语义依赖
    const back = nextPrefetchWindow(3, 10, [3]);
    assert.equal(back.cleared, false);
});

test('B3 前瞻窗口 + 集合上限：往后 3 张、已热去重、到上限停载', () => {
    const first = nextPrefetchWindow(0, 6, []);
    assert.equal(first.cleared, false);
    assert.deepEqual(first.indices, [0, 1, 2, 3]);
    // 重复拍幂等（已热位置全部去重）
    assert.deepEqual(nextPrefetchWindow(0, 6, [0, 1, 2, 3]).indices, []);
    // 集合到 MAX=6：预算耗尽 → 停载（total=20 时不会到半程线，验证纯停载）
    const full = nextPrefetchWindow(3, 20, [0, 1, 2, 3, 4, 5]);
    assert.equal(full.cleared, false);
    assert.deepEqual(full.indices, []);
    // total=2 退化：0 位窗口 = 当前位 + 另一张；1 位过半 → 清账重启
    assert.deepEqual(nextPrefetchWindow(0, 2, []).indices, [0, 1]);
    const two = nextPrefetchWindow(1, 2, [0, 1]);
    assert.equal(two.cleared, true);
    assert.deepEqual(two.indices, [1, 0]);
    // 越界索引钳制（并发收缩组的防御）
    assert.deepEqual(nextPrefetchWindow(-3, 6, []).indices, [0, 1, 2, 3]);
    const over = nextPrefetchWindow(99, 6, []);
    assert.equal(over.cleared, true);
});

test('B4 deck 相等器：引用浅比较锁步 buildRenderUnits 的纯派生语义', () => {
    const blockA = { t: 'p', id: 'a', text: 'x' };
    const mediaA = { id: 'm1' };
    const items = [{ block: blockA, media: mediaA, index: 0, deckKind: 'image' }];
    assert.equal(deckItemsEqual(items, items), true);
    assert.equal(deckItemsEqual(items, items.slice()), true, '同引用新数组必须相等（每拍重建的 items 外壳）');
    assert.equal(
        deckItemsEqual(items, [{ block: blockA, media: { id: 'm1' }, index: 0, deckKind: 'image' }]),
        false,
        'media 对象引用换代必须判不等（revision 重载后的新行对象）',
    );
    assert.equal(deckItemsEqual(items, []), false);
});

test('B5 native 换张零占位帧：useFileUrlState 的同步 peek 有 native URI memo + 乐观 revision 读', () => {
    // native：key→file:// 路径 memo（上限 FIFO），首渲染同步 ready——旧版
    // native 无缓存、换张重挂恒 await fileStorage.url = loading 占位闪烁
    assert.match(useFileUrlSource, /const nativeUriMemo = new Map<string, string>\(\);/);
    assert.match(useFileUrlSource, /if \(!WEB\) return nativeUriMemo\.get\(key\) \?\? null;/);
    assert.match(useFileUrlSource, /nativeUriMemo\.set\(key, uri\);/);
    // web：peek 不再要求 revision 全等（打字自动保存 bump revision 后第一次
    // 切堆叠不再集体 miss → LOADING 一帧）；失效/撤销态仍拒发
    assert.match(useFileUrlSource, /if \(!entry \|\| entry\.invalidated\) \{/);
    assert.ok(
        !/entry\.revision !== revision/.test(useFileUrlSource.split('function peekCachedUrl')[1]?.split('\n}')[0] ?? ''),
        'peek 回潮 revision 全等闸：revision bump 后换张首帧占位闪烁复发',
    );
});

test('B6 预载执行面分平台：native expo-image prefetch / web blob+隐藏 video；渲染缓存同栈', () => {
    assert.match(useFileUrlSource, /export function prefetchDeckMedia\(/);
    assert.match(useFileUrlSource, /import \{ Image as ExpoImage \} from 'expo-image';/);
    assert.match(useFileUrlSource, /ExpoImage\.prefetch/);
    assert.match(useFileUrlSource, /function warmVideoBytesWeb\(uri: string\)/);
    assert.match(useFileUrlSource, /video\.preload = 'auto';/);
    // deck 卡体与预取共用 expo-image 缓存栈（RN Image 打不进 expo-image prefetch）
    const deckCards = editorSource.slice(
        editorSource.indexOf('function DeckFrontCardImpl'),
        editorSource.indexOf('function DeckAudioFrontCardImpl'),
    );
    assert.ok(!/<Image\b/.test(deckCards), 'deck 卡体仍有 RN <Image>——prefetch 命不中其缓存');
    assert.equal((deckCards.match(/<DeckImage/g) ?? []).length, 4, 'deck 四卡体应全量换 DeckImage');
    // 位图级预解码仍走去抖窗（raster 预算纪律），且 effect deps 不含 items
    assert.match(
        editorSource,
        /return \(\) => clearTimeout\(timer\);\n\s*\/\/ eslint-disable-next-line react-hooks\/exhaustive-deps[^\n]*\n\s*\}, \[safeIndex, itemCount, cardWidth, cardHeight\]\);/,
    );
});

test('B7 堆叠 memo：文字防抖提交不重渲 deck（相等器接线 + 引用透传前提）', () => {
    assert.match(editorSource, /const MemoDeckStack = memo\(/);
    assert.match(editorSource, /deckItemsEqual\(prev\.items, next\.items\)/);
    assert.match(editorSource, /<MemoDeckStack/);
    // buildRenderUnits 对未变更块透传原引用（updateText 只换代被改的 p 块）——
    // deckItemsEqual 的引用语义依赖这一点，退化即整闸失效，锁住字面量
    assert.match(editorSource, /return block;\s*\n\s*\}\);\s*\n\s*if \(!changed\) return;/);
});

test('B8 占位常驻纪律：前卡未就绪渲染 raised 底（真实首帧就绪前无裸黑/无跳动）', () => {
    // DeckFrontCard：!ready && 非 missing 时保持卡体 raised 底（bg-ink-raised
    // 在卡体类上，ready 前零内容层）——预载只是消灭等待，占位通道不撤
    const front = editorSource.slice(
        editorSource.indexOf('function DeckFrontCardImpl'),
        editorSource.indexOf('const DeckFrontCard = memo('),
    );
    assert.match(front, /status === 'missing' \?/);
    assert.match(front, /const ready = status === 'ready' && uri != null;/);
    // 加载态：不渲染内容层（null），raised 底常驻到真实首帧就绪
    assert.match(front, /\) : null\}/);
});

/* ─────────────── 屏层接线（journal-edit-screen 侧的 memo 契约） ─────────────── */

test('C1 屏层写回块表走恒定 onChange 引用（canvasContent 重建不再多一记噪声）', () => {
    assert.match(screenSource, /const handleEditorChange = useCallback\(/);
    assert.match(screenSource, /onChange=\{handleEditorChange\}/);
    assert.ok(
        !/onChange=\{\(next\) => applyBlocks/.test(screenSource),
        'canvasContent 里 inline 全量写回回调回潮',
    );
});
