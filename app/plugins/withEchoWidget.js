/**
 * withEchoWidget — 把「鎖定畫面複習卡」的 Live Activity extension（EchoWidget）
 * 接進 CNG 產生的 Xcode 專案。
 *
 * **為什麼需要這個檔案**：這個 repo 是純 CNG（`.gitignore` 擋掉 `/ios`、`/android`），
 * `ios/` 每次 `expo prebuild` / EAS build 都從零重生。widget extension 是一個
 * Xcode target，而 target 只存在於 pbxproj 裡 —— 沒有 plugin，它每次都會被抹掉。
 * 真相來源永遠是 `targets/EchoWidget/`，`ios/EchoWidget/` 是這個 plugin 的輸出。
 *
 * **為什麼是自寫而不是裝套件**：`expo-widgets` 的 Live Activity 按鈕只發一個
 * 行程內的 NotificationCenter 事件，寫不進 App Group，答案會靜默丟失；
 * `@bacons/apple-targets` 在 RN 0.83+ 會破壞主 app 的 Embed Frameworks phase
 * （issue #194，我們是 RN 0.86）；`react-native-widget-extension` 依賴第二份
 * `@expo/config-plugins`。三者任一都會讓 dependencies 從 14 變 15，而
 * `expo/config-plugins` 與 `xcode` 本來就在 node_modules 裡 —— 自寫的新增依賴是 0。
 *
 * ⚠️ **這個檔案唯一不准違反的規則：對主 app target 只加不動。**
 * 不移除、不重排、不重建主 app 任何既有的 build phase。apple-targets #194 的死法
 * 就是動到了主 app 的 Embed Frameworks phase，結果 dyld 在啟動時找不到
 * `ReactNativeDependencies.framework`，app 開啟即被殺。我們本機沒有 Xcode，
 * 這類錯誤只會在 EAS 上才炸開，代價是幾十分鐘一輪。
 *
 * ⚠️ **第二條規則：三個共用的 .swift 必須同時編進主 app target。**
 * Apple 明訂 `LiveActivityIntent` 由系統在 **app 的行程**裡執行（不是 extension
 * 行程），所以 intent 型別必須存在於 app target。extension 那一份只是為了讓
 * `Button(intent:)` 通過型別檢查。漏掉主 app 那一份，按鈕會顯示但按下去毫無反應。
 *
 * 這一輪 `app.json` 的 `plugins` 陣列**刻意沒有加這個 plugin**——啟用方式與啟用後
 * 的驗證步驟寫在 `targets/README.md`。
 */
const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  createRunOncePlugin,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withPlugins,
  withXcodeProject,
} = require('expo/config-plugins');

/* --------------------------------------------------------------------------
 * 常數
 *
 * App Group id 在三個地方各有一份（Swift 的 `EchoAppGroup.identifier`、這裡的
 * `DEFAULT_APP_GROUP`、JS 的 `liveActivity.ts` 的 `APP_GROUP_ID`）。跨語言沒有
 * 共用常數的辦法，所以改一處必須改三處——這是刻意接受的重複，不是疏漏。
 * -------------------------------------------------------------------------- */
const DEFAULT_APP_GROUP = 'group.com.rickray.echo';
const DEFAULT_TARGET_NAME = 'EchoWidget';
/** extension 的實質下限由「互動按鈕」決定（iOS 17），不是由 Live Activity 的 16.2。 */
const DEFAULT_DEPLOYMENT_TARGET = '17.0';

/** 只編進 extension target：SwiftUI 版面與 `@main` bundle，app 那邊用不到也不該有。 */
const EXTENSION_ONLY_SOURCES = [
  'EchoWidgetBundle.swift',
  'EchoReviewLiveActivity.swift',
  'EchoWidgetColors.swift',
];

/**
 * 同時編進 **extension + 主 app** 兩個 target 的三個檔。
 * 理由見檔頭第二條規則。同一份原始碼進兩個 target 在 pbxproj 裡的表示法是：
 * 一個 PBXFileReference + 兩個 PBXBuildFile。
 */
