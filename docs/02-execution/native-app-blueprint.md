# 純 Swift 版 Echo 的架構藍圖

- **Status:** draft（提案，不是決定，也不是成果）
- **Date:** 2026-08-14
- **與 ADR 的關係:** 這份**不是** ADR。它描述一個還沒開始的方向。真的要動手時，
  §6 的每一個階段各自寫一份 ADR；其中階段一必然會 supersede ADR-0016。

## 0. 這份文件的效力等級

**沒有一行本文件描述的 Swift 程式碼被驗證過。**

本機 `xcode-select -p` 指向 `/Library/Developer/CommandLineTools`，`xcodebuild` 回
「requires Xcode」，`CommandLineTools/SDKs/` 底下只有 `MacOSX*.sdk`、沒有任何
iPhoneOS SDK（`app/targets/RUNBOOK.md` 的現況快照，2026-08-13 本機實測）。
`app/targets/EchoWidget/` 的 1,160 行 Swift 只通過 `swiftc -parse`——它不解析
module、不做型別檢查，同一份檔跑 `swiftc -typecheck` 會直接
`error: no such module 'ActivityKit'`。

所以：本文件裡凡是講「Swift 側會怎樣」的句子，都是**紙上的**。凡是有本機可查證
的根據（檔案、行號、實測輸出）都會標出來；查不到的一律標「待驗證」。

這份文件之後會成為第二個 repo 的主文件。它現在的價值不是「已經想清楚了」，
而是「已經把不知道的事列成清單了」。

---

## 1. 先講清楚：`app/targets/EchoWidget/` **不能**搬走

第二個 repo 拿到的是**參考副本與計劃**，不是搬移。原因不是保守，是機械性的：

`app/plugins/withEchoWidget.js:282` 這一行決定了原生碼只能待在哪裡——

```js
const sourceDir = path.join(cfg.modRequest.projectRoot, 'targets', targetName);
```

`projectRoot` 是 **Expo 專案根目錄**（也就是 `app/`）。plugin 在 prebuild 當下把
`targets/EchoWidget/` 的六個 `.swift` 加 `Info.plist` 複製進 `ios/EchoWidget/`。
少一個檔就整段停下：

```js
const missing = expectedFiles.filter((name) => !fs.existsSync(path.join(sourceDir, name)));
if (missing.length) fail(`${sourceDir} 缺少：${missing.join(', ')}`);
```

把 `targets/` 搬到另一個 repo，Expo 這邊的 prebuild 會在這一行炸掉，鎖屏複習
（ADR-0021）在 Expo 版上直接消失。而 `ios/` 是 `.gitignore` 擋掉的生成物
（`targets/README.md` §1：這個 repo 是純 CNG），所以也不能改成「從 `ios/` 讀」。

### 兩份 Swift 並存的成本，以及唯一的緩解

階段三之後，同一批 ActivityKit 程式碼會同時存在於兩個 repo。這是實打實的漂移
風險，沒有巧妙的解法，只有一條紀律：

> **Expo repo 的 `app/targets/EchoWidget/` 是上游，第二個 repo 是下游。**
> 單向複製。下游改了什麼，要嘛回推上游，要嘛在下游檔頭寫明「已與上游分岔，
> 原因是 X」。**不做雙向同步**——雙向同步在只有一位開發者的專案裡等於沒有同步。

### 搬過去之後唯一會變簡單的事

`targets/README.md` §1 記著一條 Apple 的硬規定：`EchoAnswerIntent.swift` /
`EchoAppGroup.swift` / `EchoReviewAttributes.swift` **必須同時編進 extension 與
主 app 兩個 target**（系統在 app 行程裡執行 `LiveActivityIntent`），漏掉主 app
那一份「按鈕會正常顯示、按下去卻什麼都不會發生，而且不會有任何錯誤訊息」。

在純 Swift repo 裡，主 app target 本來就是 Swift、本來就有這些檔，這個約束會
自然消失，`plugins/withEchoWidget.js` 的 575 行也整份作廢。這是遷移少數幾個
**確定**會變好的地方之一（其他多數是「可能」）。

---

## 2. 範圍界定：重寫什麼、沿用什麼

### 2.1 完全沿用（後端；它們與宿主語言無關）

| 東西 | 規模 | 為什麼沿用 |
| --- | --- | --- |
| Supabase Postgres schema | `app/supabase/migrations/` 6 檔 537 行 | 表就是表。Swift client 走 PostgREST 打的是同一組 endpoint |
| RLS + 匿名身分（ADR-0013） | migration 002（186 行） | policy 寫在資料庫裡，不在 client。**待驗證**：`supabase-swift` 的 `signInAnonymously` 支援度本輪沒查證 |
| 三支 Edge Function | `_shared/` + `transcribe` / `diagnose` / `annotate`，5 檔 751 行 Deno TS | 契約是 HTTP + JSON。`transcribe` 的 byte-range 切片、`diagnose` 的 strict-schema tool call、`annotate` 的配額，一行都不用改 |
| 每日配額（`consume_api_quota`） | migration 002 / 003 | 同上，在伺服器端 |
| `demo-media` bucket 與 Huberman 示範集 | migration 004 / 005 | 音檔與 VTT 是靜態資產 |

