import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/** 同步读源（v0.4.7 新增跨文件把关用例用；顶层 await 的 readFile 结果在
 *  test 回调外不可 await，故补一个轻量同步入口，口径一致）。 */
function readFileSyncSafe(file: string): string {
    return readFileSync(file, 'utf8');
}

/**
 * 堆叠 deck「纸 × 墨 2.1」光影语言把关（v0.4.9，用户令「渐变深蓝什么的太丑」
 * + 继承 v0.4.6「不要灰色相进、但要可以区分」）。断言的是需求侧视觉不变量：
 * - 卡面一律纸色：deckEdge 灰板壳色全域退役；**整面渐变也全域退役**——
 *   theme 不再有 From/To 渐变端点 token，trip 卡面不再 import LinearGradient；
 * - 三态 = 纸面档位差：ongoing 亮于 surface、pending = surface 素面、settled
 *   沉一档（两主题方向同构），档位值全部来自 ink/inkd 家族；
 * - 状态记号只许小面积 accent：细边描色 faceAccentEdge = 本主题 accent 档，
 *   且卡面文字/圆点/细边对底色对比 AA 硬闸（≥4.5:1，图形件 ≥3:1，双主题）；
 * - 分层靠光影：投影参数 token 化在 theme.ts，前卡档恒重于背卡档、夜面档恒
 *   重于纸面档（暗底黑影像要更浓才咬得住边界），且投影是静态 style，不得混进
 *   native driver 动画图（deck.tsx 白名单铁律）；
 * - 透明度只留退场通道（可见层恒 1）；
 * - 挂载纪律 v0.4.7：可见层位（0..2）全挂完整卡面（用户第 4 条令「都铺满」），
 *   隐藏位不挂 + 滞留窗卸载（0.4.6 性能红线口径保留）；
 * - 翻卡防中断（用户第 2b 条令）：两堆叠手势面拒软抢占 + terminate 补提交 +
 *   播放器面空闲闸 + 预解码档位去重。
 * 预期来自设计口径而非复制实现。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeSource = await readFile(path.join(repoRoot, 'src/features/archive/ui/theme.ts'), 'utf8');
const deckSource = await readFile(path.join(repoRoot, 'src/features/archive/ui/deck.tsx'), 'utf8');
const tripSource = await readFile(path.join(repoRoot, 'src/features/archive/trip-day-screen.tsx'), 'utf8');

/** 卡面三态档位 token（Palette 字段，LIGHT/DARK 两块都必须齐；v0.4.9 起
 *  From/To 渐变端点整族退役）。 */
const FACE_TOKENS = ['ongoingFace', 'pendingFace', 'settledFace', 'faceAccentEdge'] as const;

function block(theme: 'LIGHT' | 'DARK'): string {
    return themeSource.split(`const ${theme}: Palette = {`)[1]?.split('\n};')[0] ?? '';
}

function token(name: string, theme: 'LIGHT' | 'DARK'): string {
    const match = block(theme).match(new RegExp(`${name}: '#([0-9A-Fa-f]{6})'`));
    assert.ok(match, `token ${name} missing in ${theme} — 卡面渐变色阶不许缺档`);
    return match[1];
}