const SHARED_SOURCES = [
  'EchoReviewAttributes.swift',
  'EchoAppGroup.swift',
  'EchoAnswerIntent.swift',
];

const INFO_PLIST_FILE_NAME = 'Info.plist';

/**
 * extension 明確連結的系統框架。Swift 的 autolinking 其實已經會處理，這裡明寫是
 * 為了讓 pbxproj 自我說明（未來的人打開專案就知道這個 target 依賴什麼）。
 * 全部是系統框架 ⇒ **不需要任何 pod**，這也是我們不碰 Podfile 的原因。
 */
const SYSTEM_FRAMEWORKS = [
  'WidgetKit.framework',
  'SwiftUI.framework',
  'ActivityKit.framework',
  'AppIntents.framework',
];

const APPLICATION_PRODUCT_TYPE = 'com.apple.product-type.application';
const SOURCES_PHASE = 'Sources';

/* --------------------------------------------------------------------------
 * 小工具
 * -------------------------------------------------------------------------- */

/**
 * pbxproj 的 build setting 值一律加引號寫出去。
 * 不加引號的話 `1,2`、`$(inherited) …` 這種含逗號/空白的值會讓 Xcode 解析歪掉；
 * 加了引號的純字串（`NO`、`YES`、`17.0`）Xcode 一樣讀得懂，所以統一加最省事。
 */
function quoted(value) {
  return `"${String(value)}"`;
}

function fail(message) {
  throw new Error(`[withEchoWidget] ${message}`);
}

function resolveOptions(config, props) {
  const options = props || {};
  const targetName = options.targetName || DEFAULT_TARGET_NAME;
  const appBundleIdentifier = config.ios && config.ios.bundleIdentifier;

  // 這裡不給預設值：猜錯 bundle id 會做出一個永遠簽不起來的 extension，
  // 而錯誤要等到 EAS credentials 那一步才浮現。寧可現在就停。
  if (!appBundleIdentifier) {
    fail('app.json 缺 ios.bundleIdentifier —— extension 的 bundle id 是從它衍生的。');
  }

  return {
    targetName,
    groupIdentifier: options.groupIdentifier || DEFAULT_APP_GROUP,
    deploymentTarget: options.deploymentTarget || DEFAULT_DEPLOYMENT_TARGET,
    /** extension 的 bundle id 必須是主 app 的前綴 + 一段後綴，這是 Apple 的硬規定。 */
    extensionBundleIdentifier: `${appBundleIdentifier}.${targetName}`,
  };
}

/**
 * 依名字找 PBXNativeTarget，回傳 uuid（找不到回 null）。
 *
 * 為什麼不用 `project.pbxTargetByName()`：它比對的是**註解**，而 `addTarget()`
 * 寫進去的註解是帶引號的 `"EchoWidget"`，所以拿 `EchoWidget` 去查永遠是 null。
 * 這個 API 拿來當「已經加過了嗎」的判斷，會讓冪等檢查永遠不成立、在既有的
 * ios/ 上重跑就長出第二個同名 target。改成直接讀 target 的 name 欄位並去引號，
 * 記憶體中的物件與重新 parse 回來的物件兩種情況都對。
 */
function findTargetUuidByName(project, name) {
  const section = project.pbxNativeTargetSection();
  return (
    Object.keys(section).find(
      (key) =>
        !key.endsWith('_comment') &&
        section[key] &&
        IOSConfig.XcodeUtils.unquote(String(section[key].name)) === name,
    ) || null
  );
}