**繼承的問題也一起繼承**：`006_explicit_selection_signal.sql` 至今**未套用到線上**
（**本輪實查 2026-08-14**：`captures.selection_text` 與 `captures.selection_kind` 對線上
PostgREST 都回 `42703`；兩個 CHECK 約束仍是舊值集合這一項沿用 `CONTEXT.md` §4）。
換語言不會修好它。`saved` / `selected` / `segmentation` 三種手動指出的
訊號在伺服器端一筆都沒有，Swift 版一樣沒有。**這是套 migration 的事，不是遷移的事，
而且應該在遷移之前就做完。**

### 2.2 必須重寫

| 東西 | 規模 | 為什麼非重寫不可 |
| --- | --- | --- |
| 全部 UI | `App.tsx` 751 + `screens/` 1,498 + `components/` 4,933 = **7,182 行 TSX** | React 元件與 SwiftUI View 沒有轉譯路徑 |
| 音訊層 | `expo-audio` 的 `useAudioPlayer` / `useAudioPlayerStatus`（`App.tsx:115`） | 換成 `AVPlayer` + `AVAudioSession`，狀態模型完全不同 |
| 訊號擷取的**觸發端** | `App.tsx` 的 250ms status tick 與兩道 seek 閘 | 它綁在 `expo-audio` 的 status 上；換 player 就得重接。**而這正是遷移最大的收穫**（§4.1） |
| 本機持久層 | `lib/store.ts` 406 行（AsyncStorage） | 沒有 AsyncStorage。選項與取捨見 §5 |

### 2.3 可以逐字翻譯（純邏輯、零平台相依）

`srs.ts`(104) / `stats.ts`(57) / `transcriptFormats.ts`(75) / `hash.ts`(18) /
`selection.ts` 的 `tokenize` + `sliceSelection` / `liveActivity.ts` 的純函式與常數
（742 行大部分是這個）。

**`captureEngine.ts`(239) 不在這一組，雖然它長得最像。** 它的**演算法**確實是純的，
但它的入口不是——`lib/captureEngine.ts:30` `import { getCaptures, upsertCapture,
updateCapture } from './store'`，而 `ingestReplayEvent` 在 `:115` 讀 store、在 `:169`
與 `:193` 寫 store，`noteTranscriptOpen` 在 `:233` 也寫。翻譯之前要先把讀寫提到呼叫端
（或傳一個 protocol 進去），否則 Swift 側會照抄一份對持久層的硬相依。

> ⚠️ 這一點與 `CONTEXT.md` §4 的措辭不一致：那裡把 `captureEngine.ts` 記成
> 「pure: (replay events) → captures」。**以程式碼為準**——`srs.ts` 檔頭那種
> 「Pure functions only — persistence lives in `lib/store.ts`」的分界，`captureEngine`
> 目前並沒有守住。這是 CONTEXT.md 該修的一筆，不是本文件可以順手改的（不是本輪的檔）。

這一組（含 `captureEngine` 的演算法部分）加起來約 1,200 行，是**最該先寫測試再翻**的
部分。`CONTEXT.md` §4 已經記著「還沒有測試套件」，並指名 `captureEngine` + `srs` 是
最高價值的目標。詳見 §6 階段四。

---

## 3. 模組對照表

### 3.1 `app/lib/*.ts` → Swift 側

| 現況檔（行數） | 性質 | Swift 側對應 | 陷阱 |
| --- | --- | --- | --- |
| `store.ts` (406) | **the seam** | **未定**——見 §5 | 全表唯一一支「不知道答案」的。它同時是持久化、快取、subscribe、best-effort sync 四件事 |
| `captureEngine.ts` (239) | **不是純的**——演算法是純的，但入口直接讀寫 store（見下） | `struct` + 純 `func`，uuid 換 `Foundation.UUID`；**同時要把 store 呼叫提出去** | 直翻演算法。三條升級規則（同段倒帶×2 取交集、倒帶後降速、倒帶後開稿）與 `SECTION_SEEK_WINDOW_MS` 的語意要逐條對測 |
| `replay.ts` (80) | model + fire-and-forget sync | `Codable struct` + 同一張 `replay_events` | `TriggerSource` 四值 → Swift `enum`。**enum 的 switch 窮盡性比 TS 更能守住 `types.ts` 的白名單鐵律**（新增一級會編譯錯，不會靜靜漏過） |
| `selection.ts` (343) | 2 純函式 + 2 有副作用的 commit | 同樣切成兩半 | `CONTEXT.md` 記的技術債會一起搬：`store.syncCapture` 不認識 `selection_text` / `selection_kind`，所以 `selection.ts` 自己做了第二次遠端 upsert。重寫是修掉這個縫的機會，但**不修也能跑**，要有人明確決定 |
| `srs.ts` (104) | 純 SM-2 | 直翻 | 檔頭自己寫「Pure functions only — persistence lives in `lib/store.ts`」。這個分界在 Swift 側要維持，它是 §5 能延後決定的全部原因 |
| `stats.ts` (57) | 純 | 直翻 | `confirmRate` 的母體白名單（`weak` + `strong`）必須逐字搬。這個 repo 在這裡犯過兩次錯 |
| `transcript.ts` (405) | 三來源 async seam | `FileManager` + `URLSession` | 窗口對齊 `floor(t / 600)`、`PREFETCH_LEAD_SEC = 150` 的預抓邏輯直翻。async/await 兩邊都有，這支的翻譯風險低 |
| `transcriptFormats.ts` (75) | 純 parser | 直翻 | 時間碼的正規表示式要重寫（`NSRegularExpression` 或手寫掃描）。壞輸入一律回空陣列的契約要保住 |
| `rss.ts` (236) | XML 解析 | `XMLParser`（Foundation，SAX 式） | **全表第二高風險。** `fast-xml-parser` 是 DOM 式、Foundation 的是事件式，**沒有一對一等價物**，得整支重寫。而 episode id 的穩定性約定就住在這支 |
| `hash.ts` (18) | cyrb53 | 手寫 | **全表最高風險的 18 行。** 它用 `Math.imul`（32 位有號乘法）。Swift 要用 `&*` 溢位運算子並確保 32 位語意逐位相同。**算出不同的值 → 既有的 `captures.episode_id` 全部失聯**，使用者的歷史 capture 對不回任何一集 |
| `episodes.ts` (67) | model + 寫死 demo 資料 | 直翻 | `CONTEXT.md` 已標為淺模組（model 與 demo 資料混在一起），重寫時順手拆開 |
| `podcastSearch.ts` (43) | iTunes Search | `URLSession` + `Codable` | 直翻 |
| `diagnose.ts` (98) / `annotate.ts` (363) | Edge Function client | `URLSession` + `Codable` | 契約不變（§2.1）。`annotate.ts` 檔頭那段「標註不是訊號」與 `hasRewindEvidence` 白名單必須整段搬過去，那是產品論點不是實作細節 |
| `supabase.ts` (102) | client + 匿名 session | `supabase-swift`，或手寫 PostgREST | **待驗證**：匿名登入支援度、以及「沒設定就是 `null`、任何東西不准在它上面阻塞」這個契約要怎麼在 Swift 的型別系統裡表達 |
| `notifications.ts` (78) | expo-notifications | `UNUserNotificationCenter` | 直翻，API 語意接近 |
| `theme.ts` (223) | design token | Swift `enum` 常數 | 見下一段 |
| `liveActivity.ts` (742) | 純邏輯 + 跨語言常數契約 | **與 `EchoAppGroup.swift` 合併** | 見下一段 |
| `types.ts` (150) | 型別 + 鐵律註解 | `enum` + `struct` | 那些註解（四級強度、白名單鐵律、`selection_kind` 為何刻意不是六個 difficulty type）**是文件不是註解**，要一字不漏帶走 |

