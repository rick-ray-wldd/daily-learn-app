# `targets/` — 原生 target 的原始碼（EchoWidget）

> **狀態：已備好，尚未啟用。** `app.json` 的 `plugins` 陣列**刻意沒有**加
> `./plugins/withEchoWidget`，所以現在 `expo prebuild` / `eas build` 完全不會碰到這裡的東西。
> 要啟用請照 [§2](#2-要啟用時在-appjson-加哪一行) 做。

這個資料夾放的是 **EchoWidget**：鎖定畫面上的「三選一 + 想不起來」複習卡 Live Activity。
按鈕走 App Intents（`LiveActivityIntent`），使用者按下去時系統會在**背景**啟動 app 行程執行
`perform()`——**不進前景**，但確實會喚醒 app 行程。

> ⚠️ 用字規定：一律寫「**不進前景**」，不准寫「不喚醒 app」。
> Apple 官方對 `LiveActivityIntent` 的說法是「the system runs the app intent in the **app's
> process**」。正因為它跑在 app 行程，才寫得進 App Group、才能 `activity.update()`——
> 純 `AppIntent`（跑在 extension 行程）這兩件事**都做不到**。這是整個設計成立的理由，
> 講錯了會讓人以為我們用的是另一套機制。

---

## 1. 為什麼原生碼放在 `targets/` 而不是 `ios/`

這個 repo 是**純 CNG**（Continuous Native Generation）：`.gitignore` 第 40–41 行擋掉了
`/ios` 與 `/android`，它們根本不在版控裡。

```
# generated native folders
/ios
/android
```

`ios/` 是 `expo prebuild` 的**輸出**。EAS Build 每一次都是從乾淨的機器 clone repo → 跑 prebuild
→ 編譯，所以 `ios/` 每一次都是**全新生成**的。在 `ios/` 裡手改任何東西：

- 本機看起來會動（因為你的 `ios/` 還在），
- EAS 上一定不見（因為它的 `ios/` 是剛生出來的），
- 而且你下一次 `expo prebuild --clean` 也會把自己的修改洗掉。

所以真相來源永遠是 **`targets/EchoWidget/`**，`ios/EchoWidget/` 是 `plugins/withEchoWidget.js`
在 prebuild 當下複製出去的副本。plugin 複製前會先 `rm -rf ios/EchoWidget`，確保不會留下上一輪的殘檔。

**推論：改 Swift 一律改 `targets/EchoWidget/` 底下的檔，然後重跑 prebuild / build。**

### 檔案分工

| 檔案 | 進哪個 target | 職責 |
| --- | --- | --- |
| `EchoWidgetBundle.swift` | 只有 extension | `@main WidgetBundle` |
| `EchoReviewLiveActivity.swift` | 只有 extension | SwiftUI 版面（五種呈現形態） |
| `EchoWidgetColors.swift` | 只有 extension | 寫死的深色配色（`lib/theme.ts` 的手抄副本） |
| `EchoReviewAttributes.swift` | **extension + 主 app** | `ActivityAttributes` 資料契約 |
| `EchoAppGroup.swift` | **extension + 主 app** | App Group 讀寫、所有共用常數 |
| `EchoAnswerIntent.swift` | **extension + 主 app** | `LiveActivityIntent`，按鈕真正做的事 |
| `Info.plist` | extension | `NSExtensionPointIdentifier = com.apple.widgetkit-extension` |

> 🔑 **下面三個檔同時編進兩個 target，這不是冗餘、是必要條件。**
> Apple 規定 `LiveActivityIntent` 必須存在於 **app target**（系統在 app 行程裡執行它）；
> extension 那一份只是為了讓 `Button(intent:)` 通過型別檢查。
> **漏掉主 app 那一份，按鈕會正常顯示、按下去卻什麼都不會發生**——而且不會有任何錯誤訊息。

`EchoWidget.entitlements` **不在這個資料夾**，它是 plugin 在 prebuild 時生成的
（`ios/EchoWidget/EchoWidget.entitlements`）。理由：它的內容必須跟 plugin 的 `groupIdentifier`
選項保持單一真相來源，做成靜態檔就會出現「改了選項但檔案沒跟著改」。

---

## 2. 要啟用時在 `app.json` 加哪一行

**只有一處要改**——`plugins` 陣列末尾加一筆。現況是 `["expo-audio", "expo-asset", "expo-status-bar"]`：

```jsonc
"plugins": [
  "expo-audio",
  "expo-asset",
  "expo-status-bar",
  ["./plugins/withEchoWidget", {
    "groupIdentifier": "group.com.rickray.echo",
    "targetName": "EchoWidget",
    "deploymentTarget": "17.0"
  }]
]
```

三個選項都有預設值（就是上面那三個），所以 `"./plugins/withEchoWidget"` 單獨寫也可以；
寫全是為了讓 `app.json` 自己說明 App Group id 是什麼——那個字串在三個地方各有一份。

**不需要**手動加的東西（plugin 都會處理）：

- `ios.infoPlist.NSSupportsLiveActivities` → plugin 寫。
  （刻意**不設** `NSSupportsLiveActivitiesFrequentUpdates`：它只放寬 remote push 的預算，
  跟本地 `activity.update()` 無關，亂設反而拉低整體預算。）
- 主 app entitlements 的 `com.apple.security.application-groups` → plugin append（不覆寫、會去重）。
- EAS 的 `extra.eas.build.experimental.ios.appExtensions` → plugin 在記憶體裡設進 `extra`。

### 三處必須一致的命名

改一處就要改三處，跨語言沒有共用常數的辦法：

| 東西 | 值 | 出現在 |
| --- | --- | --- |
| App Group id | `group.com.rickray.echo` | `EchoAppGroup.identifier`、`withEchoWidget.js` 的 `DEFAULT_APP_GROUP`、`lib/liveActivity.ts` 的 `APP_GROUP_ID` |
| 主 app bundle id | `com.rickray.echo` | `app.json`（extension 的 bundle id 由它衍生） |
| Extension bundle id | `com.rickray.echo.EchoWidget` | plugin 生成 |
| 答案目錄 | `live-activity-answers` | Swift / JS 各一份常數 |

---

## 3. 啟用後 OTA 的界線在哪

**這一段是未來最容易鬼打牆的地方，請先讀完再動手。**

| 改了什麼 | OTA（`eas update`）夠嗎 | 為什麼 |
| --- | --- | --- |
| `lib/`、`screens/`、`App.tsx` 等 JS/TS | ✅ 夠 | OTA 更新的就是 JS bundle |
| `targets/EchoWidget/*.swift` | ❌ **一定要重 build** | Swift 是編進 `.appex` 二進位的，OTA 根本不含原生碼 |
| `plugins/withEchoWidget.js` | ❌ **一定要重 build** | 它只在 prebuild 時執行 |
| `app.json` 的 `plugins` / entitlements | ❌ **一定要重 build** | 同上 |

本 repo 已經有「顯示執行中的 bundle 版本 + 手動檢查更新」（commit `d45c472`）。
**不要**因為看到 bundle 版本更新了就以為鎖定畫面也跟著更新了——那是兩件事。

### ⚠️ 更危險的一條：`runtimeVersion.policy: "sdkVersion"`

`app.json` 目前是：

```jsonc
"runtimeVersion": { "policy": "sdkVersion" }
```

加一個 native target **不會**改變 runtimeVersion（SDK 版本沒變）。後果是：

> **新的 JS bundle 會被 OTA 推到「還沒有 EchoWidget extension」的舊 build 上。**

那些 app 裡沒有原生模組、沒有 extension、`Activity<>` 也不存在。所以：

- **所有原生呼叫都必須 feature-detect**，模組不在就整段跳過，不准 crash。
  `lib/liveActivity.ts` 的 `checkEligibility()` 就是為此存在
  （`'native-module-missing'` / `'ios-too-old'` / `'activities-disabled'`）。
- 這與 `lib/selection.ts` 檔頭記載的「JS bundle 一定比 SQL 早到」是同一類風險。
- 如果哪天想讓兩者強制對齊，得改成 `runtimeVersion.policy: "appVersion"` 或手動指定字串——
  那是另一個決策，要先寫 ADR。

---

## 4. Xcode 到位後的第一次驗證步驟

**本機現在沒有 Xcode（只有 Command Line Tools），以下每一步都還沒做過。**

```
xcode-select -p   → /Library/Developer/CommandLineTools
xcodebuild -version → 報錯
/Library/Developer/CommandLineTools/SDKs/ → 只有 MacOSX*.sdk，沒有任何 iPhoneOS SDK
```

### 4.0 先跑：不需要 Xcode 的四件事（每次改完都該跑）

```bash
cd app
npx tsc --noEmit                                    # 必須通過
npx expo export --platform ios                      # 必須通過
node -e "console.log(Object.keys(require('./package.json').dependencies).length)"   # 必須是 14
node --check plugins/withEchoWidget.js              # plugin 的語法
```

### 4.1 在 repo 外的拋棄式副本跑 prebuild

**不要**在這個 repo 裡跑 `expo prebuild`——它會生出 `ios/`，雖然被 `.gitignore` 擋著，
但之後很容易誤以為那是可以手改的東西。

```bash
cp -R app /tmp/echo-prebuild && cd /tmp/echo-prebuild
# ① 先在 /tmp 這一份的 app.json 加上 §2 那一行（正本不要改）
npx expo prebuild --platform ios --no-install --clean
```

跑完要**逐項**檢查（這是 plugin 有沒有做對事的第一個真實訊號）：

```bash
ls ios/EchoWidget/                     # 6 個 .swift + Info.plist + EchoWidget.entitlements
plutil -p ios/EchoWidget/EchoWidget.entitlements   # 應含 group.com.rickray.echo

# 主 app 的 Info.plist 是 ios/<name>/Info.plist（name = app.json 的 "Echo"）。
# **不是** ios/Echo/Supporting/Info.plist —— Supporting/ 底下只有 Expo.plist，
# 那個路徑 plutil 會回 "file does not exist"，接上 grep 之後輸出為空，
# 看起來就像「NSSupportsLiveActivities 沒寫進去」。
plutil -p ios/Echo/Info.plist | grep -i liveactivit   # NSSupportsLiveActivities => 1

# 雙 target 共用檔（3 個）
grep -c "EchoAnswerIntent.swift in Sources" ios/Echo.xcodeproj/project.pbxproj   # 必須是 4
# 對照組：extension-only 的檔（3 個）
grep -c "EchoWidgetColors.swift in Sources" ios/Echo.xcodeproj/project.pbxproj   # 必須是 2
```

> 那組 `4` / `2` 是這一節最重要的數字，但**很容易讀反**，所以講清楚它從哪來：
>
> 一個檔進一個 target = **1 個 `PBXBuildFile`**，而每個 `PBXBuildFile` 的註解
> `/* X.swift in Sources */` 會在 pbxproj 裡出現**兩行**——一行是 `PBXBuildFile`
> section 的定義、一行是該 target `Sources` phase 的 `files` 清單。所以：
>
> | 這個檔進了幾個 target | `PBXBuildFile` 數 | `grep -c` |
> | --- | --- | --- |
> | extension + 主 app（正確） | 2 | **4** |
> | 只有 extension（**壞掉**） | 1 | **2** |
>
> 也就是說 **`2` 正好是壞掉那個形狀的簽名**：按鈕會顯示、按下去毫無反應、build 全綠。
> 這個對照關係是在**真實的 SDK 57 模板 pbxproj** 上實跑 plugin 的 `withXcodeProject`
> mod 量出來的（2026-08-13）：三個共用檔全是 4、三個 extension-only 檔全是 2。

接著用 Xcode 打開 `ios/Echo.xcworkspace`（記得先 `npx pod-install`）：

- Target 清單裡有 `Echo` 與 `EchoWidget`；
- 選 `EchoAnswerIntent.swift` → 右側 Target Membership **兩個都打勾**；
- `Echo` target → Build Phases → 最後有一個 `Copy Files`（Destination = **PlugIns**）含 `EchoWidget.appex`；
- `Echo` target → Build Phases → **既有的 phase 順序完全沒變**（尤其 `Embed Frameworks` 與
  `Bundle React Native code and images`）；
- `EchoWidget` target → Build Settings → Deployment Target = 17.0、主 app 仍是 16.4。

### 4.2 第一次真機驗證要看的東西（依風險排序）

1. `Cmd+R` 跑主 app → **app 能正常啟動**。若 dyld 報
   `Library not loaded: ReactNativeDependencies.framework` 就是 Embed 階段被破壞了
   （見 §6 的 apple-targets #194），立刻停手改走 Plan B。
2. 前景啟動一個 Live Activity → 鎖定畫面上**看得到卡片**、四顆按鈕都在、**高度沒有被截斷**。
3. 按一顆選項 → 卡片換到下一題（`3/5` → `4/5`）。
4. **殺掉 app** → 再按一顆 → 卡片仍然會更新，且
   `<AppGroupContainer>/live-activity-answers/` 多一個 `<uuid>.json`。
   **這一步是整個功能的存在意義**，前三步都成功但這步失敗＝這個設計不成立。
5. 裝置**鎖著**（Face ID 已辨識但還沒上滑）時按按鈕會怎樣——見 §7 第 1 條，官方文件沒有明確答案。

---

## 5. 第一次 `eas build` 會發生什麼

```bash
eas build --profile preview --platform ios
```

第一次跑會多做幾件事，**有可能是互動式的**（別在快沒時間的時候第一次跑）：

1. **新的 bundle id `com.rickray.echo.EchoWidget` 會被註冊進 Apple Developer Portal**。
2. 主 app 與 extension 兩邊都要開 **App Group capability**，並把
   `group.com.rickray.echo` 建起來 / 綁上去。
3. **兩組 provisioning profile 會重新產生**（主 app 的那一組也會，因為 entitlements 變了）。
4. `extra.eas.build.experimental.ios.appExtensions` 就是讓 EAS 知道要做 2、3 的依據——
   它由 plugin 在記憶體裡設進 `extra`，**不在 `app.json` 裡看得到**。找不到設定時先確認 plugin
   有沒有被載入（`npx expo config --type public | grep -A 10 appExtensions`）。

### Expo Go / dev build 的落差（現在就有的坑）

- **Expo Go 不可能顯示 Live Activity。** 它是別人簽的 app、沒有我們的 entitlements、更沒有
  我們的 extension。在 Expo Go 裡測這個功能是浪費時間。
- 要在實機上邊改 JS 邊看 Live Activity，需要 **dev build**——而 `eas.json` 的 `development`
  profile 雖然寫了 `"developmentClient": true`，**`package.json` 裡並沒有 `expo-dev-client`**。
  補上它會讓 dependencies **14 → 15**（本輪的硬性上限是 14，所以這一輪沒補）。
- 折衷做法：用 `preview` profile（`distribution: internal`）出一個 internal build 裝上去驗證原生行為，
  JS 迭代照舊走 `eas update --channel preview`。

---

## 6. 退路（Plan B / C / D）

**每嘗試一級，就在下面的表格補一列：日期 + 失敗訊息。** 沒有記錄的嘗試等於沒發生過。

| 日期 | 嘗試了什麼 | 結果 / 失敗訊息 |
| --- | --- | --- |
| 2026-08-13 | Plan A：自寫 `withEchoWidget.js`，在合成 pbxproj 上實跑 | pbxproj 操作全數通過（見 §7 的「已驗證」）。**尚未在真實 prebuild / EAS 上跑過。** |

### Plan A（現行）— 自寫 config plugin + 自寫 Swift

選它的決定性理由是**新增 dependency = 0**：`expo/config-plugins` 是 `expo` 套件的公開 entry
point、`xcode@3.0.1` 本來就在 top-level `node_modules`，兩者都可解析。三個第三方方案任一都會讓
dependencies 變成 15。

被否決的方案：

| 方案 | 為什麼不用 |
| --- | --- |
| `expo-widgets` 57.0.9（Expo 第一方） | 它的 Live Activity 按鈕 `perform()` 只發一個行程內的 `NotificationCenter` 事件：不執行 onPress、不寫 App Group、不更新 activity。**answer readback 這條路不存在。** |
| `@bacons/apple-targets` 5.0.0 | issue #194（2026-05）：RN 0.83+ 加 widget extension 會破壞主 app 的 Embed Frameworks phase，`Library not loaded: ReactNativeDependencies.framework`，啟動即被 dyld 殺。**我們是 RN 0.86。** |
| `react-native-widget-extension` 0.3.0 | 形狀最接近（使用者的 Swift 會編進主 app target），但直接依賴 `@expo/config-plugins ~56.0.0`（SDK 57 專案裡會並存第二份）。**留作 Plan B。** |
| `software-mansion-labs/expo-live-activity` | GitHub repo 已封存（archived）。 |
| `expo-app-intents` | npm 上只有 0.0.1 佔名。 |

### Plan B — `react-native-widget-extension`

`targets/EchoWidget/` 的 Swift 幾乎可以原封不動搬過去：把 `EchoAnswerIntent.swift` +
`EchoAppGroup.swift` + `EchoReviewAttributes.swift` 併成它要的 `Module.swift`，其餘放進
`widgetsFolder`。代價：dependencies 14 → 15、第二份 `@expo/config-plugins`、EAS `appExtensions`
要自己寫。

### Plan C — 只拿 `expo-widgets` 做 demo

用它的 `banner` slot 畫版面、`addUserInteractionListener` 收 `{source, target, timestamp}`。

> 🚨 **這條路的訊號不可信。** 那是無佇列、無持久化的 `NotificationCenter`；JS runtime 沒起來的
> 那一按會**靜默丟失**。
> 可以拿去 Pre-Demo Day 的 12 分鐘展示，**絕不可以**進 SRS 帳本，
> **絕不可以**在 pitch 裡講「每一次按壓都被接住」——那正是本專案的核心主張，講錯的代價比技術債高。

### Plan D — 這一輪就砍掉

Live Activity 不是 8/17 的必要條件。既有的每日通知（`lib/notifications.ts`）已經覆蓋「提醒」這個功能。

---

## 7. 已驗證 / 未驗證清單（誠實版）

### ✅ 已在本機實跑驗證（2026-08-13）

在一份**合成的** Expo 風格 pbxproj（單一 application target，含 `Sources` / `Frameworks` /
`Resources` / RN 的 shell script / `Embed Frameworks` 五個 phase）上實際執行 plugin 的每一個 mod，
斷言全數通過：

- 主 app 既有的 5 個 build phase **順序與內容完全沒變**，只多出一個 `Copy Files`；
- 那個 `Copy Files` 的 `dstSubfolderSpec = 13`（PlugIns）且含 `EchoWidget.appex`；
- 原本的 `Embed Frameworks`（`dstSubfolderSpec = 10`）沒被動到；
- 主 app 多出 1 條 target dependency；
- extension 有 `Sources` / `Frameworks` / `Resources` 三個 phase、6 個 `.swift`、4 個系統框架；
- 主 app 的 `Sources` **只多 3 個共用檔**，另外 3 個 extension-only 的檔沒有跑進去；
- `EchoAnswerIntent.swift` = **1 個 `PBXFileReference` + 2 個 `PBXBuildFile`**（雙 target 的正確形狀）；
- extension 的 build settings 全部如規格（bundle id / `INFOPLIST_FILE` / `CODE_SIGN_ENTITLEMENTS` /
  `IPHONEOS_DEPLOYMENT_TARGET=17.0` / `SKIP_INSTALL=NO` / `GENERATE_INFOPLIST_FILE=NO` /
  `TARGETED_DEVICE_FAMILY="1,2"`），主 app 的 deployment target 仍是 16.4；
- `project.writeSync()` 的輸出可以被 `parseSync()` 重新讀回來；
- 在已經有 target 的專案上再跑一次 mod 是 **no-op**（冪等）；
- `Info.plist` 得到 `NSSupportsLiveActivities = true`、且**沒有** `…FrequentUpdates`；
- entitlements 是 **append 而非覆寫**（既有的其他 group 保留）且重複執行不會長出重複項；
- 生成的 `EchoWidget.entitlements` 可以被 plist parser 反解成預期的結構；
- 四個 guard 都會擋下來：缺 `ios.bundleIdentifier`、`targets/EchoWidget` 缺檔、
  找不到 application target、application target 不在 `targets[0]`；
- `extra.eas.build.experimental.ios.appExtensions` 的形狀（`targetName` / `bundleIdentifier` /
  `entitlements`）與 Expo 官方 [build-reference/app-extensions](https://docs.expo.dev/build-reference/app-extensions/)
  的範例逐鍵一致，且既有的 `extra.eas.projectId` 沒有被洗掉。

**過程中抓到並修掉的兩個 `xcode@3.0.1` 靜默失敗**（都會造成「build 全綠但功能壞掉」）：

1. `addTargetDependency()` 在專案還沒有 `PBXTargetDependency` / `PBXContainerItemProxy`
   section 時會**什麼都不做**，而且照樣回傳看起來成功的物件。剛 prebuild 出來、`pod install`
   還沒跑的專案很可能正是這個狀態。→ plugin 在 `addTarget()` 之前先建好這兩個 section，
   事後再斷言 dependency 數量有 +1。
2. `pbxTargetByName('EchoWidget')` 永遠回 `null`，因為它比對的是**帶引號**的註解
   `"EchoWidget"`。原本拿它當冪等判斷，會導致在既有的 `ios/` 上重跑就長出**第二個同名 target**。
   → 改成自己讀 target 的 `name` 欄位並去引號。

### ✅ 追加驗證：在**真實**的 SDK 57 模板 pbxproj 上跑同一個 mod（2026-08-13，複查後）

上面那批是在**合成**專案上做的。複查指出 §4.1 的驗收數字寫反了，所以把
`node_modules/expo/template.tgz` 解出來、直接拿
`ios/HelloWorld.xcodeproj/project.pbxproj` 餵給 plugin 的 `withXcodeProject` mod：

- 三個共用檔（`EchoAnswerIntent` / `EchoAppGroup` / `EchoReviewAttributes`）
  各 **2 個 `PBXBuildFile`**，`grep -c "… in Sources"` = **4**；
- 三個 extension-only 檔各 **1 個 `PBXBuildFile`**，`grep -c` = **2**；
- 主 app（`HelloWorld`）的 `Sources` phase 從 1 筆變 4 筆且含 `EchoAnswerIntent`，
  extension 的 `Sources` 是 6 筆。

§4.1 原本寫「必須是 2」——那正好是「只編進 extension」的壞掉形狀，會放行壞 build、
否決好 build。已改成 4，並補上 extension-only 的對照組。

> ⚠️ 這只證明 **pbxproj 的形狀**在真實模板上也對。它**不是** `expo prebuild` 跑過
> （沒有 HelloWorld → Echo 的改名、沒有 CocoaPods、沒有 `ExpoModulesProvider.swift`），
> 更不是編譯。下面 ❌ 清單的第 3 條仍然成立，只是範圍縮小了一點。

### 🔁 複查後改掉的兩個設計缺陷（2026-08-13）

兩者都是「build 全綠、畫面正常、資料默默錯掉」那一類，所以記在這裡而不只是 commit message：

1. **按鈕現在帶著座標，不只帶 cardId。**
   `EchoAnswerIntent` 多了 `deckId` 與 `cardIndex` 兩個 `@Parameter`，`perform()` 要求
   三者都與 App Group 當下那份快照對得上才記帳。原因：`deck_id = deck_date` 只有**日**
   的粒度，同一天內 app 重算佇列、把新的一副寫回同一個 `DECK_KEY` 之後 deckId 沒變，
   舊按鈕的答案會被記到新牌的新位置上（游標跳號、結算宣稱「5 張複習完了」而使用者
   只看過 2 張）；跨日則是 ADR-0011 的 carryover 讓同一個 capture 昨天 index 3、
   今天 index 0，而昨天的 activity 要到今天 08:00 才 stale。
   對不上時不再只是靜靜 return：會把**那顆按鈕所屬的**那張 activity 標成過期，
   版面切到「打開 Echo 更新今天的卡」，使用者至少知道下一步。
2. **`answer_id` 從 UUID 改成 `(deck_id, card_id)` 的穩定鍵。**
   原本每按一次就給一個新 UUID，於是「按了沒反應再按一顆」會產出同一張卡的**兩筆**
   矛盾紀錄（`unknown`/false 與 `a`/true），而收割端只認 `answer_id` 去重、兩筆都放行——
   `answered` 大於 `deck_length`、同一張卡同時被算成答對與想不起來。改成穩定鍵之後
   「一張卡最多一筆帳」是檔案系統層級的不變式（同名檔），`appendAnswer` 另加
   first-write-wins（第一次按下的才是真實訊號）。按鈕也補上 `.invalidatableContent()`，
   讓系統在 intent 執行中畫出等待狀態，從源頭少一點連按。
   > 📌 **跨語言待辦**：`lib/liveActivity.ts` 的 `LiveActivityAnswer.answer_id` 註解仍寫
   > 「UUID」。驗證邏輯只要求非空字串所以**不會壞**，但那行字該由 `lib/` 的擁有者改成
   > 「穩定鍵」。`deleteAnswers(answerIds)` 的「刪 `<answer_id>.json`」對應沒有變。

### ⚠️ 對規格的一處刻意偏離

規格 §5.3 把「Embed App Extensions」列為要**手動新增**的第 7 件事。實際讀 `xcode@3.0.1` 的原始碼後
發現 `project.addTarget(name, 'app_extension', …)` **內部已經做了**這件事（在第一個 target 上新增
`Copy Files` phase、`dstSubfolderSpec = 13`、放入 `.appex`），也已經加了 target dependency。
再手動加一次會讓 `.appex` 被嵌入兩次。所以 plugin 只呼叫 `addTarget` 並**驗證結果**，沒有手動建 phase。
兩者都是「新增一個 phase」、沒有碰主 app 既有的任何 phase，仍然符合「只加不動」。

### ❌ 完全沒有驗證過的事（依風險排序）

| # | 沒驗證的事 | 為什麼重要 | 什麼時候才知道 |
| --- | --- | --- | --- |
| 1 | 鎖定畫面上、**Face ID 已辨識但尚未上滑**的狀態下按鈕能不能觸發 intent | Apple 官方：「On a locked device, buttons and toggles are inactive and the system doesn't perform actions unless a person authenticates and unlocks their device.」若每題都要主動解鎖，「鎖屏秒答」的賣點基本不成立，要改成動態島展開作答或回 app 內。官方文件與論壇都**沒有**明確答案。 | 真機 |
| 2 | `LiveActivityIntent` 背景喚醒 Expo/RN app 行程時，會不會連帶冷啟 Hermes + 載入整包 JS bundle | 若會，背景視窗可能不夠、或被 jetsam 回收，答案還沒寫完就被砍。找不到任何一手文件說明 Expo 在背景啟動時是否短路 RN 初始化。**這是本設計最大的未驗證假設。**（`perform()` 是純 Swift，但 app 行程的啟動路徑不是我們控制的。） | 真機 |
| 3 | plugin 產生的 pbxproj 能不能 archive | pbxproj 的**形狀**已經在真實 SDK 57 模板上量過（見上面的「追加驗證」），但那份模板還沒跑過 `expo prebuild`：沒有改名、沒有 CocoaPods 的 `Pods` 群組、沒有 `.xcconfig` / `ExpoModulesProvider.swift`，而且完全沒有編譯這回事。 | 第一次 prebuild / `eas build` |
| 4 | Embed 階段有沒有意外破壞 RN 0.86 的 SPM framework 嵌入 | apple-targets #194 的死法（啟動即被 dyld 殺）。我們是「只加不動」，理論上不會踩到，但**沒有任何本機方法可以證明**。 | 第一次真機啟動 |
| 5 | 160pt 高度是否塞得下 header + 回饋列 + 題目 + 三選項 + 逃生口 | 超過會被系統截斷；中文按鈕在窄欄會截字。 | 真機 / 模擬器量測 |
| 6 | App Group 容器在**背景喚醒的 intent 行程**裡是否如預期可寫 | 理論上 app 行程可寫（Apple DTS 的限制是針對 extension 行程），但沒實測過這個場景下的 file protection 行為。 | 真機 |
| 7 | `activity.update()` 在 iOS 18+ 的節流預算下是否每次點擊都生效 | 每次點擊只 update 一次、間隔以秒計，理論上遠在預算內，但預算是裝置層級的動態值、Apple 不公布。 | 真機 |
| 8 | EAS 首次 build 的 credentials 流程（新 bundle id、App Group capability、profile 重產） | 常見的 build 失敗來源，可能是互動式的。 | 第一次 `eas build` |
| 9 | extension 與主 app 的 `CFBundleVersion` 在 `appVersionSource: "remote"` + `autoIncrement` 下是否真的一致 | 不一致會被 App Store 退件。**額外的疑點**：Expo SDK 57 是把版號寫進主 app 的 **Info.plist**，不是 `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` build setting——本機在 `node_modules/@expo/config-plugins` 與 `@expo/prebuild-config` 裡都**搜不到**這兩個字串。所以 plugin 是「主 app target 有就鏡射、沒有就退回 app config 的 `version` / `ios.buildNumber`」，而 app config 正是 Expo 拿去寫主 app Info.plist 的同一個來源。這條退路**沒有在真實專案上驗證過**。 | 第一次 submit |
| 10 | 測試機 / demo 機的 iOS 版本是否 ≥ 17.0 | 低於 17.0 按鈕不會出現或不作用。16.4–16.9 會看到一張**沒有按鈕、無法作答**的卡——比不顯示更糟。`checkEligibility` 回 `'ios-too-old'` 時應該**完全不啟動**。 | demo 前確認裝置 |
| 11 | **Swift 程式碼能不能編譯** | 本機沒有 Xcode、沒有 iOS SDK。`swiftc -parse` 只證明語法合法（它連不存在的 module 都放行），`swiftc -typecheck` 必定失敗（缺 SDK）。**任何「Swift 已驗證可編譯」的說法都是不實陳述。** | 第一次 build |
| 12 | `.invalidatableContent()` 在 **Live Activity 的鎖定畫面版面**上實際會畫成什麼樣 | iOS 17+ WidgetKit 的標準 API，用途正是「intent 執行中的等待態」，但**呈現方式由系統決定**，也可能什麼都不畫。若真的沒有可見回饋，連按仍會發生——所幸帳本那側有穩定 `answer_id` + first-write-wins 兜底，最壞情況只是使用者體感差，資料不會壞。 | 真機 |
| 13 | 座標對不上時的 `resyncStaleActivity()` 路徑 | 它會多做一次 `activity.update()`（把該 activity 標成 stale）。單次點擊仍只有一次 update，理論上不吃額外預算；但「按到一顆座標對不上的按鈕」這個情境本身就沒辦法在本機造出來。 | 真機 |
| 14 | **同一天內 app 重算佇列**時，鎖定畫面上那張 activity 由誰負責重新對齊 | 座標守門只保證「對不上就不記帳」，**沒有**保證畫面會自動換成新牌的第一張。JS 端在寫新的 `DECK_KEY` 之後應該同時 `update` 或 `end` 現有的 activity——那是下一輪原生模組的事，這一輪連原生模組都還不存在。 | 原生模組落地時 |

---

## 8. 明確不要做的事

1. **不要**手改 `ios/` 底下任何東西——包括 `ios/EchoWidget/`。改 `targets/EchoWidget/`。
2. **不要**在 `targets/EchoWidget/` 放 `Assets.xcassets` 或任何圖片。Live Activity 的圖片解析度過大會導致啟動失敗，而這個版面不需要圖。
3. **不要**在 extension 加任何 pod。它只用系統框架（WidgetKit / SwiftUI / ActivityKit / AppIntents），所以 plugin 完全不碰 Podfile。
4. **不要**提高主 app 的 deployment target（維持 16.4）。extension 自己是 17.0。
5. **不要**移除、重排、或重建主 app 既有的任何 build phase。
6. **不要**實作 push-to-start（需 iOS 17.2+、APNs server、token budget 管理），本輪明確排除。
7. **不要**讓鎖屏答題推進 SRS：不呼叫 `gradeSrsItem`、不把 capture 標成 `practiced`、不計入 daily session 完成度或北極星。一次鎖屏點擊的證據強度遠低於練習頁的完整流程（重聽 → 揭露 → 跟讀 → 自評），把它算成完成等於用一次點擊灌水北極星。**這件事應該寫成 ADR-0021。**
8. **不要**讓分母變成 10。分母是 `deck.cards.length`，硬性 ≤ 5（ADR-0011 的 N=5）。
9. **不要**在任何文件、註解、pitch 裡寫「四選一」——正式名稱是 **「三選一 + 想不起來」**（3 個選項 + 1 個逃生口，猜對率 33%）。
