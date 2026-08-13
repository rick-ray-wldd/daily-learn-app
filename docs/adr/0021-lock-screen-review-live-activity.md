# ADR-0021 — 鎖屏複習卡：原生碼放 `targets/` 由 config plugin 注入；按鈕走 App Intent；答題不推進 SRS

- **Status:** accepted
- **Date:** 2026-08-13

## Context

W6 要把「今日複習」推到**鎖定畫面**：一張卡、一個英文題面、一列三個中文選項加一個
「想不起來」的逃生口，按下去就地換下一題。它是 ADR-0011 那個 10 分鐘 daily session 的
**額外曝光面**，不是它的替代品——這句話後面會變成一條硬規則（見 Decision ⑤）。

四個力量同時壓在這個決定上：

1. **這個 repo 是純 CNG。** `app/.gitignore` 第 40–41 行擋掉 `/ios` 與 `/android`，它們
   根本不在版控裡；EAS Build 每一次都是從乾淨機器 clone → `expo prebuild` → 編譯。
   在 `ios/` 手改的東西**在本機看起來會動、在 EAS 上一定不存在**，而且下一次
   `prebuild --clean` 會把它洗掉。所以原生碼必須有一個不在 `ios/` 裡的家。
2. **本機沒有 Xcode**（只有 Command Line Tools，`/Library/Developer/CommandLineTools/SDKs/`
   底下只有 `MacOSX*.sdk`）。這一輪寫得出 Swift，但**編譯不了**。任何「先做出來再看看
   過不過」的計畫在這一輪都不成立，所以每一個決定都必須在不編譯的前提下站得住。
3. **dependency 預算是 14，不准增加**——與 ADR-0018 同一條理由：Pre-Demo Day 是 8/17，
   剩下的時間全靠 OTA 迭代，每多一個原生相依就多一次「使用者得重裝」。
4. **鎖屏那一按必須是訊號，不是分數。** 三選一的猜對率本來就有 1/3。

### 被否決的方案

| 方案 | 為什麼不用 |
| --- | --- |
| **手改 `ios/EchoWidget/`** | 違反 (1)。它是 prebuild 的輸出，不是輸入；EAS 上根本不存在這份修改。 |
| **`expo-widgets` 57.0.9（Expo 第一方）** | 它的 Live Activity 按鈕 `perform()` 只發一個**行程內的 `NotificationCenter` 事件**：不寫 App Group、不更新 activity。**答案回寫這條路在它上面不存在**——而答案回寫正是這個功能的全部意義。 |
| **`@bacons/apple-targets` 5.0.0** | issue #194（2026-05）：RN 0.83+ 加 widget extension 會破壞主 app 的 Embed Frameworks phase，啟動即被 dyld 以 `Library not loaded: ReactNativeDependencies.framework` 殺掉。**我們是 RN 0.86。** |
| `react-native-widget-extension` 0.3.0 | 形狀最接近，但直接依賴 `@expo/config-plugins ~56.0.0`，SDK 57 專案裡會並存第二份，且 dependencies 14 → 15。**留作 Plan B。** |
| **用通知 action 做互動答題** | 見 Decision ③。 |

## Decision

### ① 原生碼的真相來源是 `app/targets/EchoWidget/`，`ios/` 永遠是生成物

Swift、`Info.plist` 一律放 `app/targets/EchoWidget/`。注入靠**自寫**的
`app/plugins/withEchoWidget.js`：prebuild 當下 `rm -rf ios/EchoWidget` 後複製過去、建 target、
寫 entitlements、設 `NSSupportsLiveActivities`、把 EAS 需要的
`extra.eas.build.experimental.ios.appExtensions` 塞進 config。

選自寫的決定性理由是**新增 dependency = 0**：`expo/config-plugins` 是 `expo` 套件的公開
entry point、`xcode@3.0.1` 本來就在 top-level `node_modules`。上表三個第三方方案任一個都會
讓 dependencies 變成 15。