**兩支的變化值得單獨講：**

`theme.ts` / `Glass.tsx`(167) / `Gradient.tsx`(122) —— ADR-0018 的**實作**會消失，
**決定本身不會整份消失**。這個區別很重要，因為那份 ADR 的 Context 列的是**三**股力量，
只有第一股是 OTA：

1. 六天內只能靠 OTA 迭代 → 不裝 `expo-blur` / `expo-linear-gradient` /
   `expo-glass-effect` / `expo-mesh-gradient` 四個第一方原生模組。**這一條在純 Swift
   版失效**：SwiftUI 有 `.ultraThinMaterial`，真的背景模糊，不用疊。
2. 質感必須是一套，不是六套（要有共用 primitive）。**這一條與語言無關。**
3. `theme.ts` 的鐵律「顏色帶語意，不准重用」，所以材質 token（`GLASS`/`BLOOM`/`RAMP`/
   `ELEV`）與語意色 `C` 分家。**這一條也與語言無關**，只是要重新想怎麼在 SwiftUI 裡
   表達。

所以正確說法是：**這 289 行的疊層實作作廢，(2)(3) 兩條設計判斷要原樣帶走。**
ADR-0018 自己寫了 supersede 的條件（「只要哪天內容會透過面板，這個近似就會露餡」），
而換成 SwiftUI 的原生材質正好就是滿足那個條件的其中一條路。

`liveActivity.ts`(742) —— 它現在是**跨語言契約的膠水**：`APP_GROUP_ID` /
`ANSWER_DIR_NAME` / `DECK_KEY` / `CURSOR_KEY` / `ANSWER_SCHEMA_VERSION` /
`MAX_DECK_LENGTH` 每一個都必須與 `EchoAppGroup.swift` 和
`plugins/withEchoWidget.js` 三處一致。純 Swift 版沒有第二種語言，這 742 行大部分
直接消失，剩下的併進 `EchoAppGroup.swift`。**這是整份對照表裡最大的一筆簡化。**
順帶提醒：`liveActivity.ts` 目前**不在 Metro graph 裡**（沒有任何檔 import 它），
所以它的 JS 端邏輯也從未被任何執行路徑碰過——它不是「已經跑過的程式碼」，
是「已經寫好的程式碼」。

### 3.2 UI 對照（粗略，因為 UI 是重寫不是移植）

| 現況 | 行數 | Swift 側 | 備註 |
| --- | --- | --- | --- |
| `App.tsx` | 751 | `App` + 一個持有 player 的 `@Observable` 播放狀態物件 | ADR-0015/0019 的「外殼」概念可以保留：SwiftUI 的 `TabView` 加一個覆蓋層 |
| `screens/Practice.tsx` | 1,498 | 最大單檔 | 「今天哪些 capture 有資格」被實作兩次的技術債（`CONTEXT.md` 標 blocking）在這裡收斂 |
| `components/TranscriptScreen.tsx` | 1,341 | 兩點框選手勢要重做 | ADR-0017 的「點頭、點尾兩次獨立 tap」在 SwiftUI 是另一套手勢系統，**互動要重新測，不能假設等價** |
| `components/PodcastBrowser.tsx` | 587 | 直做 | 相依最少，適合當第一個搬的畫面 |
| `components/HomeScreen.tsx` | 767 | bento + masonry（ADR-0020） | **待評估**：SwiftUI 沒有內建 masonry；`MasonryList.tsx`(255) 的「整頁只有一個捲動容器」約束要重新想 |
| `components/Glass.tsx` + `Gradient.tsx` | 289 | 作廢 | 見上 |