/**
 * 確保 pbxproj 裡存在某個 section（沒有就建一個空的）。
 *
 * 為什麼需要這個：`xcode@3.0.1` 的 `addTargetDependency()` 最後那段是
 * `if (pbxContainerItemProxySection && pbxTargetDependencySection) { … }` ——
 * 專案裡**還沒有**這兩個 section 時它會**安靜地什麼都不做**，而且照樣回傳一個
 * 看起來成功的物件。CNG 剛 prebuild 出來的專案只有一個 target、`pod install`
 * 也還沒跑，這兩個 section 很可能根本不存在。
 *
 * 少了 target dependency 的後果：Xcode 不知道要先編 extension 才能拷貝
 * `.appex`，Embed 階段可能拿到上一次的產物或直接失敗——而且 build log 上不會
 * 有任何一行提到「你忘了加 dependency」。這是本機合成 pbxproj 實測抓到的。
 */
function ensureSection(project, name) {
  const objects = project.hash.project.objects;
  if (!objects[name]) {
    objects[name] = {};
  }
}

/**
 * 取得某個 target 底下叫做 `comment` 的 build phase 物件。
 *
 * 為什麼不直接用 `project.pbxSourcesBuildPhaseObj(uuid)`：它在該 target 找不到
 * 對應 phase 時會**默默退回專案裡的第一個同名 phase**——也就是主 app 的 Sources。
 * 那會把 extension 的檔案編進主 app、而 extension 一個檔都沒有，錯得非常安靜。
 * 這裡改成找不到就丟例外。
 */
function getBuildPhase(project, targetUuid, comment) {
  const nativeTarget = project.pbxNativeTargetSection()[targetUuid];
  if (!nativeTarget) {
    fail(`找不到 PBXNativeTarget ${targetUuid}。`);
  }
  const entry = (nativeTarget.buildPhases || []).find((phase) => phase.comment === comment);
  if (!entry) {
    fail(`target ${targetUuid} 沒有 "${comment}" build phase。`);
  }
  const section = project.hash.project.objects[`PBX${comment}BuildPhase`];
  const phase = section && section[entry.value];
  if (!phase) {
    fail(`"${comment}" build phase (${entry.value}) 不在 PBX${comment}BuildPhase section 裡。`);
  }
  return phase;
}

/**
 * 把一個 .swift 掛進 group，並讓它出現在 `targetUuids` 每一個 target 的 Sources phase。
 *
 * 一個 PBXFileReference（檔案本身）+ 每個 target 一個 PBXBuildFile（「這個 target 要編它」）。
 * 這就是 Xcode 在 UI 上勾選兩個 Target Membership 時寫進 pbxproj 的形狀。
 */
function addSwiftSource(project, { fileName, targetName, group, targetUuids }) {
  const fileRef = project.generateUuid();
  const basename = fileName;
  // group 本身沒有 path（`ensureGroupRecursively` 建出來的 path 是空的），
  // 所以檔案路徑要從 ios/ 算起，也就是要帶 `EchoWidget/` 這一段。
  const relativePath = `${targetName}/${fileName}`;

  project.addToPbxFileReferenceSection({
    fileRef,
    basename,
    path: relativePath,
    lastKnownFileType: 'sourcecode.swift',
    sourceTree: '"<group>"',
    fileEncoding: 4,
    includeInIndex: 0,
  });
  group.children.push({ value: fileRef, comment: basename });

  targetUuids.forEach((targetUuid) => {
    const buildFileUuid = project.generateUuid();
    // `group: 'Sources'` 只影響 pbxproj 註解文字（"X.swift in Sources"），
    // 但 xcode 套件用它產生註解，寫錯會讓 diff 讀起來很怪。
    const buildFile = { uuid: buildFileUuid, fileRef, basename, group: SOURCES_PHASE };
    project.addToPbxBuildFileSection(buildFile);
    getBuildPhase(project, targetUuid, SOURCES_PHASE).files.push({
      value: buildFileUuid,
      comment: `${basename} in ${SOURCES_PHASE}`,
    });
  });
}

/* --------------------------------------------------------------------------
 * ① 主 app 的 Info.plist
 * -------------------------------------------------------------------------- */

/**
 * 沒有 `NSSupportsLiveActivities` 的話 `Activity.request()` 會直接丟
 * `ActivityAuthorizationError.unsupported`，而且 iOS 設定裡不會出現開關。
 *
 * 刻意**不設** `NSSupportsLiveActivitiesFrequentUpdates`：它只放寬 remote push
 * 的預算，跟我們的本地 `activity.update()` 無關，亂設反而會拉低整體更新預算。
 */
