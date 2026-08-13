# RUNBOOK — 把 EchoWidget 從「檔案備好」推到「鎖定畫面上真的能按」

> **這份文件寫給 Xcode 到位之後的自己。** 從上往下照做，每一步都有「打什麼指令」與
> 「看到什麼才算過」。**不要跳步**——每一步都是下一步的前提，而且順序是按「發現問題的
> 成本」由低到高排的（純語法 → 型別 → pbxproj 形狀 → 模擬器 → 真機 → EAS）。

## 這份文件與 `README.md` 的分工

| 檔案 | 是什麼的真相來源 |
| --- | --- |
| `README.md` | **為什麼**：設計理由、檔案分工、Plan B/C/D、已驗證／未驗證的完整帳本 |
| `RUNBOOK.md`（本檔） | **怎麼做**：照什麼順序打什麼指令、看到什麼才算過、卡住怎麼辦 |
| `docs/adr/0021-*.md` | **決定本身**：為什麼是 App Intent、為什麼不能 OTA、審查風險 |

兩邊都出現的數字（那組 `4` / `2`）以**本檔第 4 步**為準，改了要順手改 `README.md` §4.1。

---

## 起點：現況快照（2026-08-13，本機實測）

```
xcode-select -p                → /Library/Developer/CommandLineTools
xcodebuild -version            → error: tool 'xcodebuild' requires Xcode
xcrun simctl                   → error: unable to find utility "simctl"
/Library/Developer/CommandLineTools/SDKs/  → 只有 MacOSX*.sdk，沒有任何 iPhoneOS SDK
swiftc --version               → Apple Swift 6.0.3，Target: arm64-apple-macosx15.0
eas-cli                        → 18.9.1
app.json 的 plugins            → ["expo-audio", "expo-asset", "expo-status-bar"]（沒有 withEchoWidget）
```

**所以現況是：`targets/` 與 `plugins/` 底下的東西完全不會被任何建置流程碰到。**
`expo prebuild` / `eas build` 現在跑起來跟這個資料夾不存在沒有兩樣。

以下所有指令的工作目錄除非特別標明，都是：

```bash
# 從 repo 內任何位置都成立，換機器也不用改
APP="$(git rev-parse --show-toplevel)/app"
cd "$APP"
```

---

## 第 0 步 — 不需要 Xcode 的四道閘（每次改完都跑，30 秒）

```bash
cd "$APP"
npx tsc --noEmit                                    # 必須通過
npx expo export --platform ios                      # 必須通過
node -e "console.log(Object.keys(require('./package.json').dependencies).length)"   # 必須是 14
node --check plugins/withEchoWidget.js              # plugin 的語法
```

> ⚠️ **`expo export` 通過不代表 `lib/liveActivity.ts` 是對的。** 現在沒有任何檔 import 它，
> 所以它不在 Metro 的 graph 裡、也不在輸出的 `.hbc` 裡——改壞了 export 照樣全綠。
> 真正涵蓋它的只有 `tsc --noEmit`。等 JS 端接上原生模組之後這個洞才會自動補起來。

---

## 第 1 步 — 裝完 Xcode 的驗證指令（10 分鐘）

