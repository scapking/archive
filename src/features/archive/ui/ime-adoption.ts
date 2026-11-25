/**
 * native 输入框的外部文本采纳判定（v0.4.7 IME 兼容性修复的单点决策，纯函数）。
 *
 * 背景（用户真机报告）：拼音等组合型输入法在编辑器/表单里**候选框不出现、
 * 其他输入法整打不了**——典型病灶是 JS 在组合期间把 value 回灌 TextInput
 * （RN 在 Android 会对 EditText setText，打断 InputConnection 的组合会话，
 * 候选窗随之销毁）。0.4.7 的 draft 受控模型虽然把「回灌时机」收在不聚焦
 * 时，但 value prop 本身仍是每渲染都在场的受控源——Fabric 的 setText 保护
 * 在组合中并不完全可靠，第三方 IME（自有候选窗、走 commitText 路径）受害
 * 最深。修复：native 侧输入框改 **uncontrolled**（value 不进原生，文本
 * 事实源归编辑器），外部文本变化只在「不在编辑现场」时经 setNativeProps
 * 一次性落位，判定全收口到本函数。
 *
 * web 分支不走这里：DOM 受控输入对 IME 组合无破坏（浏览器自己管 composition），
 * 保留受控。
 */
export interface ImeAdoptionInput {
    /** 输入框正聚焦（组合会话可能在飞）。 */
    focused: boolean;
    /** 有挂起的防抖提交（编辑刚收尾，原生文本仍是权威草稿）。 */
    pendingCommit: boolean;
    /** 上一次交给原生的文本（展示基线）。 */
    shown: string;
    /** 外部（屏层/DB）发来的新文本。 */
    incoming: string;
}

/** 该不该把 incoming 落位到原生编辑器。false = 保持原生现状、零打扰。 */
export function shouldAdoptExternalText({
    focused,
    pendingCommit,
    shown,
    incoming,
}: ImeAdoptionInput): boolean {
    if (focused || pendingCommit) return false;
    return shown !== incoming;
}