const withLiveActivitiesInfoPlist = (config) =>
  withInfoPlist(config, (cfg) => {
    cfg.modResults.NSSupportsLiveActivities = true;
    return cfg;
  });

/* --------------------------------------------------------------------------
 * ② 主 app 的 entitlements
 * -------------------------------------------------------------------------- */

/**
 * App Group 是 intent 與 app 之間唯一的資料通道，兩邊的 entitlements 都要有它。
 *
 * 用 append + 去重而不是覆寫：陣列可能已經被別的 plugin 放了東西進去，
 * 覆寫等於默默砍掉別人的設定。
 *
 * 刻意**不加** `aps-environment`：那是 push-to-start 才需要的，本輪明確排除。
 */
const withAppGroupEntitlement = (config, { groupIdentifier }) =>
  withEntitlementsPlist(config, (cfg) => {
    const key = 'com.apple.security.application-groups';
    const existing = Array.isArray(cfg.modResults[key]) ? cfg.modResults[key] : [];
    cfg.modResults[key] = existing.includes(groupIdentifier)
      ? existing
      : [...existing, groupIdentifier];
    return cfg;
  });

/* --------------------------------------------------------------------------
 * ③ 複製原生來源 + 寫出 extension 的 entitlements（dangerous mod）
 *
 * mod 的執行順序由 @expo/config-plugins 的 precedences 決定：dangerous(-2) 一定
 * 在 xcodeproj(-1) 之前跑，所以檔案一定先落地、pbxproj 才開始引用它們。
 * -------------------------------------------------------------------------- */

const withNativeSources = (config, { targetName, groupIdentifier }) =>
  withDangerousMod(config, [
    'ios',
    (cfg) => {
      if (cfg.modRequest.platform !== 'ios') return cfg;

      const sourceDir = path.join(cfg.modRequest.projectRoot, 'targets', targetName);
      const destinationDir = path.join(cfg.modRequest.platformProjectRoot, targetName);
      const expectedFiles = [...EXTENSION_ONLY_SOURCES, ...SHARED_SOURCES, INFO_PLIST_FILE_NAME];

      const missing = expectedFiles.filter((name) => !fs.existsSync(path.join(sourceDir, name)));
      if (missing.length) {
        // 少一個檔就整段停下來。讓它在 prebuild 就炸，而不是在 EAS 上編到一半
        // 才出現「找不到型別」——後者的 log 遠、迭代一次數十分鐘。
        fail(`${sourceDir} 缺少：${missing.join(', ')}`);
      }

      // 先清空再複製：ios/ 是拋棄式的，真相永遠在 targets/。留著上一輪的殘檔
      // 會讓「刪掉一個 Swift 檔」這種改動看起來沒有生效。
      fs.rmSync(destinationDir, { recursive: true, force: true });
      fs.mkdirSync(destinationDir, { recursive: true });
      expectedFiles.forEach((name) => {
        fs.copyFileSync(path.join(sourceDir, name), path.join(destinationDir, name));
      });

      // extension 的 entitlements 是**生成物**而不是 targets/ 裡的靜態檔：
      // 它要跟這個 plugin 的 groupIdentifier 選項保持單一真相來源，
      // 靜態檔會讓「改了選項但檔案沒跟著改」這種不一致變成可能。
      fs.writeFileSync(
        path.join(destinationDir, `${targetName}.entitlements`),
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
          '<plist version="1.0">',
          '<dict>',
          '\t<key>com.apple.security.application-groups</key>',
          '\t<array>',
          `\t\t<string>${groupIdentifier}</string>`,
          '\t</array>',
          '</dict>',
          '</plist>',
          '',
        ].join('\n'),
        'utf8',
      );

      return cfg;
    },
  ]);