---

## 4. 只有原生做得到的三件事

### 4.1 `MPRemoteCommandCenter`——把核心訊號從**推斷**變成**量測**

這是遷移理由清單的第一項，而且它是唯一一項**現在就有證據**的。

ADR-0016 記著問題的根：`expo-audio` 的遙控 handler 在原生層直接呼叫 `AVPlayer.seek`，
完全不經過 JS——

```swift
remoteCommandCenter.skipBackwardCommand.addTarget { [weak self] event in
  let seekTime = currentTime - CMTime(seconds: event.interval, ...)
  player.ref.seek(to: seekTime, ...)          // ← JS 這邊什麼都收不到
}
```

所以鎖定畫面倒帶——**這個產品唯一在乎的訊號**——會憑空消失。目前的補救是
`App.tsx` 每 250ms 取樣播放位置，「忽然往回 >3 秒且不是我們自己送的 seek」就推斷成
`trigger_source: 'lockscreen'`，並且用兩道 ref 閘（`SEEK_SETTLE_MS` 時間窗、
`SEEK_SETTLE_SEC` 位置窗）擋掉自家 seek。ADR-0016 自己寫明這套推斷「**偏向漏記
而不是誤記**」，是刻意的。

**證據**（呼叫端提供，**本輪嘗試複查失敗**：MCP token 過期，anon key 被 RLS 濾成 0 列）：
11 筆 replay event **全部**是 `'screen'`，`'lockscreen'` **一筆都沒有**——這套推斷自
08-08 上線至今從未觸發。

Swift 側的做法：自己 `addTarget` 到 `skipBackwardCommand` /
`changePlaybackPositionCommand`，在 handler 裡**先記事件再 seek**。呼叫端估計約
60 行（**未實作、未驗證**）。它換掉的是：250ms 取樣迴圈、兩道閘、
`EXTERNAL_REWIND_MIN_SEC` 這個「產品判斷而非技術常數」的 3 秒門檻——整套推斷可以
刪掉。ADR-0016 的 Consequences 已經寫了退場條件：「真的要滴水不漏，得等
`expo-audio` 把 remote command 以事件送進 JS，到時這整套推斷就可以拆掉並
supersede 這份」。自己註冊 target 是同一件事的另一條路。

順帶解掉的一致性問題：`expo-audio` 把往回鍵寫死 10 秒、JS 改不了（ADR-0016），
所以鎖定畫面的往回幅度與 app 內的 ↺15 不一致。自己註冊可以設
`preferredIntervals = [15]`。

⚠️ **這一項不需要整個重寫。** 它是一顆 local Expo module 就能做的事——見 §6 階段一。
把「換語言」與「補這個洞」綁在一起是錯的：洞現在就能補，語言可以之後再說。

### 4.2 `AVAudioEngine` tap——Phase 2 的全部

六週計劃 W4 那一條「**真實生活模式 demo：背景 rolling buffer + AirPods 手勢**
（技術驗證，拍進 demo 影片用）」需要拿到麥克風的 PCM buffer。
**React Native 完全做不到**——沒有任何 JS API 拿得到音訊 sample。

Swift 側：`AVAudioEngine.inputNode.installTap(onBus:bufferSize:format:)` 拿到
`AVAudioPCMBuffer`，寫進一個固定長度的 ring buffer（「剛剛那 30 秒」）；耳機手勢
仍然走 `MPRemoteCommandCenter`（與 §4.1 同一組 API，所以兩件事共用同一段程式碼）。

**這一項有三個完全沒查證的前提，比技術難度更該先處理：**

- 背景麥克風的 `UIBackgroundModes` 與 `AVAudioSession` category 組合能不能長時間
  存活。**待驗證。**
- 耗電。背景音訊 app 的真實風險就在這裡，而且只有 Instruments 量得出來——這也是
  「Xcode 工具本身」被列進遷移理由的原因。**待驗證。**
- App Store 審查對「常時聽麥克風」的態度。**完全沒做功課。** 這是政策風險不是
  技術風險，而政策風險擋下來就沒有 Plan B。

### 4.3 ActivityKit + App Intents——鎖屏複習

藍圖已在 `app/targets/EchoWidget/`（6 檔 1,160 行，**從未編譯過**），決定記在
ADR-0021。純 Swift repo 的差別只有工程上的，沒有功能上的：

| 現況（Expo） | 純 Swift |
| --- | --- |
| `plugins/withEchoWidget.js` 575 行注入 pbxproj | 不需要，Xcode 專案本來就有 target |
| 常數區整段是跨語言契約（`liveActivity.ts:35`：「改這裡就要同步改 Swift 的 `EchoAppGroup` 與 plugin」） | 一處 |
| intent 寫 App Group 檔案 → app 收割 | app 與 intent 同 target、同持久層 |
| `checkEligibility()` feature-detect 原生模組在不在 | 不需要 |

**`targets/README.md` §7 的 14 條未驗證清單，換語言之後有 3 條消失、3 條變形、
8 條原封不動。** 逐條對過一次（❌ 編號依 README §7）：

