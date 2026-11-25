import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 编辑器输入契约把关（v0.4.7，用户第 2a 条令「输入框每次刷新或其他操作会
 * 非常不自然」）。断言需求侧不变量（预期来自指令而非复制实现）：
 * - TextInput 的值事实源 = 本地草稿（draft），外部 blocks 重灌只在「不在编辑」
 *   时发生——自动保存回写/revision 广播/插块删块重渲不得触碰正在编辑的值；
 * - 提交走防抖窗 + blur 即时收口 + 卸载兜底三通道（沿用屏层 800ms 自动保存
 *   语义，本窗只发生在它之前；防抖窗必须短于屏层节拍，落库最坏延迟不恶化）；
 * - 迟到的提交从 blocks 最新镜像重算 + 恒等 bail（块已删/同值不上抛，旧闭包
 *   不覆盖新块序）；
 * - 聚焦中的段在邻位重排时抑制透明度脉冲（「做其他操作时输入框闪一下」的
 *   可见症状源头）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const editorSource = await readFile(
    path.join(repoRoot, 'src/features/archive/ui/editor.tsx'),
    'utf8',
);

/** TextBlock 函数体（自声明起截到下一个顶层函数注释前，结构断言用）。 */
const textBlockSrc = (() => {
    const start = editorSource.indexOf('function TextBlock({');
    assert.ok(start > 0, 'TextBlock 结构变了，测试口径需同步');
    const end = editorSource.indexOf('/**\n * 落盘进度环', start);
    assert.ok(end > start, 'TextBlock 尾部结构变了，测试口径需同步');
    return editorSource.slice(start, end);
})();

test('草稿态事实源：TextInput value 走本地 draft，不再直连受控 value', () => {
    assert.match(textBlockSrc, /const \[draft, setDraft\] = useState\(value\);/);
    assert.match(textBlockSrc, /value=\{draft\}/);
    // onChangeText 写草稿并排防抖提交（不再逐键直抛屏层）
    assert.match(textBlockSrc, /setDraft\(text\);/);
    assert.match(textBlockSrc, /scheduleCommit\(\);/);
    assert.ok(
        !/onChange\(text\);/.test(textBlockSrc),
        '逐键直抛 onChange 回潮（每键全画布重渲即「输入不自然」的病灶）',
    );
});

test('外部 value 只在不编辑时采纳：聚焦/挂起提交期间零重灌', () => {
    // 采纳闸三条件缺一不灌：未聚焦、无挂起防抖拍、外部值确实偏离已提交基线
    assert.match(textBlockSrc, /shouldAdoptExternalText\(\{[\s\S]*?focused: focusedRef\.current,[\s\S]*?pendingCommit: commitTimerRef\.current != null/);
    // 采纳落点走 uncontrolled 原生落位（IME 修复轮）：web 受控、native setNativeProps
    assert.match(textBlockSrc, /Platform\.OS !== 'web'/);
    // 采纳落点只写草稿与基线，不动 DOM 归属（编辑中永不进这条路径）
    assert.match(textBlockSrc, /committedRef\.current = value;\s*\n\s*setDraft\(value\);/);
});

test('提交三通道齐全且防抖窗短于屏层 800ms 自动保存节拍', () => {
    const msMatch = textBlockSrc.match(/const DRAFT_COMMIT_MS = (\d+);/) ?? editorSource.match(/const DRAFT_COMMIT_MS = (\d+);/);
    assert.ok(msMatch, 'DRAFT_COMMIT_MS 缺失');
    const ms = Number(msMatch[1]);
    assert.ok(ms > 0 && ms < 800, `草稿提交窗 ${ms}ms 必须落在 (0,800)——自动保存语义不变、只加快收敛`);
    // blur 即时收口（失焦即存契约）
    const blurBody = textBlockSrc.split('onBlur={() => {')[1]?.split('}}')[0] ?? '';
    assert.ok(blurBody.includes('commitDraft();'), 'blur 未即时提交草稿');
    // 卸载兜底
    assert.match(textBlockSrc, /commitRef\.current\(\);/);
    // onChange 经最新闭包 ref（防抖窗内 blocks 换代不丢字）
    assert.match(textBlockSrc, /onChangeRef\.current\(draftRef\.current\)/);
});

test('updateText 走最新 blocks 镜像 + 恒等 bail（迟到提交不覆盖不空转）', () => {
    assert.match(editorSource, /const blocksRef = useRef\(blocks\);/);
    const updateSrc = editorSource.split('const updateText = (id: string, text: string) => {')[1]?.split('\n    };')[0] ?? '';
    assert.ok(updateSrc.length > 0, 'updateText 结构变了，测试口径需同步');
    assert.ok(updateSrc.includes('blocksRef.current'), 'updateText 必须从最新镜像起算');
    assert.ok(/if \(!current\.some\(/.test(updateSrc), '目标块已删时必须 bail（卸载兜底迟于删块）');
    assert.ok(updateSrc.includes('if (!changed) return;'), '同值提交必须原样 bail（无谓换代 = 无谓自动保存拍）');
});

test('聚焦段抑制重排脉冲（BlockReveal muted），其余段反馈保留', () => {
    assert.match(editorSource, /muted=\{activeBlockId === block\.id\}/);
    const revealSrc = editorSource.split('function BlockReveal({')[1]?.split('\nfunction ')[0] ?? '';
    assert.ok(revealSrc.length > 0, 'BlockReveal 结构变了，测试口径需同步');
    assert.match(revealSrc, /if \(mutedRef\.current\) return;/);
    // 未聚焦段的脉冲通道仍在（反馈不许被顺手删掉）
    assert.match(revealSrc, /opacity\.setValue\(0\.45\);/);
});
