1. 我不喜欢笔记编辑部分的 ui ，把这个完成部分移除也就是去除底部导航栏，直接在那放一个 + 号点击功能，底部全部清空。另一个是我发现功能基本正常，Android Expo Go 点击基本生效但是它好像是要固定双击两下才生效，正常不都是单点击么？ 以及笔记编辑部分 ，帮我改成的相机 ui 改成 卡片 ui。以及 把删除以及点击移动改成长按移动长按删除，去除左上角右上角的移动和删除。更沉浸式一些。
1.1.  Archiver 首页部分两个卡片，内容已经删除了，但还在引用。改成删除时一并删除，包括内容。指的是 音图片视频。
1.2。笔记输入框默认时候的输入框是正常的，但是添加 音视频内容时后的新建输入框时错误的。
2. 行程部分的 日期始终不对，不管怎么填写都是。
3. 首页部分的两个卡片，进行显示内容和图片，不能横向而是垂直显示，根据容量自适应显示内容，进行大重构。
4. 行程部分，根本不是人使用的，改成 类似 笔记一样创建行程，时间和日期，行程是一个持续性的，
创建一个行程后，这个行程独立，可以被独立搜索到。这个 行程卡片只是 ui 实际 行程是独立的，在行程内部可以查看时间和拍照视频类似笔记。 但是核心内容是行程。
5. Me 页面的 搜索改成 一个卡片，点击进入一个页面，这个页面负责搜索行程或者笔记，但是要分开，比如搜索框 Notes: xxxxxxxx xingcheng: xxxxx 这个只是比喻用的单次拼音，实际要正规一些。
要支持时间范围搜索和笔记或者行程标题。最好可以增加一个日历，这个日历有当时的笔记和行程信息。
6. 笔记编辑部分要可以调整，笔记信息 比如标题和名字。
7.笔记行程完成后不可以修改，
8.笔记的 录音卡片 以及 拍照卡片 拍视频卡片太丑进行优化升级。
9. web 端 或者桌面端的 笔记 和 行程长按改成 双击弹出。移动端设备保持长按弹出。 
10. 笔记的视频拍摄不可以有上限，以及 ui 太丑！改成卡片式
11.去除 web 的滚动条。！
12.web 输入框真的很丑！！！
13 不可以有边框！对照大厂，黑色主题，输入框其他不一样的颜色接近色，白色主题也类似，参考一些颜色主题规范，设计。
14. Android Expo Go 测试录音，保存的时候触发： 
Require cycles are allowed, but can result in uninitialized values. Consider refactoring to remove the need for a cycle.
 ERROR  Style property width is not supported by native animated module 

Code: NativeAnimatedValidation.js
  35 |   for (const key in styles) {
  36 |     if (!isSupportedStyleProp(key)) {
> 37 |       console.error(
     |                    ^
  38 |         `Style property  is not supported by native animated module`,
  39 |       );
  40 |     }
Call Stack
  validateStyles (node_modules/react-native/src/private/animated/NativeAnimatedValidation.js:37:20)
  __getNativeConfig (node_modules/react-native/Libraries/Animated/nodes/AnimatedStyle.js:242:21)
  __getNativeTag (node_modules/react-native/Libraries/Animated/nodes/AnimatedNode.js:215:44)
  __addChild (node_modules/react-native/Libraries/Animated/nodes/AnimatedWithChildren.js:49:71)
  __attach (node_modules/react-native/Libraries/Animated/nodes/AnimatedStyle.js:205:22)
  __addChild (node_modules/react-native/Libraries/Animated/nodes/AnimatedWithChildren.js:43:20)
  __attach (node_modules/react-native/Libraries/Animated/nodes/AnimatedProps.js:217:22)
  useInsertionEffect$argument_0 (node_modules/react-native/src/private/animated/createAnimatedPropsHook.js:293:18) 

Code: wrap-jsx.js
  18 |             type = api_1.interopComponents.get(type) ?? type;
  19 |         }
> 20 |         return jsx.call(jsx, type, props, ...rest);
     |                        ^
  21 |     };
  22 | }
  23 | //# sourceMappingURL=wrap-jsx.js.map
Call Stack
  <anonymous> (node_modules/react-native-css-interop/dist/runtime/wrap-jsx.js:20:24)
  AudioBlock (features/archive/ui/audio-player.tsx:171:33)