| 換語言後 | 條目 | 為什麼 |
| --- | --- | --- |
| **消失（3）** | ❌2 背景喚醒會不會冷啟 Hermes + 載入整包 JS bundle | 沒有 Hermes。README 自己標它是「**本設計最大的未驗證假設**」，這是遷移在這一區最大的單筆收穫 |
| | ❌3 plugin 產生的 pbxproj 能不能 archive | 純 Swift repo 沒有 plugin、沒有 prebuild，Xcode 專案本來就有 target |
| | ❌4 Embed 階段有沒有破壞 RN 0.86 的 SPM framework 嵌入 | 沒有 RN，就沒有那組 framework 要嵌 |
| **變形（3）** | ❌8 EAS 首次 build 的 credentials 流程 | 底下的工（新 bundle id、App Group capability、profile 重產）一樣要做，只是換成 Xcode／ASC 的介面 |
| | ❌9 `appVersionSource: "remote"` + `autoIncrement` 下版號是否一致 | 這是 Expo 的鏡射路徑特有的疑點；純 Swift 直接設 `CURRENT_PROJECT_VERSION`，但「兩個 target 版號要一致」這條 App Store 規則不變 |
| | ❌14 同一天重算佇列時誰負責重新對齊鎖定畫面上那張 activity | 不再是「JS 端寫完 `DECK_KEY` 之後要記得 update」，而是同 target 內的一次呼叫。問題變簡單，但沒有自動消失 |
| **原封不動（8）** | ❌1、❌5、❌6、❌7、❌10、❌11、❌12、❌13 | 全都是平台行為或版面問題，與宿主語言無關 |

⚠️ 特別提醒 **❌11（Swift 能不能編譯）不在「消失」那一欄**——換 repo 不會讓 1,160 行
Swift 自己編過一次。

原封不動的那 8 條裡，這兩條最該先看：

- 第 1 條：鎖定畫面上、Face ID 已辨識但尚未上滑的狀態下，按鈕能不能觸發 intent。
  Apple 官方文件說「On a locked device, buttons and toggles are inactive…」，
  而官方文件與論壇都**沒有**明確答案。若每題都要主動解鎖，「鎖屏秒答」的賣點
  基本不成立。
- 第 5 條：160pt 高度塞不塞得下 header + 回饋列 + 題目 + 三選項 + 逃生口。

### 4.4 第四件事，**不算在三件裡**：`SFSpeechRecognizer`

端上語音辨識**可能**讓 `transcribe` 的成本歸零。標為**待評估**：本輪沒有查證它的
準確度、支援語言、離線模型的下載大小、單次請求時長限制，也沒有拿它跟 Whisper
做過任何比較。

**不要寫進 pitch，不要當成遷移理由。** 它現在是一個沒查過的直覺。

---

## 5. 資料層策略：選項與取捨（**刻意不下結論**）

ADR-0004 說 `store.ts` 是唯一真相、Supabase 是 best-effort。翻譯成 Swift 側必須
滿足的四條不變式：

1. 寫入同步生效，UI 立刻看得到（現況：更新記憶體快取 → 通知 listener → 再
   fire-and-forget 持久化與遠端）
2. 網路失敗不擋任何路徑
3. 沒設定 Supabase 也能整套跑（local-only mode）
4. 有 subscribe/observe，一處寫、多處更新

### 選項 A — `Codable` + 單一 JSON 檔（AsyncStorage 的直譯）

- **好**：語意與現況完全一致，遷移風險最低。一個 `@Observable` class 就重現了
  `store.ts` 的 `subscribe`。零第三方相依。
- **壞**：整檔讀寫。資料量一大就是每次寫入都序列化全部。
- **不知道的**：資料會長多快。伺服器端 `difficulty_items` **0 筆**、真實使用者
  **1 位**（呼叫端提供），本機的量級沒有人量過。已知的一個上界訊號：`CONTEXT.md`
  標為 blocking 的技術債說「一集可以為明天鑄出約 20 張全流程卡片」（因為佇列對
  saved terms 沒有上限，而「＋加入練習」只要一下）。

### 選項 B — SQLite（GRDB，或直接 `sqlite3` C API）

- **好**：查詢就是查詢。「今天到期的 SRS」不用整包載入再 filter。GRDB 的
  `ValueObservation` 天生就是不變式 4。schema 可以直接對映 migration 001–006，
  **local 與 remote 同構**——ADR-0004 說「sync 是 column-for-field upsert」，
  這個選項是唯一能把那句話字面保住的。
- **壞**：一個第三方相依（GRDB），或一堆 C API 樣板。
- **順手解掉的**：`CONTEXT.md` 記著「今天哪些 capture 有資格」被實作了兩次
  （`screens/Practice.tsx` 的佇列 vs `App.tsx:computeBadge`）且已經漂移過一次。
  SQL 可以讓它變成一個 view，只有一份。

### 選項 C — Core Data / SwiftData

- **好**：Apple 第一方，零相依。`@Query` / `NSFetchedResultsController` 直接餵
  SwiftUI，不變式 4 免費。
- **壞**：它自己有一套 schema migration，與 Supabase 的 SQL migration 兩套並行、
  各有各的版本號。物件圖模型與現在的扁平 `struct` 不同構，翻譯成本會落在**每一支**
  lib 而不是只落在持久層。
- **風險**：這會打破 ADR-0004 的「Supabase schema mirrors the local types」同構。
- **聽說但沒查證**：SwiftData 在 iOS 17 早期版本有不少 bug 回報。**這是傳聞，
  不要當事實引用。**