裝好 Xcode 之後**第一件事是切 developer directory**，否則所有 `xcrun` 還是指向 CLT：

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcode-select -p                              # → /Applications/Xcode.app/Contents/Developer
xcodebuild -version                          # → 有版本號就對了
xcrun --sdk iphoneos --show-sdk-version      # → 必須有輸出（這就是本機終於有 iOS SDK 的證明）
xcrun simctl list runtimes | grep iOS        # → 至少要有一個 iOS ≥ 17.0 的 runtime
```

**最後一行很重要**：Xcode 預設不一定裝了模擬器 runtime。沒有 iOS ≥ 17.0 的 runtime，
第 5 步整步做不了（按鈕是 iOS 17+ 的 API）。缺的話去 Xcode → Settings → Components 裝。

### 1.1 第一次真正的 Swift 型別檢查 ← **這一步是本 runbook 最划算的一步**

到今天為止，Swift 只通過 `swiftc -parse`（純語法，不解析 module）。有了 iOS SDK 之後，
**不需要任何 Xcode 專案**就能做第一次真型別檢查：

```bash
cd "$APP"
swiftc -typecheck \
  -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -target arm64-apple-ios17.0-simulator \
  targets/EchoWidget/*.swift
```

- **六個檔要一起餵**，它們互相引用（`EchoAnswerIntent` 用 `EchoAppGroup`、
  `EchoReviewLiveActivity` 用 `EchoReviewAttributes`），單檔跑會冒出一堆假錯。
- 若 `EchoWidgetBundle.swift` 的 `@main` 在這個模式下報錯，把它排除、其餘五個先過，
  再單獨 `-parse` 它——`@main` 要有完整的 target 才有意義。
- **預期會在這裡第一次看到的錯**（本機從來沒有機會知道對不對）：
  `.invalidatableContent()`、`activity.content.state`、`@Parameter` 用 `Int`
  這三個 API 的正確性（`README.md` §7 的 ❌ 第 12–14 條）。

過了這一步，「Swift 能不能編譯」這個問題就從**完全未知**降級成「還沒連結、還沒跑起來」。
**在這之前不要開始第 3 步**——prebuild 出來的專案編不過時，你會分不清是 Swift 的錯還是
plugin 的錯。

### 1.2 順手決定：要不要在第一次 build 之前加 log

```bash
grep -rn "os_log\|Logger\|print(" targets/EchoWidget/*.swift   # 目前：零筆
```

**目前 Swift 裡一行 log 都沒有。** 真機上沒有簡單的辦法看 App Group 容器（見第 6 步），
所以「按了但沒反應」在真機上會是**全盲**的。加 log 要重 build，所以這是**現在**要決定的事，
不是卡住之後才決定。建議在 `perform()` 的每個 guard 分支各加一行
`Logger(subsystem: "com.rickray.echo", category: "liveActivity")`，第一次 build 帶上、
穩了再拿掉。

---

## 第 2 步 — 在 `app.json` 加哪一行（**先加在拋棄式副本，正本最後才動**）

只有一處要改，`plugins` 陣列末尾加一筆：

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

三個選項的預設值就是上面那三個，所以 `"./plugins/withEchoWidget"` 單獨寫也會動；
寫全是為了讓 `app.json` 自己說明 App Group id 是什麼（那個字串在三個地方各有一份）。

**不需要**手動加的東西（plugin 都會處理）：`ios.infoPlist.NSSupportsLiveActivities`、
主 app entitlements 的 `com.apple.security.application-groups`、
`extra.eas.build.experimental.ios.appExtensions`。

> 🔒 **正本 `app/app.json` 要等到第 7 步全綠才改。** 一旦加了這一行，下一次 EAS Build 就
> 依賴一條到目前為止沒有在真實 prebuild 上跑過的程式碼路徑。

---

## 第 3 步 — 在拋棄式副本跑第一次 prebuild（15 分鐘）

**不要**在 repo 裡跑第一次 prebuild。生出來的 `ios/` 雖然被 gitignore 擋著，但很容易讓人
誤以為那是可以手改的東西。

```bash
rm -rf /tmp/echo-prebuild
cp -R "$APP" /tmp/echo-prebuild        # 連 node_modules 一起複製是刻意的，prebuild 才不用重裝
cd /tmp/echo-prebuild
# ① 先在這一份的 app.json 加上第 2 步那一行（正本不要動）
node -e "const c=require('./app.json');console.log(c.expo.plugins)"   # 確認看得到 withEchoWidget

# ② 先確認 plugin 真的被載入了（這一步不建 target，只求 config 求值不炸）
npx expo config --type public | grep -A 10 appExtensions
#    → 應該看得到 targetName / bundleIdentifier / entitlements 三個鍵
#    → 完全沒輸出 = plugin 沒被載入，去看路徑打錯沒（是 "./plugins/withEchoWidget"，不含 .js）

# ③ 真正的 prebuild
npx expo prebuild --platform ios --no-install --clean
```

`--no-install` 跳過 CocoaPods，因為這一輪只想看 **pbxproj 的形狀**，那不需要 pod。
要開 Xcode 時再跑一次不帶 `--no-install` 的版本（見第 5 步）。

**plugin 會在這裡主動擋下好幾種錯**（訊息一律以 `[withEchoWidget]` 開頭，看到就直接去
`plugins/withEchoWidget.js` 搜那句話）：缺 `ios.bundleIdentifier`、`targets/EchoWidget`
少檔、找不到 application target、application target 不是 pbxproj 的第一個 target、
主 app 既有的 build phase 被動到了、主 app → EchoWidget 的 dependency 沒加上。
**這些是設計上的煞車，不是意外——它們比「build 全綠但功能壞掉」好一萬倍。**

---

## 第 4 步 — prebuild 之後逐項檢查（**這是 plugin 有沒有做對事的第一個真實訊號**）

```bash
cd /tmp/echo-prebuild

# ① 六個 .swift + Info.plist + 生成的 entitlements
ls ios/EchoWidget/
plutil -p ios/EchoWidget/EchoWidget.entitlements    # 應含 group.com.rickray.echo

# ② 主 app 的 Info.plist 是 ios/<name>/Info.plist（name = app.json 的 "Echo"）
#    **不是** ios/Echo/Supporting/Info.plist —— Supporting/ 底下只有 Expo.plist。
#    寫錯路徑時 plutil 會回 "file does not exist"，接上 grep 之後輸出為空，
#    看起來就像「NSSupportsLiveActivities 沒寫進去」。
plutil -p ios/Echo/Info.plist | grep -i liveactivit   # → NSSupportsLiveActivities => 1

# ③ 雙 target 共用檔（3 個）——每一個都必須是 4
grep -c "EchoAnswerIntent.swift in Sources"     ios/Echo.xcodeproj/project.pbxproj   # 4
grep -c "EchoAppGroup.swift in Sources"         ios/Echo.xcodeproj/project.pbxproj   # 4
grep -c "EchoReviewAttributes.swift in Sources" ios/Echo.xcodeproj/project.pbxproj   # 4

# ④ 對照組：extension-only 的檔（3 個）——每一個都必須是 2
grep -c "EchoWidgetColors.swift in Sources"       ios/Echo.xcodeproj/project.pbxproj   # 2
grep -c "EchoWidgetBundle.swift in Sources"       ios/Echo.xcodeproj/project.pbxproj   # 2
grep -c "EchoReviewLiveActivity.swift in Sources" ios/Echo.xcodeproj/project.pbxproj   # 2
```

> **`4` / `2` 這組數字是整份 runbook 最容易讀反的地方，所以講清楚它從哪來。**
>
> 一個檔進一個 target = 1 個 `PBXBuildFile`，而每個 `PBXBuildFile` 的註解
> `/* X.swift in Sources */` 在 pbxproj 裡會出現**兩行**——一行是 `PBXBuildFile` section
> 的定義、一行是該 target `Sources` phase 的 `files` 清單。所以：
>
> | 這個檔進了幾個 target | `PBXBuildFile` 數 | `grep -c` |
> | --- | --- | --- |
> | extension + 主 app（**正確**） | 2 | **4** |
> | 只有 extension（**壞掉**） | 1 | **2** |
>
> **共用檔量到 `2` 就是壞掉那個形狀的簽名**：按鈕會顯示、按下去毫無反應、build 全綠、
> 沒有任何錯誤訊息（理由見 ADR-0021 Decision ②）。這組對照是 2026-08-13 在
> `node_modules/expo/template.tgz` 解出來的**真實 SDK 57 模板 pbxproj** 上實跑 plugin 的
> `withXcodeProject` mod 量出來的。

⛔ **第 3 步或第 4 步任何一項不過，就停在這裡。** 不要「先 build 看看」——
`ios/` 是拋棄式的，修 `plugins/withEchoWidget.js` 然後回第 3 步重跑，成本只有兩分鐘。

---

## 第 5 步 — 模擬器（**先在這裡測，不要直接上真機**）

模擬器測不到的只有兩件事（見第 6 步），但**它是唯一能直接把答案檔 `cat` 出來的地方**——
而「答案有沒有落地」正是這整個功能的存在意義。真機上沒有這個便利。

```bash
cd /tmp/echo-prebuild
npx expo prebuild --platform ios --clean     # 這次要 pod（不帶 --no-install）
npx expo run:ios                             # 建置 + 裝上模擬器 + 啟動
```

Xcode 開起來（`open ios/Echo.xcworkspace`）時要順手確認的五件事：

- Target 清單裡有 `Echo` 與 `EchoWidget`；
- 選 `EchoAnswerIntent.swift` → 右側 Target Membership **兩個都打勾**（這是第 4 步那組
  `4` 的圖形化版本，兩者對不上以 pbxproj 為準）；
- `Echo` target → Build Phases → 最後有一個 `Copy Files`（Destination = **PlugIns**）含
  `EchoWidget.appex`；
- `Echo` target → Build Phases → **既有的 phase 順序完全沒變**（尤其 `Embed Frameworks`
  與 `Bundle React Native code and images`）；
- `EchoWidget` target → Build Settings → Deployment Target = 17.0、主 app 仍是 16.4。

### 5.1 在模擬器上測什麼、怎麼測

```bash
# 前景啟動一個 Live Activity 之後——
# 鎖定模擬器：Device 選單 → Lock（⌘L）。Live Activity 會出現在鎖定畫面上。

