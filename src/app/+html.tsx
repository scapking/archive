import { ScrollViewStyleReset, useServerDocumentContext } from 'expo-router/html';
import type { ReactNode } from 'react';

// This file is web-only and used to configure the root HTML for every
// web page during static rendering.
// The contents of this function only run in Node.js environments and
// do not have access to the DOM or browser APIs.
export default function Root({ children }: { children: ReactNode }) {
  const { headNodes, bodyNodes, htmlAttributes, bodyAttributes } = useServerDocumentContext();

  return (
    <html lang="en" {...htmlAttributes}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />

        {/*
          Disable body scrolling on web. This makes ScrollView components work closer to how they do on native.
          However, body scrolling is often nice to have for mobile web. If you want to enable it, remove this line.
        */}
        <ScrollViewStyleReset />
        {/*
          NativeWind web 样式：css-interop 的 dev 注入在 SDK 58 下失效（见 AGENTS.md 偏差表），
          改为直接挂 Tailwind 编译产物（public/nativewind.css，由 `pnpm web:css` 再生成）。
        */}
        <link rel="stylesheet" href="/nativewind.css" />

        {/* Using raw CSS styles as an escape-hatch to ensure the background color never flickers in dark-mode. */}
        <style dangerouslySetInnerHTML={{ __html: responsiveBackground }} />
        {/* Add any additional <head> elements that you want globally available on web... */}
        {headNodes}
      </head>
      <body {...bodyAttributes}>
        {children}
        {bodyNodes}
      </body>
    </html>
  );
}


const responsiveBackground = `
/*
 * NativeWind dark-mode 标志的前置声明：与 tailwind.config.js 的 \`darkMode: 'class'\`
 * 保持同步（media 模式下 css-interop 的 MutationObserver 会调 colorScheme.set 并抛错，
 * 见 nativewind/nativewind#1489）。背景色对齐设计令牌底色，避免首帧闪白。
 */
:root {
  --css-interop-darkMode: class;
}
body {
  background-color: #080A0A;
}
@media (prefers-color-scheme: dark) {
  body {
    background-color: #080A0A;
  }
}`;