### 選項 D — 不做本機層，直接 Supabase + 快取

**明確不建議**，列在這裡只當對照組：它違反上面四條不變式的全部。寫出來是為了
說清楚一件事——**local-first 是產品決定不是技術偏好**。local-only mode 是創辦人
能在飛機上、在收訊爛的地方 dogfood 的唯一原因，也是 beta 用戶第一次開 app 不用
註冊就能用的原因。

### 為什麼不下結論

B 與 C 的選擇取決於一件**本機沒有答案**的事：capture 的真實成長速度與查詢形狀。
目前的資料是 0 筆與 1 位使用者。在這個基礎上選資料庫等於擲骰子。

> **建議：這個決定延到有 30 天真實使用資料之後，屆時寫一份 ADR。**
> 在那之前用選項 A（它的遷移成本最低，而且是唯一能「先跑起來再說」的）。

**有一件事現在就可以定，而且它是上面能延後的全部原因：**

> `captureEngine` / `srs` / `stats` 的核心演算法**不准知道持久層是什麼**。
> 保住這條線，A → B → C 換來換去都不用重寫核心；破壞它，選錯一次就得重寫兩千行。

**但要誠實說：這條線今天只守住了三分之二。**

| 檔 | 現況 | 根據 |
| --- | --- | --- |
| `srs.ts` | ✅ 守住 | 檔頭明寫「Pure functions only — persistence lives in `lib/store.ts`」，實際 import 只有 `types` |
| `stats.ts` | ✅ 守住 | 檔頭「全部純函式，只讀 store 現有結構」，import 只有 `srs` / `types` |
| `captureEngine.ts` | ❌ **沒守住** | `:30` 直接 import `getCaptures` / `upsertCapture` / `updateCapture`，並在 `:115` / `:169` / `:193` / `:233` 呼叫 |

所以「延後選資料庫」這個結論仍然成立，但**它的前提要先補上**：遷移前（或遷移中的
階段四）得先把 `captureEngine` 的 store 讀寫提到呼叫端。**在補上之前，選項 A → B → C
的切換成本不是零**——每換一次持久層，`captureEngine` 都得跟著改一次。這件事在 TS 側
就能做，不需要 Swift、不需要 Xcode。

---

## 6. 遷移順序

**原則：不是一次重寫。每一階段要能單獨出貨、單獨回退，而且每一階段結束時
app 都是可用的。**

### 階段一（可以現在做，但不該在 8/17 之前做）：原生模組補洞，RN 全留

**做**：一顆 local Expo module，Swift 實作 `MPRemoteCommandCenter` 的 target 註冊，
把遙控事件 emit 給 JS。**不做任何 UI。**

**代價**（要事先知道，不是事後發現）：

- 這是**第一次真正的原生 build**。RUNBOOK 第 7 步列的三件事會一次踩完：註冊
  bundle id、開 capability、兩組 provisioning profile 重新產生。RUNBOOK 的原話是
  「**別在快沒時間的時候第一次跑**」。
- 從這一刻起，**改 Swift 不能 OTA**。改 JS 照舊。

**必須同時處理的一件事——`runtimeVersion`：**

`app/app.json` 現況是 `"runtimeVersion": { "policy": "sdkVersion" }`（已核）。
加了原生模組之後，原生內容變了但 SDK 版本沒變 → runtimeVersion 不變 →
EAS Update 會把新 JS 推給一個**沒有這顆原生模組的舊 binary**。

repo 現有的緩解手段是 **feature-detect，不是改 policy**：`lib/liveActivity.ts:673` 的
`checkEligibility()` 就是為此存在，回傳 `'native-module-missing'`（:691）/
`'ios-too-old'`（:688）/ `'activities-disabled'`（:695），原則是「所有原生呼叫都必須
feature-detect，模組不在就整段跳過，不准 crash」。同類先例在 `lib/selection.ts:293`
（「JS bundle 一定比 SQL 早到」）。

> ⚠️ **這道防線今天的呼叫端覆蓋率是 0。** 本輪 grep 核對：沒有任何檔 import
> `lib/liveActivity.ts`，所以 `checkEligibility()` 從沒被呼叫過（§3.1 末段同一件事）。
> 「舊 binary 收到新 JS 不會 crash」在有呼叫端並實測之前，**是待驗證，不是已成立**。
> 這也正是階段一驗收條件第三項存在的理由。

⚠️ **改 policy 是新提案，不是既有決定。** `targets/README.md` §3 與 ADR-0021 的原文
都是「若哪天要讓兩者強制對齊，得改成 `runtimeVersion.policy: "appVersion"`——
**那是另一個決策，要先寫 ADR**」。repo 內任何地方**都沒有出現 `fingerprint` 這個字**。
所以這一階段的正確動作是：**先 feature-detect（已有），要不要改 policy 另外寫 ADR 討論。**

**驗收條件：**

- [ ] 鎖定畫面按往回 → `replay_events` 出現 `trigger_source: 'lockscreen'` 的列
      （今天是 0 筆，所以這個驗收是二值的、無法自欺）
- [ ] `App.tsx` 的 250ms 推斷與兩道閘全部刪除，刪除後 lockscreen 事件數**不降反升**
- [ ] 舊 binary 收到新 JS 不閃退（feature-detect 生效）
- [ ] 寫一份 ADR **supersede ADR-0016**（它自己就寫了這個退場條件）