/* --------------------------------------------------------------------------
 * ④ Xcode 專案（最脆弱的一段）
 * -------------------------------------------------------------------------- */

const withEchoWidgetTarget = (config, options) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const { targetName, deploymentTarget, extensionBundleIdentifier } = options;

    // 冪等：prebuild 有可能在既有的 ios/ 上再跑一次。已經有 target 就整段跳過，
    // 不然會做出兩個同名 target、兩份 Embed 階段。
    if (findTargetUuidByName(project, targetName)) {
      return cfg;
    }

    /*
     * 前置檢查：`project.addTarget()` 內部是拿 `getFirstTarget()`（targets 陣列的
     * 第 0 個）來掛 Embed 階段與 target dependency，它**不會**去找 application
     * 型別的 target。CNG 產出的專案第 0 個就是主 app，但這是慣例不是保證——
     * 萬一哪天不成立，Embed 階段會掛到錯的 target 上，而 build 仍會成功、
     * 只是裝到手機上完全沒有 widget。這種錯誤沒有本機辦法可以事後發現，
     * 所以寧可在這裡直接停。
     */
    const appTarget = project.getTarget(APPLICATION_PRODUCT_TYPE);
    if (!appTarget) {
      fail('在 pbxproj 裡找不到 application 型別的 target。');
    }
    const firstTarget = project.getFirstTarget();
    if (firstTarget.uuid !== appTarget.uuid) {
      fail(
        'pbxproj 的第一個 target 不是主 app（addTarget 會把 Embed App Extensions ' +
          '掛到第一個 target 上）。這個 plugin 的假設不成立，請先手動確認專案結構。',
      );
    }

    // 1) PBXGroup：Xcode 側邊欄裡的資料夾。
    const group = IOSConfig.XcodeUtils.ensureGroupRecursively(project, targetName);
    if (!group) {
      fail(`無法建立 PBXGroup "${targetName}"。`);
    }

    /*
     * 2) PBXNativeTarget。
     *
     * `addTarget(..., 'app_extension', ...)` 除了建 target 之外**還順手做了兩件事**：
     *   · 在第一個 target（= 主 app）上新增一個 `Copy Files` PBXCopyFilesBuildPhase，
     *     `dstSubfolderSpec = 13`（PlugIns），並把 .appex 放進去 ⇒ 這就是
     *     「Embed App Extensions」；
     *   · 加上主 app → extension 的 target dependency。
     * 兩者都是**新增一個 phase**，沒有碰主 app 既有的任何 phase ⇒ 符合「只加不動」。
     * 也因為它已經做了，下面不可以再手動加一次，否則 .appex 會被嵌入兩次。
     *
     * 呼叫前必須先備好這兩個 section，否則 dependency 那一半會靜默失敗（見
     * `ensureSection` 的註解）。
     */
    ensureSection(project, 'PBXTargetDependency');
    ensureSection(project, 'PBXContainerItemProxy');

    const appPhasesBefore = (project.pbxNativeTargetSection()[appTarget.uuid].buildPhases || []).map(
      (phase) => phase.comment,
    );
    const appDependenciesBefore = (
      project.pbxNativeTargetSection()[appTarget.uuid].dependencies || []
    ).length;

    const target = project.addTarget(
      targetName,
      'app_extension',
      targetName,
      extensionBundleIdentifier,
    );

    /*
     * `addTarget` 內部那兩件事都是「成功與否不回報」的路徑，所以這裡把它們驗回來。
     * 這些檢查的成本是零，而它們防的是「pbxproj 看起來正常、build 也綠燈、
     * 裝到手機上卻沒有 widget」——本機沒有 Xcode，那種錯誤我們發現不了。
     */
    const appTargetNow = project.pbxNativeTargetSection()[appTarget.uuid];
    const appPhasesAfter = (appTargetNow.buildPhases || []).map((phase) => phase.comment);
    appPhasesBefore.forEach((name, index) => {
      if (appPhasesAfter[index] !== name) {
        fail(`主 app 既有的 build phase 被動到了（"${name}" → "${appPhasesAfter[index]}"）。`);
      }
    });
    if (appPhasesAfter.length !== appPhasesBefore.length + 1) {
      fail('主 app 的 build phase 數量不是「只多一個」，Embed App Extensions 沒有如預期加上。');
    }
    if ((appTargetNow.dependencies || []).length !== appDependenciesBefore + 1) {
      fail('主 app → EchoWidget 的 target dependency 沒有加上（addTargetDependency 靜默失敗）。');
    }

    // 3) extension 自己的三個 build phase。必須先建 Sources，下面加檔案才有地方放。
    project.addBuildPhase([], 'PBXSourcesBuildPhase', SOURCES_PHASE, target.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
    // Resources 這一輪是空的（沒有 asset catalog、沒有圖片——Live Activity 放圖片
    // 解析度過大會直接啟動失敗，而我們的版面根本不需要圖）。建一個空的是為了讓
    // 之後真的要加資源時不用再改 plugin。
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);

    // 4) 原始碼。三個共用檔同時進兩個 target——這是整個功能能不能運作的關鍵。
    EXTENSION_ONLY_SOURCES.forEach((fileName) => {
      addSwiftSource(project, { fileName, targetName, group, targetUuids: [target.uuid] });
    });
    SHARED_SOURCES.forEach((fileName) => {
      addSwiftSource(project, {
        fileName,
        targetName,
        group,
        targetUuids: [target.uuid, appTarget.uuid],
      });
    });

    // Info.plist 只進 group（讓它在 Xcode 裡看得到），不進任何 build phase——
    // 它是由 INFOPLIST_FILE 這個 build setting 指向的，放進 Resources 會被重複拷貝。
    const infoPlistRef = project.generateUuid();
    project.addToPbxFileReferenceSection({
      fileRef: infoPlistRef,
      basename: INFO_PLIST_FILE_NAME,
      path: `${targetName}/${INFO_PLIST_FILE_NAME}`,
      lastKnownFileType: 'text.plist.xml',
      sourceTree: '"<group>"',
      fileEncoding: 4,
      includeInIndex: 0,
    });
    group.children.push({ value: infoPlistRef, comment: INFO_PLIST_FILE_NAME });

    // 5) 系統框架。已經被別人連結過就跳過（addFramework 自己會回 false）。
    SYSTEM_FRAMEWORKS.forEach((framework) => {
      project.addFramework(framework, { target: target.uuid, link: true });
    });

    /*
     * 6) Build settings。
     *
     * `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` 不准寫死：extension 與主 app
     * 的版號不一致會被 App Store 退件。優先鏡射主 app target 上的設定；Expo 的
     * prebuild 目前是把版號寫進主 app 的 **Info.plist**（不是 build setting），
     * 所以多半鏡射不到，這時退回 app config 的 version / ios.buildNumber ——
     * 那正是 Expo 拿去寫主 app Info.plist 的同一個來源，兩邊因此仍然一致。
     */
    const appBuildSettings = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
      project,
      appTarget.target.buildConfigurationList,
    ).map(([, buildConfig]) => buildConfig.buildSettings || {});

    const mirrorFromApp = (settingName, fallback) => {
      const found = appBuildSettings
        .map((settings) => settings[settingName])
        .find((value) => value != null && IOSConfig.XcodeUtils.unquote(String(value)) !== '');
      return found != null ? found : quoted(fallback);
    };

    const marketingVersion = mirrorFromApp('MARKETING_VERSION', cfg.version || '1.0.0');
    const currentProjectVersion = mirrorFromApp(
      'CURRENT_PROJECT_VERSION',
      (cfg.ios && cfg.ios.buildNumber) || '1',
    );

    const extensionSettings = {
      PRODUCT_BUNDLE_IDENTIFIER: quoted(extensionBundleIdentifier),
      PRODUCT_NAME: quoted(targetName),
      INFOPLIST_FILE: quoted(`${targetName}/${INFO_PLIST_FILE_NAME}`),
      CODE_SIGN_ENTITLEMENTS: quoted(`${targetName}/${targetName}.entitlements`),
      IPHONEOS_DEPLOYMENT_TARGET: quoted(deploymentTarget),
      SWIFT_VERSION: quoted('5.0'),
      TARGETED_DEVICE_FAMILY: quoted('1,2'),
      SKIP_INSTALL: quoted('NO'),
      // extension 自帶手寫的 Info.plist，不要讓 Xcode 再生一份蓋掉它。
      GENERATE_INFOPLIST_FILE: quoted('NO'),
      CLANG_ENABLE_MODULES: quoted('YES'),
      MARKETING_VERSION: marketingVersion,
      CURRENT_PROJECT_VERSION: currentProjectVersion,
    };

    IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
      project,
      target.pbxNativeTarget.buildConfigurationList,
    ).forEach(([, buildConfig]) => {
      buildConfig.buildSettings = { ...buildConfig.buildSettings, ...extensionSettings };
    });

    return cfg;
  });

