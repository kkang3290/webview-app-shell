# 由 appshell prebuild ios 调用：ruby configure.rb <生成的 ios 目录> <appshell.json>
# 把 Capacitor 干净模板改成目标 App：加入外壳 Swift 源码、写入包名/版本/权限文案。
require 'json'
require 'xcodeproj'

ios_root, shell_path = ARGV
abort 'usage: configure.rb <ios-dir> <appshell.json>' unless ios_root && shell_path
shell = JSON.parse(File.read(shell_path))
abort "appshell.json schemaVersion 不受支持：#{shell['schemaVersion']}" unless shell['schemaVersion'] == 1

project_path = File.join(ios_root, 'App/App.xcodeproj')
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.name == 'App' }
abort "#{project_path} 里没有 App target" unless app
group = project.main_group.find_subpath('App', true)

shell.fetch('ios').fetch('sources').each do |name|
  reference = group.files.find { |file| file.path == name } || group.new_file(name)
  app.source_build_phase.add_file_reference(reference, true)
end
shell.fetch('ios').fetch('resources').each do |name|
  reference = group.files.find { |file| file.path == name } || group.new_file(name)
  app.resources_build_phase.add_file_reference(reference, true)
end

ios = shell.fetch('ios')
# 业务扩展声明的系统能力（如内购 com.apple.InAppPurchase）：标在 target 上，自动签名据此配置 App ID。
unless ios.fetch('systemCapabilities').empty?
  attributes = project.root_object.attributes['TargetAttributes'] ||= {}
  capabilities = (attributes[app.uuid] ||= {})['SystemCapabilities'] ||= {}
  ios.fetch('systemCapabilities').each { |name| capabilities[name] = { 'enabled' => 1 } }
end
app.build_configurations.each do |configuration|
  settings = configuration.build_settings
  settings['PRODUCT_BUNDLE_IDENTIFIER'] = shell.fetch('applicationId')
  settings['MARKETING_VERSION'] = shell.fetch('versionName')
  settings['CURRENT_PROJECT_VERSION'] = shell.fetch('versionCode').to_s
  settings['IPHONEOS_DEPLOYMENT_TARGET'] = ios.fetch('deploymentTarget')
  settings['TARGETED_DEVICE_FAMILY'] = ios.fetch('deviceFamily')
  settings['CODE_SIGN_STYLE'] = 'Automatic'
  if ios['teamId']
    settings['DEVELOPMENT_TEAM'] = ios['teamId']
  else
    settings.delete('DEVELOPMENT_TEAM')
  end
end
# 业务扩展：资源、本地 Swift Package、链接参数、构建脚本。
extension = ios['extension']
if extension
  extension.fetch('resources').each do |name|
    reference = group.files.find { |file| file.path == name } || group.new_file(name)
    reference.last_known_file_type = 'wrapper.cfbundle' if name.end_with?('.bundle')
    app.resources_build_phase.add_file_reference(reference, true)
  end
  extension.fetch('packages').each do |item|
    relative = File.join('../extension', item.fetch('dir'))
    package = project.root_object.package_references.find { |ref| ref.respond_to?(:relative_path) && ref.relative_path == relative }
    unless package
      package = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
      package.relative_path = relative
      project.root_object.package_references << package
    end
    next if app.package_product_dependencies.any? { |dep| dep.product_name == item.fetch('product') }
    product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
    product.product_name = item.fetch('product')
    product.package = package
    app.package_product_dependencies << product
    build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
    build_file.product_ref = product
    app.frameworks_build_phase.files << build_file
  end
  app.build_configurations.each do |configuration|
    settings = configuration.build_settings
    settings['APPSHELL_EXTENSION_DIR'] = '$(SRCROOT)/../extension'
    next if extension.fetch('linkerFlags').empty?
    flags = settings['OTHER_LDFLAGS']
    flags = flags.is_a?(Array) ? flags.dup : flags.to_s.split
    flags.unshift('$(inherited)') unless flags.include?('$(inherited)')
    extension.fetch('linkerFlags').each { |flag| flags << flag unless flags.include?(flag) }
    settings['OTHER_LDFLAGS'] = flags
  end
  extension.fetch('buildScripts').each do |item|
    phase = app.shell_script_build_phases.find { |existing| existing.name == item.fetch('name') } ||
            app.new_shell_script_build_phase(item.fetch('name'))
    phase.always_out_of_date = '1'
    phase.shell_script = item.fetch('script')
    # 放到所有阶段之后（CocoaPods 的嵌入框架阶段在 pod install 时才加进来，所以 cap sync 之后还会再跑一遍本脚本）
    app.build_phases.move(phase, app.build_phases.count - 1)
  end
  unless extension.fetch('buildScripts').empty?
    # 脚本要读写构建产物与扩展目录，不能关在脚本沙箱里
    app.build_configurations.each { |c| c.build_settings['ENABLE_USER_SCRIPT_SANDBOXING'] = 'NO' }
  end