### 階段二：Live Activity 落地（**仍在 Expo repo**）

**做**：照 `app/targets/RUNBOOK.md` 第 1 → 8 步跑完。不重複那份文件的內容。

**驗收條件**：RUNBOOK 第 5 步（模擬器把答案檔 `cat` 出來）全綠，第 6 步（真機）
對兩個致命問題有明確答案。中止條件沿用 RUNBOOK 的四條，不另立。

**為什麼在 Expo repo 而不是等第二個 repo**：1,160 行 Swift 已經寫好，而且
§1 說了它搬不走。與其等，不如先讓它編一次——**第一次編譯本身就是最有價值的資訊**。

### 階段三：Phase 2 技術驗證（**第二個 repo 的第一件事**）

**做**：一個**只有** `AVAudioEngine` tap + ring buffer 的獨立 Swift app。
不接 Supabase、不做 UI、不做 SRS、不碰任何既有程式碼。

**為什麼獨立**：它要回答的是政策、耗電、與背景存活問題（§4.2 的三個未查證前提），
跟 Echo 的任何既有程式碼都無關。混進主 app 只會讓兩個未知綁在一起，出問題時
分不出是誰的錯。

**驗收條件：**

- [ ] 螢幕鎖定 + app 不在前景，連續 30 分鐘持續拿得到 PCM buffer
- [ ] Instruments 量出 30 分鐘的耗電數字（**是數字，不是「感覺還好」**）
- [ ] AirPods 手勢事件真的進得來
- [ ] 對 App Store 審查指南裡與背景麥克風相關的條文做過功課並寫成一頁

### 階段四：純函式移植 + 測試套件

**做**：把 §2.3 那組（約 1,200 行）翻成 Swift。順序是**先在 TS 側補測試，再翻**。

**為什麼是這個順序**：`CONTEXT.md` §4 已經記著「還沒有測試套件」並指名
`captureEngine` + `srs` 是最高價值目標。沒有測試的翻譯無法證明兩邊行為一致，
而 `hash.ts` 只要一位不同，既有的 `episode_id` 就全部失聯（§3.1）。

**驗收條件：**

- [ ] TS 側有測試，且**同一組測試向量**在 Swift 側逐條通過
- [ ] `cyrb53` 的溢位語意在兩邊逐位相同（拿真實的 guid 與 enclosure URL 當向量）
- [ ] 同一份 RSS feed，兩邊算出**逐字相同**的 episode id

### 階段五：逐畫面搬 UI

**做**：由外往內。相依最少的先搬（`PodcastBrowser` 587 → `HomeScreen` 767），
最後才是 `TranscriptScreen` 1,341（兩點框選手勢）與 `Practice` 1,498。

**真正的成本不是工時，是每搬一個畫面就少一次 OTA 的能力。** 這一階段開始之前，
產品迭代的節奏必須已經穩定到不需要「當天改、當天上線」——否則就是在拆掉自己
唯一的武器。

**驗收條件**（每一個畫面各驗一次）：

- [ ] 搬完之後，訊號數字（capture 總數、confirm rate 的白名單母體、型別分布）
      與搬之前**對得上**
- [ ] `types.ts` 那些鐵律（四級強度白名單、`confirm rate` 母體、`saved` 不進指標）
      在 Swift 側有對應的、會編譯失敗的守門

### 階段六：拿掉 RN

只有在階段五全部完成、且 JS bundle 已經沒有任何畫面在用時才發生。

**它不是一個目標，它是一個副產品。** 見 §7 第 5 條。

---

## 7. 什麼情況下不該遷移（放棄條件）

明確寫出來，因為「已經寫了 1,160 行 Swift」是這個專案最容易出現的沉沒成本謬誤——
而那 1,160 行**從未編譯過**，它的沉沒成本比看起來低得多。

**任一條成立，就停在當前階段，不要進下一階段：**

1. **8/17 之前。** 純 Swift 化在 Pre-Demo Day 之前**沒有任何價值**：投資人不會問
   技術棧，而失去 OTA 會讓最後幾天改不動東西。六週計劃的「絕不砍」清單是核心循環
   + 留存數據 + demo 影片——遷移不在上面。**階段一以外的任何一步都不該在 8/17
   之前開始。**

2. **階段三證實 `AVAudioEngine` 背景 tap 做不到，或過不了審查。**
   Phase 2 是遷移理由裡價值最高的兩項之一。如果背景常時聽被政策擋掉，剩下的理由
   只有「遙控事件」——而那顆 local module（階段一）就解決了，**不值得為它換語言**。

3. **迭代速度變成瓶頸而不是被解決。** 判準要事先寫死，否則事後一定有理由：
   連續兩週，Swift 側改動平均要等超過 30 分鐘才看得到（build + 上傳 + 測試者
   下載），而同期產品問題有超過一半是純 UI／文案。這代表遷移的方向反了。

4. **只剩一位開發者，而他寫 Swift 比寫 TS 慢。** 這不是技術判斷是人力判斷，
   但它比技術判斷更常決定結果。

5. **「拿掉 RN」變成目標本身。** 訊號很好認：某一週的計劃裡出現「把最後幾個畫面
   搬完」，而那些畫面沒有任何原生需求。**停下來。** 一個混合 app 是完全可以接受的
   終局狀態——原生做原生才做得到的（§4），RN 做能 OTA 的。