`EchoWidget.entitlements` **刻意不做成靜態檔**，由 plugin 生成——它的內容必須跟 plugin 的
`groupIdentifier` 選項保持單一真相來源，做成靜態檔就必然出現「改了選項但檔案沒跟著改」。

> **推論（寫給未來的自己）：改 Swift 一律改 `targets/EchoWidget/`，然後重跑 prebuild。
> `ios/` 底下任何東西都不要碰，包括 `ios/EchoWidget/`。**

### ② 三個檔同時編進 extension 與主 app，這不是冗餘

`EchoAnswerIntent.swift` / `EchoAppGroup.swift` / `EchoReviewAttributes.swift` 三個檔的
Target Membership 必須是**兩個都打勾**。Apple 規定 `LiveActivityIntent` 得存在於 **app
target**（系統在 app 行程裡執行它），extension 那一份只是為了讓 `Button(intent:)` 過型別檢查。

**漏掉主 app 那一份的症狀是：按鈕正常顯示、按下去什麼都不發生、build 全綠、沒有任何錯誤
訊息。** 這正是這個設計最容易被靜默做壞的地方，所以驗收步驟裡有一道專門抓它的 pbxproj
計數檢查（`app/targets/RUNBOOK.md` 第 4 步）。

### ③ 互動答題走 App Intent；通知只負責「叫你回來」

分工是硬的，不是偏好：

| | 每日提醒通知（`lib/notifications.ts`） | 鎖屏複習卡（本 ADR） |
| --- | --- | --- |
| 是什麼 | 一個**事件** | 一個**常駐表面** |
| 五題長什麼樣 | 五則通知，或一則反覆重排 | 同一張卡就地換頁 |
| 那一按由誰執行 | JS（`expo-notifications` 的 response listener） | **純 Swift**（`perform()`） |
| 職責 | 把人叫回 app | 在鎖定畫面上收下答案 |

決定性的是第三列。Expo/RN 的通知 action 處理常式活在 **JS**：app 被殺掉之後，那一按要等到
使用者自己再打開 app、由 `getLastNotificationResponseAsync()` 補回來。「使用者按了，但要等他
回來才算數」——**那正好是我們要繞開的東西**。相對地 `LiveActivityIntent.perform()` 是純 Swift，
Apple 明訂它跑在 **app 的行程**裡，所以它寫得進 App Group、也叫得動 `activity.update()`；
純 `AppIntent`（跑在 extension 行程）這兩件事都做不到。

> ⚠️ **用字規定：一律寫「不進前景」，不准寫「不喚醒 app」。** 後者是錯的。正因為它跑在
> app 行程，上面兩件事才成立；講錯會讓人以為我們用的是另一套機制，寫進 pitch 會被問倒。

**誠實邊界：** 我們沒有實測過「系統把 app 行程帶回來」時 Expo/RN 會不會連帶冷啟 Hermes、
載入整包 JS bundle。`perform()` 本身不需要 JS runtime，但行程的啟動路徑不是我們控制的。
**這是本設計最大的未驗證假設**（`app/targets/README.md` ❌ 清單第 2 條）。

答案的落地方式：`perform()` 把一筆 JSON 寫進 App Group 容器的 `live-activity-answers/`，
檔名是 `(deck_id, card_id)` 算出來的**穩定鍵**，所以「一張卡最多一筆帳」是檔案系統層級的
不變式。App 下次前景啟動時由 JS 端收割。**落地在更新 UI 之前**——落地是不可失去的，UI 是
可以重畫的。

### ④ 12 小時上限剛好等於「今日 N 題」的作用域

Apple 的規則（Apple DTS 在開發者論壇 thread 797676 的說法，本機無法驗證）：Live Activity
**active 最多 8 小時**（能收更新），系統結束它之後**還會留在鎖定畫面最多 4 小時**，
合計上限 12 小時。

