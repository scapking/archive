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
  s.source_files   = 'ios/**/*.{h,m,mm,swift}'
  # pod 名是 ExpoModulesCore（大驼峰）——写成 expo-modules-core 会让 CocoaPods
  # 去 trunk CDN 找不存在的 spec（v0.4.4 门禁构建实测报错）
  s.dependency 'ExpoModulesCore'
end