/* --------------------------------------------------------------------------
 * ⑤ EAS credentials
 * -------------------------------------------------------------------------- */

/**
 * 讓 `eas build` 知道要幫這個 extension 也產一組 provisioning profile，
 * 並在 Apple Developer Portal 上開好 App Group capability。
 *
 * 為什麼寫在 `config.extra` 而不是 `app.json`：鐵律一——這一輪不准動 app.json。
 * plugin 在記憶體裡設進 evaluated config，`eas build` 讀到的就是這一份。
 * 用深層 merge 是為了不要洗掉既有的 `extra.eas.projectId`。
 */
function withEasAppExtension(config, { targetName, groupIdentifier, extensionBundleIdentifier }) {
  const extra = config.extra || (config.extra = {});
  const eas = extra.eas || (extra.eas = {});
  const build = eas.build || (eas.build = {});
  const experimental = build.experimental || (build.experimental = {});
  const ios = experimental.ios || (experimental.ios = {});
  const appExtensions = Array.isArray(ios.appExtensions) ? ios.appExtensions : [];

  const entry = {
    targetName,
    bundleIdentifier: extensionBundleIdentifier,
    entitlements: { 'com.apple.security.application-groups': [groupIdentifier] },
  };

  const existingIndex = appExtensions.findIndex((item) => item && item.targetName === targetName);
  if (existingIndex >= 0) {
    appExtensions[existingIndex] = entry;
  } else {
    appExtensions.push(entry);
  }
  ios.appExtensions = appExtensions;

  return config;
}

