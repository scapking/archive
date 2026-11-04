const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push('wasm');

// forceWriteFileSystem：编译产物写真实文件（.cache/<platform>），绕过虚拟模块补丁——
// SDK 58 的 Metro 内部结构下 css-interop 的 ensureBundlerPatched 失效，
// dev 虚拟模块不进 bundle，导致全平台 className 无样式（真机+web 均复现）。
module.exports = withNativeWind(config, { input: './global.css', forceWriteFileSystem: true });
