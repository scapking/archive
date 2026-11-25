require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'archive-widget'
  s.version        = package['version']
  s.summary        = 'Archive home-screen widget data bridge (App Group snapshot push).'
  s.description    = 'Writes the widget snapshot JSON into the shared App Group UserDefaults; the WidgetKit extension reads it.'
  s.homepage       = 'https://github.com/scapking/archive'
  s.license        = { :type => 'MIT' }
  s.author         = { 'scapking' => 'scapking@users.noreply.github.com' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :path => '..' }
  s.static_framework = true
  # source_files 相对 podspec 所在目录（本文件已在 ios/ 内）——写成 'ios/**'
  # 会去找不存在的 ios/ios/，pod 装上了却 0 源文件，archive_widget 模块根本不
  # 产出，ExpoModulesProvider 的 import 直接解析失败（v0.4.4 门禁第三轮实测）
  s.source_files   = '**/*.{h,m,mm,swift}'
  # 官方 expo pod 同款：显式声明产出模块（archive_widget 供 ExpoModulesProvider import）
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
  # v0.4.7：push 后 WidgetCenter.reloadTimelines 即时刷桌面卡（iOS14+ API，
  # 部署目标 16.4 恒可用）——需链接 WidgetKit 系统框架
  s.frameworks     = 'WidgetKit'
  # pod 名是 ExpoModulesCore（大驼峰）——写成 expo-modules-core 会让 CocoaPods
  # 去 trunk CDN 找不存在的 spec（v0.4.4 门禁构建实测报错）
  s.dependency 'ExpoModulesCore'
end