這個上限**不是要繞過的東西，它跟我們的語意是同一個作用域**：daily session 的定義本來就是
「今天」（ADR-0011），一副牌一天一副。08:00 的提醒點啟動 → 16:00 前都能作答換頁 → 20:00
前卡片還在 → 隔天 08:00 換新的一副。所以 `staleDate` 設在**明天 08:00**（對齊
`lib/notifications.ts` 的 `DAILY_REMINDER_HOUR = 8`），而不是「N 小時後」——`staleDate` 的
語意是「**內容**過期」而不是「活動結束」，我們要表達的是「跨過下一個提醒時點的題目就不該
再作答」。

**代價要講清楚：** 第 8–12 小時是一段「凍結但仍畫著按鈕」的窗口。那一按的**答案仍會落地**
（`perform()` 先寫 App Group，找不到 activity 也照寫），但畫面不會換頁。這段窗口的實際行為
（按鈕還會不會觸發 intent）**沒有實測過**。

**Apple 審查的風險（讀 HIG 與 App Review 條文的判斷，沒有實際送審過）：** Live Activity 的
審查標準是「即時、與正在發生的事情有關」——航班、外送、比分。一張複習卡是「一天內有效的
待辦」，落在灰色地帶。降風險的三件事都已經做進設計：**(a)** 只在使用者主動開啟時啟動，
**不做 push-to-start**（那還需要 iOS 17.2+、APNs server、token budget 管理，本輪明確排除）；
**(b)** `staleDate` 誠實反映「今天之後就沒意義」；**(c)** 答完停在結算狀態而不是無限期掛著。
**如果仍被退件，Plan D（整個砍掉）是可接受的**——Live Activity 不是 8/17 的必要條件，既有的
每日通知已經覆蓋「提醒」。

### ⑤ 鎖屏答題**不推進 SRS**

不呼叫 `gradeSrsItem`、不把 capture 標成 `practiced`、不計入 daily session 完成度、不進北極星。
只做統計（`summarizeAnswers`）。

理由是 ADR-0011 的直接後果：北極星是「每週完成的 daily session」，而 ADR-0011 存在的**全部
理由**就是不讓「滑一滑」算成完成。一次鎖屏三選一點擊的證據強度遠低於練習頁的完整流程
（重聽 → 揭露 → 跟讀 → 自評），猜對率還有 1/3。把它記成 practiced 等於用一次點擊灌水北極星，
**正好做出 ADR-0011 要消滅的那個 vanity number**。鎖屏答題是額外曝光，不是完成。

這條規則的兩份鏡像已經先寫在 `app/lib/liveActivity.ts` 檔頭的 ③④ 與
`app/targets/README.md` §8 第 7 條，它們指向的就是這份 ADR。

> 📌 分母的上限是 **`MAX_DECK_LENGTH = 5`**（ADR-0011 的 N=5），**不准出現 10**。
> 本輪的規格草圖畫的是 `3/10`，實作刻意是 `3/5`——若草圖才是本意，那是要改 ADR-0011
> 的事，不是在這裡偷偷放寬。

## Consequences

### 🚨 OTA 界線正式改變：本專案第一次有「不能 OTA」的區域

**這是這份 ADR 最需要被記住的一條。** 在此之前，`app/` 底下每一個字都是 JS/TS，
`eas update` 推得到；從加入這個 target 開始不是了。

| 改了什麼 | `eas update` 夠嗎 | 為什麼 |
| --- | --- | --- |
| `lib/`、`screens/`、`App.tsx` 等 JS/TS | ✅ 夠 | OTA 更新的就是 JS bundle |
| `targets/EchoWidget/*.swift` | ❌ **一定要重 build** | Swift 編進 `.appex` 二進位，OTA 根本不含原生碼 |
| `plugins/withEchoWidget.js` | ❌ **一定要重 build** | 它只在 prebuild 時執行 |
| `app.json` 的 `plugins` / entitlements | ❌ **一定要重 build** | 同上 |

repo 已經有「顯示執行中的 bundle 版本 + 手動檢查更新」（commit `d45c472`）。
**不要因為看到 bundle 版本更新了就以為鎖定畫面也跟著更新了——那是兩件事。**