15. 核心 笔记编辑全部 UI， 行程全部UI， Me部分的 搜索部分的 UI。 Ui 好看，性能好，可用性高。
16. Archive 点击笔记卡片的图片预览显示有bug
17. 笔记编辑的图片没有全屏显示 图片视频。
18. 笔记编辑的图片视频显示图层有bug。

Logs for your project will appear below. Press Ctrl+C to exit.
Android Bundled 35656ms node_modules/expo-router/entry.js (2025 modules)
 WARN  ImageBackground is deprecated and will be removed in a future release. Use a View with an absolutely positioned Image instead. See https://reactnative.dev/docs/imagebackground
 WARN  Require cycle: features/archive/store.ts -> features/archive/ui/index.ts -> features/archive/ui/editor.tsx -> features/archive/ui/media-view.tsx -> features/archive/ui/audio-player.tsx -> features/archive/ui/use-file-url.ts -> features/archive/store.ts

Require cycles are allowed, but can result in uninitialized values. Consider refactoring to remove the need for a cycle.
 ERROR  Style property width is not supported by native animated module 

Code: NativeAnimatedValidation.js
  35 |   for (const key in styles) {
  36 |     if (!isSupportedStyleProp(key)) {
> 37 |       console.error(
     |                    ^
  38 |         `Style property  is not supported by native animated module`,
  39 |       );
  40 |     }
Call Stack
  validateStyles (node_modules/react-native/src/private/animated/NativeAnimatedValidation.js:37:20)
  __getNativeConfig (node_modules/react-native/Libraries/Animated/nodes/AnimatedStyle.js:242:21)
  __getNativeTag (node_modules/react-native/Libraries/Animated/nodes/AnimatedNode.js:215:44)
  __addChild (node_modules/react-native/Libraries/Animated/nodes/AnimatedWithChildren.js:49:71)
  __attach (node_modules/react-native/Libraries/Animated/nodes/AnimatedStyle.js:205:22)
  __addChild (node_modules/react-native/Libraries/Animated/nodes/AnimatedWithChildren.js:43:20)
  __attach (node_modules/react-native/Libraries/Animated/nodes/AnimatedProps.js:217:22)
  useInsertionEffect$argument_0 (node_modules/react-native/src/private/animated/createAnimatedPropsHook.js:293:18) 

Code: wrap-jsx.js
  18 |             type = api_1.interopComponents.get(type) ?? type;
  19 |         }
> 20 |         return jsx.call(jsx, type, props, ...rest);
     |                        ^
  21 |     };
  22 | }
  23 | //# sourceMappingURL=wrap-jsx.js.map
Call Stack
  <anonymous> (node_modules/react-native-css-interop/dist/runtime/wrap-jsx.js:20:24)
  AudioBlock (features/archive/ui/audio-player.tsx:172:33)
  <anonymous> (node_modules/react-native-css-interop/dist/runtime/wrap-jsx.js:20:24)
  MediaBlock (features/archive/ui/media-view.tsx:225:40)
  <anonymous> (node_modules/react-native-css-interop/dist/runtime/wrap-jsx.js:20:24)
  blocks.map$argument_0 (features/archive/ui/editor.tsx:325:29)
  BlockEditor (features/archive/ui/editor.tsx:262:24)
  <anonymous> (node_modules/react-native-css-interop/dist/runtime/wrap-jsx.js:20:24)
  JournalEditScreen (features/archive/journal-edit-screen.tsx:434:25)
  <anonymous> (node_modules/react-native-css-interop/dist/runtime/wrap-jsx.js:20:24)
  WriteRoute (app/write.tsx:5:12)
  <anonymous> (node_modules/react-native-css-interop/dist/runtime/wrap-jsx.js:20:24)
  RootLayout (app/_layout.tsx:52:13)
Android Bundled 83ms node_modules/expo-router/entry.js (1 module)
 WARN  ImageBackground is deprecated and will be removed in a future release. Use a View with an absolutely positioned Image instead. See https://reactnative.dev/docs/imagebackground
 WARN  Require cycle: features/archive/store.ts -> features/archive/ui/index.ts -> features/archive/ui/editor.tsx -> features/archive/ui/media-view.tsx -> features/archive/ui/audio-player.tsx -> features/archive/ui/use-file-url.ts -> features/archive/store.ts

Require cycles are allowed, but can result in uninitialized values. Consider refactoring to remove the need for a cycle.