# 殺掉 app（這就是「app 被殺之後按鈕還算不算數」的測法，而且可腳本化）
xcrun simctl terminate booted com.rickray.echo

# 再按一顆按鈕，然後把答案檔挖出來 ← 整個功能的存在意義
GROUP=$(xcrun simctl get_app_container booted com.rickray.echo group.com.rickray.echo)
ls -l "$GROUP/live-activity-answers/"
cat "$GROUP/live-activity-answers/"*.json | python3 -m json.tool

# deck 與 cursor 存在 App Group 的 UserDefaults，也看得到
plutil -p "$GROUP/Library/Preferences/group.com.rickray.echo.plist"
```

檢查點（依重要性）：

1. **主 app 能正常啟動。** 若 dyld 報 `Library not loaded: ReactNativeDependencies.framework`
   → 立刻跳到「排錯 ②」，不要繼續。
2. 鎖定畫面上**看得到卡片**、四顆按鈕都在、**高度沒有被截斷**、中文按鈕沒截字。
3. 按一顆選項 → 卡片換到下一題（`3/5` → `4/5`）。
4. **殺掉 app 之後再按** → 卡片仍然更新，且 `live-activity-answers/` 多一個 `.json`。
   **這一步失敗＝這個設計不成立**（前三步全過也一樣）。
5. `cat` 出來的 JSON：`schema_version` = 1、`source` = `"lockscreen"`、
   `answer_id` 是 `(deck_id, card_id)` 的穩定鍵（**不是 UUID**）、key 全部 snake_case。
6. **同一張卡連按兩顆不同選項** → `live-activity-answers/` 裡仍然只有**一個**檔，
   內容是**第一次**按的那個選擇（first-write-wins）。

> 📌 `simctl get_app_container … groups` 這組指令是照文件寫的，**本機沒有 Xcode 所以沒實跑過**。
> 若 `get_app_container` 不吃 group id，改用 `xcrun simctl get_app_container booted com.rickray.echo groups`
> 列出所有 group 容器再自己挑。

---

## 第 6 步 — 真機（模擬器過了才做）

**模擬器測不到、只有真機能回答的兩件事**，兩件都可能推翻整個設計：

1. **鎖定畫面上、Face ID 已辨識但尚未上滑**的狀態下，按鈕到底能不能觸發 intent。
   Apple 的原話是「On a locked device, buttons and toggles are inactive and the system
   doesn't perform actions unless a person authenticates and unlocks their device.」
   若每題都要主動解鎖，「鎖屏兩秒答一題」的賣點基本不成立，得改成動態島展開作答或回 app 內。
   **官方文件與論壇都沒有明確答案，只能實測。**
2. **背景喚醒 app 行程時會不會連帶冷啟 Hermes + 載入整包 JS bundle。** 若會，背景視窗可能
   不夠、或被 jetsam 回收，答案還沒寫完就被砍。`perform()` 是純 Swift，但**行程的啟動路徑
   不是我們控制的**——這是本設計最大的未驗證假設。

真機準備工作：

- 裝置 iOS **≥ 17.0**（16.4–16.9 會看到一張沒有按鈕、無法作答的卡，比不顯示更糟）；
- 設定裡的「即時動態 / Live Activities」對這個 app 是開的，鎖定畫面也允許顯示
  （對應 `checkEligibility()` 的 `'activities-disabled'`）;
- **Expo Go 不可能顯示 Live Activity**（別人簽的 app、沒有我們的 entitlements、沒有 extension）。
  在 Expo Go 裡測這個功能是浪費時間。

**真機上沒有簡單的辦法看 App Group 容器**（Xcode 的「下載容器」只給 app 容器，不含 group
容器）。所以真機階段的可觀察面只有兩個：UI 行為，以及 Console.app 裡的 log ——
這就是第 1.2 步要先決定加不加 log 的原因。

---

## 第 7 步 — 第一次 `eas build`（**別在快沒時間的時候第一次跑**）

```bash
cd /tmp/echo-prebuild        # 或改完正本後在 "$APP"
eas build --profile preview --platform ios
```

第一次跑會**多做幾件很可能是互動式的事**：

1. 新的 bundle id `com.rickray.echo.EchoWidget` 被註冊進 Apple Developer Portal；
2. 主 app 與 extension 兩邊都要開 **App Group capability**，並把 `group.com.rickray.echo`
   建起來 / 綁上去；
3. **兩組 provisioning profile 重新產生**（主 app 那組也會，因為 entitlements 變了）；
4. `extra.eas.build.experimental.ios.appExtensions` 是讓 EAS 知道要做 2、3 的依據——
   它由 plugin 在記憶體裡設進 `extra`，**在 `app.json` 裡看不到**。EAS 說找不到設定時，
   先回第 3 步 ② 確認 plugin 有被載入。

**預期的失敗點，依機率排序：**

| 失敗長什麼樣 | 最可能的原因 |
| --- | --- |
| credentials 階段卡住或問一堆問題 | 上面 1–3，正常，照著答 |
| 編譯錯在 `targets/` 的某個 Swift API | 第 1.1 步沒做，或做了但只 `-parse` |
| 編譯過、archive 失敗 | pbxproj 在**真實 prebuild 後**的形狀（第 4 步只證明形狀，沒證明 archive） |
| 裝上去一開就被 dyld 殺 | 排錯 ② |
| submit 被退：extension 與主 app 的 `CFBundleVersion` 不一致 | `README.md` §7 ❌ 第 9 條，`appVersionSource: "remote"` 的鏡射路徑沒驗證過 |

### 第 8 步 — 這時候才改正本 `app/app.json`

第 3–7 步全綠之後，把第 2 步那一行加進 `$APP/app.json`，然後**重跑第 0 步的四道閘**
（`tsc` / `export` / dependencies 仍是 14 / `node --check`），再 commit。

> 從這一刻起，`targets/` 與 `plugins/` 底下的改動**一律不能 OTA**（ADR-0021）。
> 之後在 repo 內直接 `npx expo run:ios` 是可以的（`ios/` 本來就被 gitignore），
> 規矩只剩一條：**永遠不改 `ios/` 裡的任何東西。**

---

## 排錯：最可能的三個原因與排查順序

### ① 按鈕看得到、按下去毫無反應（build 全綠、沒有錯誤訊息）

**最可能是共用檔沒有編進主 app target。** 這是這個設計唯一的靜默失敗模式，發生機率遠高於
其他所有原因，所以永遠**先查它**。

```bash
# 1. pbxproj 計數（最快、最準）
grep -c "EchoAnswerIntent.swift in Sources" ios/Echo.xcodeproj/project.pbxproj   # 4=對, 2=就是它
# 2. Xcode → 選 EchoAnswerIntent.swift → 右側 Target Membership 兩個都要打勾
# 3. 都對的話，才去看 perform() 有沒有被呼叫（需要第 1.2 步的 log）
```

排除之後，第二可能是**座標守門把答案擋掉了**（`deckId` / `cardIndex` / `cardId` 三者對不上
App Group 的當下快照）。症狀不同：那時卡片會切成「打開 Echo 更新今天的卡」，不是毫無反應。
第三可能是 iOS < 17.0——按鈕根本不會被畫出來。

### ② 主 app 一啟動就被 dyld 殺（`Library not loaded: ReactNativeDependencies.framework`）

**這是 apple-targets #194 的死法**（RN 0.83+ 加 widget extension 破壞主 app 的
Embed Frameworks phase）。我們的 plugin 是「只加不動」，理論上不會踩到，但沒有任何本機方法
可以事先證明。

```bash
# Xcode → Echo target → Build Phases，逐一比對：
#   · Embed Frameworks 還在嗎？位置有沒有動？
#   · 是不是多了一個以上的 Copy Files？（應該只多一個 PlugIns 的）
```

**確認是它就立刻停手改走 Plan B**（`react-native-widget-extension`，`README.md` §6）。
不要試著手改 `ios/` 去繞過——那是生成物，繞過的東西在 EAS 上不存在。

### ③ Live Activity 根本不出現

依序查三件事，都是幾秒鐘的事：

```bash
plutil -p ios/Echo/Info.plist | grep -i liveactivit    # 沒有 → plugin 的 Info.plist mod 沒跑
```

1. 主 app Info.plist 缺 `NSSupportsLiveActivities`（← 上面那行）；
2. 使用者/系統把即時動態關掉了 → `ActivityAuthorizationInfo().areActivitiesEnabled` 為 false，
   對應 `checkEligibility()` 的 `'activities-disabled'`；
3. 裝置 iOS < 17.0，或這是 Expo Go。

---

## 中止條件（什麼時候該放棄，而不是再修一天）

Live Activity **不是 8/17 Pre-Demo Day 的必要條件**。既有的每日通知已經覆蓋「提醒」。
以下任一條成立就直接降級，不要硬撐：

| 觸發條件 | 降到哪 |
| --- | --- |
| 第 6 步 (1) 證實鎖定狀態下按鈕不作用 | 改成動態島展開作答，或整個功能改回 app 內 |
| 第 6 步 (2) 證實背景喚醒會被 jetsam 砍 | Plan D |
| 排錯 ② 確認 Embed phase 被破壞 | Plan B（`react-native-widget-extension`） |
| 距離 8/17 剩不到 3 天而第 5 步還沒全綠 | Plan D |

> 🚨 **Plan C（用 `expo-widgets` 做 demo）有一條絕不能越過的線：** 它的訊號是無佇列、無持久化
> 的 `NotificationCenter`，JS runtime 沒起來的那一按會**靜默丟失**。可以拿去展示，
> **絕不可以**進 SRS 帳本，**絕不可以**在 pitch 裡講「每一次按壓都被接住」——
> 那正是本專案的核心主張，講錯的代價比技術債高得多。

---

## 附錄：每次改完 Swift 的最短迴圈（第 8 步之後）

```bash
cd "$APP"
swiftc -typecheck -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -target arm64-apple-ios17.0-simulator targets/EchoWidget/*.swift   # 秒級
npx expo run:ios                                                     # 分鐘級
```

改 JS 照舊 `eas update --channel preview`。**改 Swift 一定要重 build，OTA 推不動它**——
看到 app 內的 bundle 版本更新了，不代表鎖定畫面也更新了，那是兩件事（ADR-0021）。