/** 投影档解析（deckShadow: { front: {...}, back: {...} } 单行对象字面量）。 */
function shadowSpec(theme: 'LIGHT' | 'DARK', side: 'front' | 'back') {
    const re = new RegExp(`${side}: \\{ color: '#([0-9A-Fa-f]{6})', opacity: ([\\d.]+), radius: (\\d+), offsetX: (\\d+), offsetY: (\\d+), elevation: (\\d+) \\}`);
    const match = block(theme).match(re);
    assert.ok(match, `deckShadow.${side} missing/malformed in ${theme} — 投影参数必须 token 化`);
    const [, color, opacity, radius, offsetX, offsetY, elevation] = match;
    return { color, opacity: Number(opacity), radius: Number(radius), offsetX: Number(offsetX), offsetY: Number(offsetY), elevation: Number(elevation) };
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

test('deckEdge 灰板壳色全域退役（无字段/无消费；注释史料除外）', () => {
    // theme.ts 不再有 deckEdge 字段；deck/trip 不再消费 palette.deckEdge
    assert.ok(
        !/^\s+deckEdge:/m.test(themeSource),
        'theme.ts 仍声明 deckEdge 字段——v0.4.5 灰板壳色已废（用户否「灰色相进」）',
    );
    for (const [name, source] of [
        ['deck.tsx', deckSource],
        ['trip-day-screen.tsx', tripSource],
    ] as const) {
        assert.ok(!source.includes('palette.deckEdge'), `${name} 仍消费 palette.deckEdge`);
    }
});

test('卡面三态档位 token + 投影参数双主题齐档；旧渐变端点 token 退役', () => {
    for (const theme of ['LIGHT', 'DARK'] as const) {
        for (const name of FACE_TOKENS) token(name, theme);
        shadowSpec(theme, 'front');
        shadowSpec(theme, 'back');
    }
    // v0.4.9 退渐变：From/To 端点字段不得回潮（含注释里的旧口径复用——字段
    // 声明面干净，Palette 契约就是契约）
    for (const retired of ['ongoingFrom', 'ongoingTo', 'pendingFrom', 'pendingTo', 'settledFrom', 'settledTo']) {
        assert.ok(
            !new RegExp(`^\\s+${retired}:`, 'm').test(themeSource),
            `theme.ts 仍声明渐变端点字段 ${retired}——v0.4.9 整面渐变已退场`,
        );
    }
});

test('卡壳纸面同色：deck.tsx 壳底恒 palette.surface，无按层位换色的三元', () => {
    assert.match(deckSource, /const shellBg = palette\.surface;/);
    assert.ok(
        !/shellBg = depth/.test(deckSource),
        '壳面色不得随层位漂移——分层靠光影，不靠色块',
    );
    assert.ok(!deckSource.includes('bg-ink-surface dark:bg-inkd-surface'), '壳面底色必须走 inline palette');
});

test('投影档单调：前卡重于背卡、夜面重于纸面、影色取自本主题墨阶', () => {
    for (const theme of ['LIGHT', 'DARK'] as const) {
        const front = shadowSpec(theme, 'front');
        const back = shadowSpec(theme, 'back');
        // 前卡浮于堆上：影必须更浓、更远、更散，否则露条边界咬不住
        assert.ok(front.opacity > back.opacity, `${theme} front.opacity 必须 > back.opacity`);
        assert.ok(front.radius >= back.radius, `${theme} front.radius 必须 ≥ back.radius`);
        assert.ok(front.offsetX >= back.offsetX && front.offsetY >= back.offsetY, `${theme} front 偏移必须 ≥ back（光源左上，位移同向）`);
        assert.ok(front.elevation > back.elevation, `${theme} front.elevation 必须 > back.elevation`);
        assert.ok(front.opacity > 0 && front.opacity < 1, `${theme} 投影浓度必须在 (0,1)`);
        // 影色 = 本主题墨阶（LIGHT 用 text 墨色，DARK 用纯黑），禁散写第三色
        assert.equal(
            front.color,
            theme === 'LIGHT' ? token('text', theme) : '000000',
            `${theme} 投影色必须取墨阶（LIGHT=text，DARK=纯黑）`,
        );
        assert.equal(back.color, front.color, `${theme} front/back 影色必须同族`);
    }
    // 夜面黑影像必须比纸面档浓——浅页上 0.1 级已可见，暗页上会整档消失
    const lightFront = shadowSpec('LIGHT', 'front');
    const darkFront = shadowSpec('DARK', 'front');
    assert.ok(darkFront.opacity > lightFront.opacity, 'DARK front.opacity 必须 > LIGHT（暗底投影更浓）');
});

test('投影是静态卡壳 style，不进 native driver 动画图', () => {
    // deck.tsx 动画图白名单铁律（transform/opacity）：layerStyle 内不许出现
    // 投影键；deckShadowStyle() 只许挂卡壳 View（backgroundColor 同处）
    const layerStyleSrc = deckSource.split('const layerStyle = useMemo')[1]?.split('const slot = useMemo')[0] ?? '';
    assert.ok(layerStyleSrc.length > 0, 'layerStyle 结构变了，测试口径需同步');
    for (const banned of ['boxShadow', 'shadowColor', 'elevation', 'deckShadowStyle']) {
        assert.ok(!layerStyleSrc.includes(banned), `动画图出现投影键 ${banned}——必须挂静态壳层`);
    }
    // 挂点 = 壳层 backgroundColor 同一 style 对象
    assert.match(deckSource, /deckShadowStyle\(/);
    assert.match(deckSource, /backgroundColor: shellBg, \.\.\.shellShadow/);
});

test('透明度只留退场通道：可见层恒 1、隐藏层位 1→0', () => {
    const opacityExpr = deckSource.split('opacity: values.depth.interpolate')[1]?.split('})')[0] ?? '';
    assert.ok(opacityExpr.length > 0, 'opacity 插值结构变了，测试口径需同步');
    // v0.4.7 全层铺满：可见层 = 0..VISIBLE_DEPTH(2) 三档恒实色，隐藏位淡出
    assert.match(opacityExpr, /outputRange: \[1, 1, 1, 0\]/);
    assert.ok(!opacityExpr.includes('0.45'), 'v0.4.3 渐隐下限回潮');
    assert.ok(!/outputRange: \[1, [0159]\.\d+, 0\]/.test(opacityExpr), 'v0.4.4 透明度顶替方案回潮');
});

test('挂载纪律 v0.4.7：全部可见层位挂完整卡面，深层纯壳 + 滞留窗卸载', () => {
    // 用户第 4 条令：v0.4.6「仅前卡+第一背卡挂内容」被否——可见深度提到 2，
    // 0..VISIBLE_DEPTH 全挂真实卡面（翻卡过程任何时刻露出层都有内容）；
    // 隐藏位（depth > VISIBLE_DEPTH）仍不挂（0.4.6 性能红线：隐藏层不常驻
    // 解码），退场经 DECK_CONTENT_LINGER_MS 滞留窗卸载
    assert.match(deckSource, /const VISIBLE_DEPTH = 2;/);
    assert.match(deckSource, /useState\(depth <= VISIBLE_DEPTH\)/);
    assert.match(deckSource, /DECK_CONTENT_LINGER_MS/);
    assert.match(deckSource, /setTimeout\(\(\) => setContentMounted\(false\), DECK_CONTENT_LINGER_MS\)/);
    // 卡面内容消费口必须先过 contentMounted 闸
    const contentSrc = deckSource.split('className="min-h-0 flex-1"')[1]?.split('页码')[0] ?? '';
    assert.ok(contentSrc.length > 0, '卡面内容结构变了，测试口径需同步');
    assert.ok(contentSrc.includes('contentMounted'), '内容必须经挂载闸（隐藏层不常驻解码）');
    // v0.4.7 铺满：背卡不再右缩进 PEEK（v0.4.2 露条壳面-only 铁律退役，
    // 用户否「空白区域」），但 overflow-hidden 包装层是 CDP 二分实测的承重件
    // （无包装全铺 = 首页 deck 拖拽不被认领/连翻失效）——两者都是契约。
    assert.ok(
        !contentSrc.includes('marginRight: PEEK'),
        '背卡内容右缩进 PEEK 回潮——v0.4.7 要求全层铺满（露条带真实内容）',
    );
    assert.ok(
        /<View className="min-h-0 flex-1 overflow-hidden">/.test(deckSource),
        '背卡 overflow-hidden 包装层缺失——连翻回归高危（见 deck.tsx 几何铁律段归因注）',
    );
    // 单一 item.node 消费路径（前/背同渲染，触摸让位由 pointerEvents 表达）
    assert.ok(contentSrc.includes('item.node'), '卡面消费路径缺失');
    assert.match(
        deckSource,
        /pointerEvents=\{depth === 0 \? 'auto' : 'none'\}/,
        '背卡层必须 pointerEvents 让位（露条点按 = 提前到前位 语义保住）',
    );
});

test('翻卡防中断：两个堆叠手势面都拒绝软抢占（release 不被吞）', () => {
    // 用户第 2b 条令：卡顿帧里 responder 被 scroll/selectionchange 终结 →
    // release 丢失 → 「卡一下然后翻不动」。deck.tsx 与编辑器 MediaDeckStack
    // 的 PanResponder 都必须挂 onPanResponderTerminationRequest: () => false，
    // 且 web 手势容器带 touch-action: pan-y（横向拖拽免疫浏览器滚动接管）
    assert.match(deckSource, /onPanResponderTerminationRequest: \(\) => false/);
    assert.match(deckSource, /touchAction: 'pan-y'/);
    assert.match(deckSource, /claimedFlag\.current = true;/, 'grant 必须幂等复位认领旗标');
    // 硬夺（terminate）同闸提交：过阈值补翻、未过回弹——release 被吞时翻卡不丢
    const termSrc = deckSource.split('onPanResponderTerminate:')[1]?.split('onPanResponderReject')[0] ?? '';
    assert.ok(termSrc.includes('PAN_COMMIT_DX'), 'deck terminate 未走提交闸（过阈值丢翻）');
    const editorSource = readFileSyncSafe(path.join(repoRoot, 'src/features/archive/ui/editor.tsx'));
    assert.match(editorSource, /onPanResponderTerminationRequest: \(\) => false/, 'MediaDeckStack 缺让位拒绝');
    const editTerm = editorSource.split('onPanResponderTerminate:')[1]?.split('onPanResponderTerminationRequest')[0] ?? '';
    assert.ok(editTerm.includes('SWIPE_COMMIT_DX'), 'MediaDeckStack terminate 未走提交闸（过阈值丢翻）');
    assert.ok(editTerm.includes('dragBusyRef.current = false'), 'terminate 未复位拖拽标记（空闲闸悬挂）');
    assert.ok(editorSource.includes('DECK_TOUCH_ACTION_STYLE'), 'MediaDeckStack 手势面缺 touch-action');
    // 视频播放器面挂窗必须查空闲闸（转场/拖拽在场则顺延）
    assert.match(editorSource, /busyRefs\.advancing\.current \|\| busyRefs\.dragging\.current/);
    // 邻卡预热带档位去重（连滑期每拍都能落地预热，不再现场解码）
    const urlSource = readFileSyncSafe(path.join(repoRoot, 'src/features/archive/ui/use-file-url.ts'));
    assert.ok(urlSource.includes('warmedDecodes'), 'prewarmImageDecode 缺档位去重表');
});

test('三态档位序：ongoing 亮 > pending 素面 > settled 沉，双主题方向同构', () => {
    // 「纸 × 墨 2.1」：状态区分靠纸面档位差（受光/素面/背光），不靠色场；
    // 两主题必须走同一方向（ongoing 恒是受光最足的一张纸）
    for (const theme of ['LIGHT', 'DARK'] as const) {
        const ongoing = luminance(token('ongoingFace', theme));
        const pending = luminance(token('pendingFace', theme));
        const settled = luminance(token('settledFace', theme));
        assert.ok(ongoing > pending, `${theme} ongoingFace 必须亮于 pendingFace（当前项受光档）`);
        assert.ok(pending > settled, `${theme} pendingFace 必须亮于 settledFace（完成的卡沉一档）`);
    }
});

test('pending = 壳色同档（素面白纸）；settled 不落退役灰板、不等于壳色', () => {
    const retiredGray = ['#D9DDE2', '#2E3533'];
    for (const theme of ['LIGHT', 'DARK'] as const) {
        assert.equal(
            token('pendingFace', theme),
            token('surface', theme),
            `${theme} pendingFace 必须 = surface（待进行卡与卡壳同档，克制不抢当前项）`,
        );
        const settled = token('settledFace', theme);
        assert.ok(!retiredGray.includes(settled), `${theme} settledFace 不得取退役灰板档 ${settled}`);
        assert.notEqual(settled, token('surface', theme), `${theme} settledFace 必须真的沉一档，不能与 surface 同值`);
        assert.notEqual(settled, token('sceneBg', theme), `${theme} settledFace 不得沉到与页面底色同值（卡会隐身）`);
    }
});

test('卡面文字 AA（硬闸）：text/secondary 在三档纸面上双主题 ≥4.5', () => {
    // 用户口径「对比度 AA 必须守住」：卡面允许出现的文字档只有 text（标题）
    // 与 secondary（eyebrow/描述）两档（muted 与渐变时代的白字族一并退场），
    // 每一档必须在三张纸面上都过 4.5:1。
    for (const theme of ['LIGHT', 'DARK'] as const) {
        for (const face of ['ongoingFace', 'pendingFace', 'settledFace'] as const) {
            const bg = token(face, theme);
            for (const ink of ['text', 'secondary'] as const) {
                const c = contrast(token(ink, theme), bg);
                assert.ok(c >= 4.5, `${theme} ${ink} on ${face}(${bg}) 对比 ${c.toFixed(2)} < 4.5`);
            }
        }
    }
});

test('小面积 accent 记号 AA：eyebrow/圆点色在当前纸面 ≥4.5，细边取 accent 档且 ≥3', () => {
    // accent 收窄为控件级小面积（v0.4.9）：卡面上的 accent 只有 eyebrow 文字、
    // 状态圆点与细边——文字/圆点按 4.5 闸，细边是图形件按 3:1 闸。
    for (const theme of ['LIGHT', 'DARK'] as const) {
        const ongoing = token('ongoingFace', theme);
        const accentText = contrast(token('accent', theme), ongoing);
        assert.ok(accentText >= 4.5, `${theme} accent eyebrow on ongoingFace 对比 ${accentText.toFixed(2)} < 4.5`);
        assert.equal(
            token('faceAccentEdge', theme),
            token('accent', theme),
            `${theme} faceAccentEdge 必须复用 accent 档（禁散写第三蓝）`,
        );
        const edge = contrast(token('faceAccentEdge', theme), ongoing);
        assert.ok(edge >= 3, `${theme} faceAccentEdge on ongoingFace 对比 ${edge.toFixed(2)} < 3`);
    }
});

test('整面渐变全域退场：trip 卡面零散落 hex、零 LinearGradient、三态走 palette 档位', () => {
    assert.ok(
        !/["']#[0-9A-Fa-f]{3,8}["']/.test(tripSource),
        'trip-day-screen 出现硬编码 hex 字面量（色值必须收进 theme.ts）',
    );
    assert.ok(!tripSource.includes('LinearGradient'), 'trip-day-screen 仍在用 LinearGradient——v0.4.9 整面渐变退场');
    assert.ok(!tripSource.includes('gradientColors'), 'trip-day-screen 残留渐变端点组装逻辑');
    for (const name of FACE_TOKENS) {
        assert.ok(tripSource.includes(`palette.${name}`), `三态卡面未引用 palette.${name}`);
    }
});

/** 卡面段（TripItemCardFace 函数体；槽位谎报与稀疏版式的把关范围）。 */
function cardFaceSection(): string {
    const start = tripSource.indexOf('const TripItemCardFace = memo(');
    const end = tripSource.indexOf('/* 时间编辑');
    assert.ok(start > 0 && end > start, '卡面段定位失败（结构变了口径同步）');
    return tripSource.slice(start, end);
}

test('状态记号绑 ongoing 阶段而非堆叠槽位（CDP 实拍证伪 index===0 谎报后立约）', () => {
    // 缺陷 1 回归闸：accent 细边/亮档/圆点必须来自 tripItemPhaseMap 的
    // 'ongoing' 派生——前卡槽位不再参与判定，全 pending 日零蓝。
    const face = cardFaceSection();
    assert.match(face, /const isCurrent = phase === 'ongoing';/, 'isCurrent 未由 ongoing 阶段派生');
    assert.ok(!tripSource.includes('isCurrent={index === 0}'), '细边仍绑槽位 index===0（谎报回潮）');
    assert.ok(!tripSource.includes('isCurrent={'), '卡面仍接收槽位侧 isCurrent prop（记号必须自派生）');
    // 细边渲染点只认阶段派生变量
    const edgeSrc = face.split('accent 细边')[1] ?? '';
    assert.ok(edgeSrc.includes('isCurrent ?') && edgeSrc.includes('palette.faceAccentEdge'), '细边条件/色源缺失');
    // deckItems 出卡：phase 单源喂入，index 不再入卡面
    const deckItemsSrc = tripSource.split('const deckItems: DeckItem[]')[1]?.split('onLongPress')[0] ?? '';
    assert.ok(deckItemsSrc.includes("phase={phaseById.get(item.id) ?? 'pending'}"), '卡面未接 phaseById 单源阶段');
    assert.ok(!deckItemsSrc.includes('index'), 'deckItems 卡面节点仍消费 map index');
});

test('卡面填实（纸 × 墨 2.1 版式）：30 报时 → 18 标题 → 16 备注两行 → mt-auto meta 行；settled 弱一档仍走 AA 档', () => {
    // 缺陷 2 回归闸（稀疏即罪）：430 高卡不允许只有 eyebrow+标题两行。
    // 版式契约：报时主角 30px tabular、标题 18 semibold、备注 16/24 两行截断、
    // meta 行 mt-auto 贴底（状态字 + 备注/图/视频小记号）；settled 仅降
    // 报时到 secondary（禁 muted——三档纸面 AA 由上一条目把关）。
    const face = cardFaceSection();
    assert.match(face, /fontSize: 30[\s\S]*?tabular-nums/, '报时未升为 30px tabular 主角');
    assert.ok(face.includes('{item.time}'), '报时未直接呈现 item.time');
    assert.match(face, /text-\[18px\] font-semibold/, '标题未走 18 semibold');
    assert.match(face, /numberOfLines=\{2\}[\s\S]*?text-\[16px\] leading-6/, '备注未走 16 正文两行截断');
    assert.ok(face.includes('mt-auto'), 'meta 行未贴底（mt-auto）');
    assert.match(face, /isSettled \? palette\.secondary : palette\.text/, 'settled 弱化未走 secondary 档');
    assert.ok(!face.includes('text-ink-muted') && !face.includes('text-inkd-muted'), '卡面出现 muted（AA 不达标色档回潮）');
    assert.ok(!face.includes('text-white'), '卡面出现白字族（旧渐变底记号回潮）');
});
