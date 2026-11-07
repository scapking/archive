import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * web 专属全屏门户：覆盖层直接挂到 document.body——深层组件（ScrollView/
 * FlatList 里的媒体块）内联渲染时，DOM overflow:auto 会把负偏移覆盖层裁剪
 * 在滚动视口内（native Android ReactScrollView setClipChildren(false) 不裁，
 * web DOM 裁——iOS FullWindowOverlay 同语义的窗口级容器只在 web 缺位）。
 * portal 后 containing block = 初始包含块（视口），inset-0 即全窗，且不受
 * 祖先 stacking context 限制，命中测试不再漏到报头。
 */
export function ViewerPortal({ children }: { children: ReactNode }) {
    return createPortal(children, document.body);
}
