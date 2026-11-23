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
  s.platforms      = { :ios => '15.1' }
  s.source         = { :path => '..' }
  s.source_files   = 'ios/**/*.{h,m,mm,swift}'
  s.dependency 'expo-modules-core'
end