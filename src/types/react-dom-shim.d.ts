// react-dom 最小类型面（web ViewerPortal 专用）：工程未装 @types/react-dom，
// 不为此新增 devDependency——只声明实际消费的 createPortal；后续若安装官方
// @types/react-dom，本文件可整体删除（模块声明以先加载者为准，勿重复保留）。
declare module 'react-dom' {
    import type { ReactNode } from 'react';
    export function createPortal(
        children: ReactNode,
        container: Element | DocumentFragment,
        key?: string,
    ): ReactNode;
}