end
# 屏幕共享（screenCapture）：ReplayKit 广播上传扩展是唯一能在 iOS 上采集整屏的方式。生成一个 app-extension target，
# 源码在 ios/App/Broadcast（prebuild 已拷好），推流库 HaishinKit 走 Swift Package，嵌进 App 的 PlugIns。
broadcast = ios['broadcast']
if broadcast
  target = project.targets.find { |t| t.name == 'Broadcast' } ||
           project.new_target(:app_extension, 'Broadcast', :ios, ios.fetch('deploymentTarget'), nil, :swift)
  bgroup = project.main_group.find_subpath('Broadcast', true)
  bgroup.set_source_tree('<group>')
  bgroup.set_path('Broadcast')
  broadcast.fetch('sources').each do |name|
    reference = bgroup.files.find { |file| file.path == name } || bgroup.new_file(name)
    target.source_build_phase.add_file_reference(reference, true)
  end
  bgroup.files.find { |file| file.path == 'Info.plist' } || bgroup.new_file('Info.plist')
  %w[ReplayKit CoreMedia VideoToolbox].each do |framework|
    target.add_system_framework(framework) unless target.frameworks_build_phase.files.any? { |f| f.display_name == "#{framework}.framework" }
  end
  package = project.root_object.package_references.find { |ref| ref.respond_to?(:repositoryURL) && ref.repositoryURL == broadcast.fetch('package').fetch('url') }
  unless package
    package = project.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
    package.repositoryURL = broadcast.fetch('package').fetch('url')
    package.requirement = { 'kind' => 'exactVersion', 'version' => broadcast.fetch('package').fetch('version') }
    project.root_object.package_references << package
  end
  broadcast.fetch('package').fetch('products').each do |name|
    next if target.package_product_dependencies.any? { |dep| dep.product_name == name }
    product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
    product.product_name = name
    product.package = package
    target.package_product_dependencies << product
    build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
    build_file.product_ref = product
    target.frameworks_build_phase.files << build_file
  end
  target.build_configurations.each do |configuration|
    settings = configuration.build_settings
    settings['PRODUCT_BUNDLE_IDENTIFIER'] = broadcast.fetch('bundleId')
    settings['PRODUCT_NAME'] = 'Broadcast'
    settings['INFOPLIST_FILE'] = 'Broadcast/Info.plist'
    settings['CODE_SIGN_ENTITLEMENTS'] = 'Broadcast/Broadcast.entitlements'
    settings['MARKETING_VERSION'] = shell.fetch('versionName')
    settings['CURRENT_PROJECT_VERSION'] = shell.fetch('versionCode').to_s
    settings['IPHONEOS_DEPLOYMENT_TARGET'] = ios.fetch('deploymentTarget')
    settings['TARGETED_DEVICE_FAMILY'] = ios.fetch('deviceFamily')
    settings['SWIFT_VERSION'] = '5.0'
    settings['SKIP_INSTALL'] = 'YES'
    settings['CODE_SIGN_STYLE'] = 'Automatic'
    settings['GENERATE_INFOPLIST_FILE'] = 'NO'
    settings['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
    if ios['teamId']
      settings['DEVELOPMENT_TEAM'] = ios['teamId']
    else
      settings.delete('DEVELOPMENT_TEAM')
    end
  end
  Xcodeproj::Plist.write_to_path({ 'com.apple.security.application-groups' => [broadcast.fetch('appGroup')] },
                                 File.join(ios_root, 'App/Broadcast/Broadcast.entitlements'))
  info_path = File.join(ios_root, 'App/Broadcast/Info.plist')
  info = Xcodeproj::Plist.read_from_path(info_path)
  info['CFBundleDisplayName'] = broadcast.fetch('name')
  Xcodeproj::Plist.write_to_path(info, info_path)
  # 主 App 依赖并嵌入扩展（PlugIns），签名时一起签
  app.add_dependency(target) unless app.dependencies.any? { |dep| dep.target == target }
  embed = app.copy_files_build_phases.find { |phase| phase.name == 'Embed Foundation Extensions' } ||
          app.new_copy_files_build_phase('Embed Foundation Extensions')
  embed.dst_subfolder_spec = '13'
  unless embed.files.any? { |file| file.file_ref == target.product_reference }
    embed.add_file_reference(target.product_reference, true).settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
  end
end

# entitlements：推送的 aps-environment 与业务扩展声明的（关联域名等）合并写入；签名时带上（模拟器 ad-hoc 签名也需要）。
aps = ios['apsEnvironment']
entitlements = {}
entitlements['aps-environment'] = aps if aps
entitlements.merge!(extension.fetch('entitlements')) if extension
# 屏幕共享：主 App 与广播扩展经同一个 App Group 交换租约、状态与回放分段
if broadcast
  groups = (entitlements['com.apple.security.application-groups'] || []) | [broadcast.fetch('appGroup')]
  entitlements['com.apple.security.application-groups'] = groups
end
entitlements_path = File.join(ios_root, 'App/App/App.entitlements')
if !entitlements.empty?
  Xcodeproj::Plist.write_to_path(entitlements, entitlements_path)
  app.build_configurations.each { |c| c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements' }
else
  File.delete(entitlements_path) if File.exist?(entitlements_path)
  app.build_configurations.each { |c| c.build_settings.delete('CODE_SIGN_ENTITLEMENTS') }
end
project.build_configurations.each do |configuration|
  configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = ios.fetch('deploymentTarget')
end
project.save

plist_path = File.join(ios_root, 'App/App/Info.plist')
plist = Xcodeproj::Plist.read_from_path(plist_path)
plist['CFBundleDisplayName'] = shell.fetch('appName')
ios.fetch('usageDescriptions').each { |key, text| plist[key] = text }
plist['ITSAppUsesNonExemptEncryption'] = false
extension&.fetch('infoPlist')&.each { |key, value| plist[key] = value }
plist.delete('UIMainStoryboardFile')
plist.dig('UIApplicationSceneManifest', 'UISceneConfigurations', 'UIWindowSceneSessionRoleApplication')&.each do |item|
  item.delete('UISceneStoryboardFile')
end
plist['UIRequiredDeviceCapabilities'] = ['arm64']
# 后台录音：录音进行中切后台 / 锁屏，系统不挂起音频采集（NativeRecorder 能力）。
# 业务扩展 infoPlist 里声明的后台模式（如课堂音频的 audio / voip）与能力组推导出的合并，不互相覆盖。
background_modes = ios.fetch('backgroundModes') | Array(extension&.fetch('infoPlist')&.fetch('UIBackgroundModes', nil))
if background_modes.empty?
  plist.delete('UIBackgroundModes')
else
  plist['UIBackgroundModes'] = background_modes
end
Xcodeproj::Plist.write_to_path(plist, plist_path)

podfile_path = File.join(ios_root, 'App/Podfile')
podfile = File.read(podfile_path)
patched = podfile.sub(/^platform :ios, '[0-9.]+'/, "platform :ios, '#{ios.fetch('deploymentTarget')}'")
abort 'Podfile 里找不到 platform :ios 行' if patched == podfile && !podfile.include?("platform :ios, '#{ios.fetch('deploymentTarget')}'")
File.write(podfile_path, patched)
puts "iOS 工程已配置：#{shell['applicationId']} #{shell['versionName']} (#{shell['versionCode']})"