/* --------------------------------------------------------------------------
 * 進入點
 * -------------------------------------------------------------------------- */

const withEchoWidget = (config, props) => {
  const options = resolveOptions(config, props);

  // Android 完全不受影響：下面每一個 mod 都只註冊在 mods.ios 底下，
  // 而 appExtensions 是 iOS 專屬的 EAS 設定。這裡不需要（也無法）判斷平台，
  // 平台判斷發生在 mod 執行時。
  const withExtras = withEasAppExtension(config, options);

  return withPlugins(withExtras, [
    [withLiveActivitiesInfoPlist, options],
    [withAppGroupEntitlement, options],
    [withNativeSources, options],
    [withEchoWidgetTarget, options],
  ]);
};

module.exports = createRunOncePlugin(withEchoWidget, 'withEchoWidget', '1.0.0');

// 測試用的內部匯出。plugin 本身仍然是 module.exports 的預設值，
// Expo 只會 require 上面那一個 function。
module.exports.DEFAULT_APP_GROUP = DEFAULT_APP_GROUP;
module.exports.DEFAULT_TARGET_NAME = DEFAULT_TARGET_NAME;
module.exports.DEFAULT_DEPLOYMENT_TARGET = DEFAULT_DEPLOYMENT_TARGET;
module.exports.EXTENSION_ONLY_SOURCES = EXTENSION_ONLY_SOURCES;
module.exports.SHARED_SOURCES = SHARED_SOURCES;