**另外一件不論任何階段都不該做的事**：用 Swift 重寫 UI 以求「更好的效能」。
瓶頸在 Whisper 轉錄——伺服器端一個 10 分鐘窗口 45–60 秒（`lib/transcript.ts` 檔頭
的實測記錄，也是預抓機制存在的理由）——不在渲染。用效能當遷移理由會讓上面五條
放棄條件全部失效，因為效能永遠可以再好一點。

---

## 8. 誠實紀錄：這份文件裡什麼被驗證過

與 ADR-0021 同體例。因為這個 repo 的複查已經抓過三次「宣稱了沒發生的事」。
（「三次」是呼叫端提供的；repo 內唯一寫下次數的 ADR-0021〈誠實紀錄〉當時記的是
**兩次**。別把它當成 repo 內可核對的數字。）

**本輪實際查證過的（本機檔案實讀）：**

- `plugins/withEchoWidget.js:282` 從 `projectRoot/targets/<targetName>` 讀檔，
  少檔就 `fail()` —— §1 的全部根據。
- `app/app.json` 的 `plugins` 是 `["expo-audio","expo-asset","expo-status-bar"]`、
  `runtimeVersion` 是 `{"policy":"sdkVersion"}`。**`withEchoWidget` 不在裡面，
  所以 `targets/` 與 `plugins/` 至今不會被任何建置流程碰到。**
- 各檔行數：`lib/` 19 檔 3,829 行；UI（`App.tsx` 751 + `screens/` 1,498 +
  `components/` 4,933）＝ 7,182 行；Edge Function 5 檔 751 行；migration 6 檔 537 行；
  `targets/EchoWidget/` 6 檔 1,160 行；`plugins/withEchoWidget.js` 575 行。
  §3.1 表格裡每一支 `lib/*.ts` 的個別行數也逐檔對過。
- ADR-0016 的 Context 段（`expo-audio` 的 remote handler 不經過 JS）、ADR-0004、
  ADR-0018、`targets/README.md` §1/§3/§7、`RUNBOOK.md` 的現況快照與步驟。
- **`captureEngine.ts` 不是純的**：`:30` import store，`:115`/`:169`/`:193`/`:233`
  讀寫 store。這一筆推翻了本文件初稿與 `CONTEXT.md` §4 的「pure」說法（§2.3、§5）。
- **`lib/liveActivity.ts` 沒有任何 import 它的檔**，所以 `checkEligibility()` 呼叫端為 0。
- **migration 006 確實未套用到線上**：對線上 PostgREST 打
  `captures?select=selection_text` 與 `?select=selection_kind` 都回 `42703`，
  對照 `?select=id` 正常回應。（兩個 CHECK 約束的內容 anon 端讀不到，那一項沿用
  `CONTEXT.md` §4。）

**本文件裡**沒有**被驗證的（依風險排序）：**

| # | 宣稱 | 狀態 |
| --- | --- | --- |
| 1 | 任何一行本文件描述的 Swift 程式碼 | **從未編譯。** 本機沒有 Xcode、沒有 iOS SDK |
| 2 | 「約 60 行 Swift 就能取代 ADR-0016 的推斷」 | 呼叫端估計，**未實作** |
| 3 | `AVAudioEngine` 背景 tap 的存活、耗電、審查政策 | **完全沒查證**，三項都是 |
| 4 | `SFSpeechRecognizer` 能讓 transcribe 成本歸零 | **完全沒查證**，不要寫進 pitch |
| 5 | `supabase-swift` 的匿名登入支援度 | **沒查證** |
| 6 | SwiftData 在 iOS 17 早期版本的 bug | **傳聞**，不是事實 |
| 7 | SwiftUI 的兩點框選手勢與現況等價 | **沒做過**，互動要重新測 |
| 8 | `targets/README.md` §7 裡**換語言後仍然存在**的 11 條（8 條原封不動 + 3 條變形） | 換語言只讓 ❌2 / ❌3 / ❌4 消失，其餘都還在——尤其 ❌11「Swift 能不能編譯」 |
| 9 | `MPSkipIntervalCommand.preferredIntervals = [15]` 能不能讓鎖定畫面的往回幅度對齊 app 內的 ↺15（§4.1 末段） | API 名稱正確，但**沒有在這個專案上試過**；`expo-audio` 自己已經註冊了一組 target，共存行為未驗證 |

**呼叫端提供、本輪查證失敗的數字**（引用時請維持這個標註）：最近一次 EAS Build
2026-08-04 / commit `5dd1ea4` / build number 2；`difficulty_items` 0 筆；真實使用者
1 位；11 筆 replay event 全是 `'screen'`、`'lockscreen'` 一筆都沒有。

> 本輪**有嘗試**複查後三項並失敗：`supabase-echo` MCP 回 token expired；改用 `.env` 的
> anon key 走 PostgREST 時，三張表的 `count=exact` 全部回 `*/0`——那是 RLS 把匿名身分
> 濾成 0 列（ADR-0013），**不是真實筆數**。要複查得重新授權 MCP，或用 service role key。

**同一輪核對出來、與 git 有出入的一筆**：呼叫端說「`5dd1ea4` 之後 8 個 commit」，
實測 `git rev-list --count 5dd1ea4..HEAD` = **10**。本文件不引用這個數字，
但相鄰的兩份文件會用到，以 10 為準。

> **這份是計劃，不是成果。** 它唯一稱得上「已驗證」的一句話是 §1 的那一句：
> `targets/EchoWidget/` 不能搬走。其餘全部是尚待證明的假設。