**更危險的一條：** `app.json` 是 `runtimeVersion: { "policy": "sdkVersion" }`，加一個 native
target **不會**改變 runtimeVersion（SDK 版本沒變）。後果是**新的 JS bundle 會被 OTA 推到
「還沒有 EchoWidget extension」的舊 build 上**。所以：

- **所有原生呼叫都必須 feature-detect**，模組不在就整段跳過，不准 crash。
  `lib/liveActivity.ts` 的 `checkEligibility()` 就是為此存在
  （`'native-module-missing'` / `'ios-too-old'` / `'activities-disabled'`）。
- 這與 `lib/selection.ts` 檔頭記載的「JS bundle 一定比 SQL 早到」是同一類風險。
- 若哪天要讓兩者強制對齊，得改成 `runtimeVersion.policy: "appVersion"`——那是另一個決策，
  要先寫 ADR。

### 誠實紀錄：本輪沒有任何一行 Swift 被編譯過

這一段是刻意寫進 ADR 而不只是 commit message 的，因為這個 repo 的複查已經抓過兩次
「宣稱了沒發生的事」。

- 6 個 Swift 檔通過 `swiftc -parse`（exit 0、零診斷）。**`-parse` 不解析 module、不做型別
  檢查**——同一份檔跑 `swiftc -typecheck` 會直接 `error: no such module 'ActivityKit'`，
  證明 iOS SDK 真的不在。對照實驗（同樣無法解析的 import + 一個故意的語法錯）確認 `-parse`
  確實抓得到純語法錯誤，所以那個通過不是空的；但它的範圍就只到「**語法合法**」。
  **它不證明能編譯、不證明型別正確、不證明連得起來、不證明跑得動。**
- `plugins/withEchoWidget.js` **從未在真實的 `expo prebuild` 裡執行過**——它刻意不在
  `app.json` 的 `plugins` 陣列裡。它的 pbxproj 操作在合成專案、以及從
  `node_modules/expo/template.tgz` 解出來的**真實 SDK 57 模板 pbxproj** 上實跑過並斷言通過，
  但那不是 prebuild（沒有改名、沒有 CocoaPods、沒有 `ExpoModulesProvider.swift`），更不是編譯。
- 因此**這份 ADR 記的是決定，不是成果**。第一次 `eas build` 成功之前，這個功能的狀態是
  「已備好、未啟用、未驗證」。完整的未驗證清單在 `app/targets/README.md` §7，
  執行步驟在 `app/targets/RUNBOOK.md`。

### 其他被綁住的事

- **Expo Go 永遠看不到這個功能**（別人簽的 app、沒有我們的 entitlements、沒有 extension）。
  要在實機上邊改 JS 邊看 Live Activity 需要 dev build，而 `expo-dev-client` 會讓
  dependencies 14 → 15。折衷是用 `preview` profile 出 internal build 驗原生行為，
  JS 迭代照舊 `eas update --channel preview`。
- **extension 的 deployment target 是 17.0，主 app 維持 SDK 57 預設的 16.4。**
  16.4–16.9 的裝置會看到一張**沒有按鈕、無法作答**的卡——比不顯示更糟，所以
  `checkEligibility()` 回 `'ios-too-old'` 時必須**完全不啟動**。
- **extension 不准加任何 pod**（只用系統框架），也不准放 `Assets.xcassets`。
- **主 app 既有的 build phase 一律不准移除、重排、重建**（apple-targets #194 的死法就在這裡）。
- 每一次改 App Group id、答案目錄名、UserDefaults key，都要**同時**改 Swift、JS、plugin
  三份常數——跨語言沒有共用常數的辦法，這份重複是刻意的。

**沒有 supersede 任何 ADR。** ADR-0011 的 N=5 是這張卡分母的硬上限；ADR-0016 的系統播放
控制項與 ADR-0001 的原生殼都不受影響——這份反而是 ADR-0001 的又一個後果：正因為我們有
原生殼，才拿得到 App Intents，也才必須接受「有一塊區域不能 OTA」。
