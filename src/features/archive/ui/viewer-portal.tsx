import type { ReactNode } from 'react';

/**
 * native 侧门户空实现（viewer-portal.web.tsx 的平台镜像）：
 * platform 分文件保证 react-dom 不进 native bundle——native 的全屏覆盖由
 * iOS FullWindowOverlay（窗口级容器）/ Android setClipChildren(false)+
 * 负偏移归零承担，无需 portal。
 */
export function ViewerPortal({ children }: { children: ReactNode }) {
    return <>{children}</>;
}
