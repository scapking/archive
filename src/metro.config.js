const fs = require('fs');
const path = require('path');

const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const cssInteropRoot = path.dirname(
  require.resolve('react-native-css-interop/package.json'),
);
const cssInteropCacheDirectory = path.join(cssInteropRoot, '.cache');
const cssInteropWebStylesheet = path.join(cssInteropCacheDirectory, 'web.css');

// css-interop 0.2.x 在打包阶段才写 web.css，届时 Metro 初始文件映射已结束；
// forceWriteFileSystem 又会关闭其虚拟模块 SHA 补丁，干净安装因此无法计算该文件 SHA。
// 先登记空文件，让 Metro 收录路径；lazy SHA 会在 transform 时读取随后写入的最终 CSS。
fs.mkdirSync(cssInteropCacheDirectory, { recursive: true });
if (!fs.existsSync(cssInteropWebStylesheet)) {
  fs.writeFileSync(cssInteropWebStylesheet, '');
}

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push('wasm');

// forceWriteFileSystem：编译产物写真实文件（.cache/<platform>），绕过虚拟模块补丁——
// SDK 58 的 Metro 内部结构下 css-interop 的 ensureBundlerPatched 失效，
// dev 虚拟模块不进 bundle，导致全平台 className 无样式（真机+web 均复现）。
module.exports = withNativeWind(config, { input: './global.css', forceWriteFileSystem: true });
