# Expo → 原生：這個專案接下來怎麼走

- **建立日期：** 2026-08-14
- **狀態：** 主計劃文件（活的；每次 EAS Build 之後回來更新第 1 節）
- **讀者：** 沒參與過這個 repo 的工程師。照著第 3、4 節就能動手。

> 這份文件的定位：`docs/adr/` 記**單一決定**，`six-week-plan.md` 記**六週的行程**，
> 這一份記**「殼與原生碼要怎麼走」的全局路線**。三者衝突時，ADR 優先——它是 accepted 的。
>
> **寫作規則同 ADR：講為什麼與代價，不寫行銷詞。每個技術宣稱都要能對到檔案，
> 對不到的一律標「待驗證」。** 這個 repo 的複查已經抓過三次「宣稱了沒發生的事」。
>
> ⚠️ 這個「三次」是呼叫端提供的。repo 內唯一寫下次數的地方是 ADR-0021 的〈誠實紀錄〉，
> 它當時記的是**兩次**（第三次應是它之後才發生的）。引用時別把它講成 repo 內可核對的數字。

---

## 1. 現在在哪（誠實狀態表）

### 1.1 建置與原生碼

| 項目 | 現況 | 來源 |
| --- | --- | --- |
| 最近一次 EAS Build | **2026-08-04**，commit `5dd1ea4`，build number 2 | 呼叫端提供，本輪未重新查證 |
| 自那之後的 commit | **10 個**（`72c4d60` … `45e2383`）。其中 9 個是純 JS／伺服器端，**只靠 OTA 送達**；最後一個 `45e2383` 加的是原生藍圖，**不在任何 build 裡，既沒被 OTA 送出、也沒進殼** | `git rev-list --count 5dd1ea4..HEAD` = 10（本輪實跑） |
| 殼的年齡 | **10 天沒換** | 08-04 → 08-14。**注意 git 只證明得了 `5dd1ea4` 的日期**；「那之後沒再出過 build」屬呼叫端提供 |
| Xcode | **未安裝**。`xcode-select -p` → `/Library/Developer/CommandLineTools`；`xcodebuild -version` 回 `requires Xcode`；`CommandLineTools/SDKs/` 只有 `MacOSX*.sdk`，無任何 iPhoneOS SDK | **本輪實跑核對**（與 `RUNBOOK.md` 2026-08-13 的起點快照一致） |
| CocoaPods | 1.17.0 已裝 | **本輪實跑**：`pod --version` → `1.17.0` |
| `swiftc` | Apple Swift 6.0.3，target `arm64-apple-macosx15.0`——**只有 macOS target** | **本輪實跑**：`swiftc --version` |
| `targets/EchoWidget/` | 6 個 `.swift`，**共 1,160 行** | `wc -l`（本輪實跑核對，數字相符） |
| Swift 編譯狀態 | **從未編譯過。** 只通過 `swiftc -parse`（純語法，不解析 module、不做型別檢查） | ADR-0021「誠實紀錄」段 |
| `plugins/withEchoWidget.js` | 25,869 bytes，**從未在真實 `expo prebuild` 裡執行過** | ADR-0021；`ls -la app/plugins/` |
| `app.json` 的 `plugins` | `["expo-audio","expo-asset","expo-status-bar"]`——**沒有 `withEchoWidget`** | `app/app.json:41-45`（本輪核對） |
| `runtimeVersion` | `{"policy":"sdkVersion"}` → 值為 `exposdk:57.0.0` | `app/app.json:52-54`（本輪核對） |
| dependencies | **14**（預算上限，不准增加） | `node -e ...`（本輪實跑 = 14） |
| `lib/liveActivity.ts` | **沒有任何檔 import 它**，不在 Metro graph 裡 | 本輪 grep 核對：只有自身內部引用 |

> **`targets/` 與 `plugins/` 現在完全不會被任何建置流程碰到。**
> `expo prebuild` / `eas build` 跑起來跟這個資料夾不存在沒有兩樣（`RUNBOOK.md` §起點）。
> 這是**刻意的**，不是忘了接。

### 1.2 資料與使用者

| 項目 | 現況 | 來源 |
| --- | --- | --- |
| migration 006（框選訊號） | ❌ **未套用到線上**。`captures.selection_text` 與 `captures.selection_kind` 都回 `42703`（column does not exist） | **本輪實查（2026-08-14）**：拿 `.env` 的 anon key 對 PostgREST 打 `captures?select=selection_text` 與 `?select=selection_kind`，兩者皆回 `42703`；對照 `?select=id` 回 `[]`（欄位在、只是 RLS 濾成 0 列）。**兩個 CHECK 約束的內容本輪無法從 anon 端讀到，那一項仍沿用 `CONTEXT.md` §4 的紀錄** |
| ↳ 後果 | `saved` / `selected` 撞 `captures_strength_check`，`segmentation` 撞 `captures_selection_kind_check` → **三種手動指出的訊號在伺服器端一筆都沒有** | 同上 |
| ↳ 為什麼看不出來 | local-first（ADR-0004）讓使用者端一切正常，只有伺服器是空的 | 同上 |
| `difficulty_items` | **0 筆** | 呼叫端提供，**本輪查證失敗**（見下方註） |
| 真實使用者 | **1 位（創辦人本人）** | 呼叫端提供，**本輪查證失敗** |
| `replay_events` | **11 筆，全部是 `'screen'`**；`'lockscreen'` **一筆都沒有** | 呼叫端提供，**本輪查證失敗** |
| ↳ 後果 | ADR-0016 的「位置忽然往回」推斷自 08-08 上線至今**從未觸發** | 同上 |
| app icon | 仍是 Expo 範本預設圖，**設計參考線還印在上面** | 檔案存在且從未更新過可核對（`app/assets/icon.png`，mtime Jul 12）；「參考線印在上面」是呼叫端提供的目視結果 |

> ⚠️ **上面三個數字（11 / 0 / 1）本輪查不到根據，維持「呼叫端提供」。**
> 原因：`supabase-echo` MCP 回 `token expired`；改用 `.env` 的 anon key 走 PostgREST 時，
> `replay_events` / `difficulty_items` / `captures` 三張表的 `count=exact` 全部回 `*/0`
> ——那是 RLS 把匿名身分濾成 0 列的結果，**不是真實筆數**（ADR-0013：每一列都綁 owner）。
> 要複查得等 MCP 重新授權，或用 service role key 從伺服器端跑。
> **在複查之前，這三個數字不准當成本輪驗證過的事引用。**

### 1.3 計劃執行度

| 項目 | 現況 |
| --- | --- |
| `weekly-log/` | 只有 `TEMPLATE.md` 與 `W1.md`。**W2–W6 不存在**——「每週日更新」實際只執行過一次 |
| 可融資里程碑（`six-week-plan.md` 底部 5 條） | **五條全部還是未打勾的 `[ ]`** |
| ↳ 30+ 用戶 / D7 ≥25% | 實際 1 位 |
| ↳ ≥3 captures/日 / 完成率 ≥50% | `difficulty_items` 0 筆 |
| ↳ 90 秒 demo 影片（含真實生活模式） | `design/` 未見成品；真實生活模式在 RN 側**無實作** |
| ↳ accelerator 申請 / 投資人會議 | 屬 `docs/03-fundraising/`（🔒 本機保留），本輪未讀，不在此宣稱 |

### 1.4 一句話總結

**產品的核心迴圈（rewind → capture → daily session）在一台裝置上是活的；
所有「證明它是活的」的東西——伺服器資料、第二位使用者、原生訊號量測——都還不在。**

---

## 2. 三個階段，各自被什麼擋住

三階段來自 `docs/00-vision-and-angle.md`，共用同一套引擎：**capture → diagnose → practice**。

| 階段 | 載體 | Trigger | 現況 |
| --- | --- | --- | --- |
| 1. Podcast app | 手機 | 返回鍵 / 重聽行為 | **進行中** |
| 2. 真實生活模式 | AirPods 等耳機 | 耳機手勢（捏/敲） | 未開始 |
| 3. AR 眼鏡 ambient 教練 | XR/AR 眼鏡 | 手勢 / 語音 / 自動 | 願景 |

### Phase 1（現在）— 擋住的是「訊號的完整性」，不是功能

功能面該有的都有。真正的缺口是：**這個產品唯一在乎的訊號，有一段是推斷出來的，
而那段推斷從未觸發過。**

ADR-0016 記得很清楚：`expo-audio` 的 `MPRemoteCommandCenter` handler 在原生層直接呼叫
`AVPlayer.seek`，**完全不經過 JS**。所以鎖定畫面／控制中心／耳機線控的倒帶，
在 JS 這一側是憑空消失的。現行補救是每 250ms 取樣、看「位置忽然往回 > 3 秒」
（`App.tsx:88` 的 `EXTERNAL_REWIND_MIN_SEC = 3`，判定在 `App.tsx:378-384`）。

這套推斷**刻意偏向漏記而不是誤記**（ADR-0016 Consequences），理由正當：
幻覺事件會替一句從沒被重聽過的話建出 capture，比少一筆更傷。

代價是：**11 筆 replay event 全是 `'screen'`，`'lockscreen'` 一筆都沒有**（呼叫端提供）。
我們無法區分下面三種情況——

1. 使用者確實沒從鎖定畫面倒帶過；
2. 倒帶了但被兩道閘吃掉；
3. JS 被 iOS 暫停期間倒帶，整段沒被看到（ADR-0016 明列的已知漏洞）。

**分不出來這三種，就是 Phase 1 目前最實質的技術債。** 解法在第 4 節第 1 項。

### Phase 2（耳機真實生活模式）— 擋住的是 React Native 本身

`six-week-plan.md` W4 那一項「**真實生活模式 demo：背景 rolling buffer + AirPods 手勢**」
需要的是 `AVAudioEngine` 的 tap（持續拿到麥克風 PCM buffer 並保留最近 N 秒）。

**React Native 拿不到這個。** 這不是「還沒做」，是**跨不過去**：
- `expo-audio` 提供的是錄音檔案 API，不是即時 buffer tap；
- rolling buffer 要求持續持有解碼後的音訊資料並在記憶體裡環狀覆寫，這是 `AVAudioEngine`
  的 `installTap(onBus:)` 領域；
- AirPods 的捏/敲手勢要註冊 remote command target，與第 4 節第 1 項是**同一個原生機制**。

所以 Phase 2 的入場券就是「有人在這個 repo 裡寫 Swift 並且編得起來」。
今天這件事的完成度是 **0**（Xcode 未安裝、Swift 未編譯過）。

> **六週計劃已經替這一項寫好降級路徑**：風險與砍法第 2 條——
> 「真實生活模式 demo 改用**概念影片**呈現」。8/17 之前應該執行這條，理由見第 3 節。

### Phase 3（AR 眼鏡）— 沒有技術路徑，且刻意不該有

現在不存在可落地的路徑，也**不該**為它做任何工程投資。它在 pitch 裡的角色是
「同一套 capture → diagnose → practice 引擎的第三個載體」，論證靠的是 Phase 1、2
共用引擎這件事本身，不靠任何眼鏡程式碼。

**任何把 Phase 3 講成有實作的說法都是不實陳述。**

### 貫穿三階段的一條警告：測量比動機難

創辦人自己的 N=12 實驗（《Shadow Your Perfect Self》，CSIE7641 多模態 HCI 期末專案）
做三條件 shadowing：C1 母語陌生人 / C2 自己·母語腔 / C3 自己·L1 腔。結果是——

- **主觀上學習者壓倒性偏好自己的聲音**：C3 在 helpful / like-me / easiest / comfortable
  四個維度全部第一；C1 在任何維度都沒領先過。
- **客觀四指標不分離，而且互相矛盾。**

**原作者自己報的是 null result。** 引用這份研究時只能說「它支持 Mirror 的**動機**面
（人偏好自己的聲音）」，**不准講成「Mirror 有效」**——那是原文沒有支持的結論。

它真正的教訓對這份路線圖更有用：**瓶頸是測量，不是動機。**
這正好對上第 1.2 節（伺服器端沒有資料）與第 4 節第 1 項（把推斷換成量測）。

---

## 3. 8/17 Pre-Demo Day 之前的最後衝刺

**今天 2026-08-14（五）。Pre-Demo Day 2026-08-17（一），12 分鐘。剩 3 天。**

### 3.1 先講最重要的一個決定：Live Activity 走 Plan D，不做

`RUNBOOK.md` §中止條件寫著：

> | 距離 8/17 剩不到 3 天而第 5 步還沒全綠 | Plan D |

**嚴格說今天剛好是 3 天整（8/14 → 8/17），明天才字面上「剩不到 3 天」。但不必等到明天**
——第 5 步（模擬器）的前置是第 1 步（裝 Xcode），而 Xcode 現在連裝都還沒裝，光下載安裝
就是數小時等級，之後還有 1.1 型別檢查 → 3 prebuild → 4 pbxproj 逐項檢查 → 5 模擬器。
**3 天內走完並且全綠，不是保守估計的問題，是不成立。** 結論與觸發那條中止條件一樣，
只是理由是「前置根本沒開始」而不是「日曆到了」。

所以：

- ❌ **8/17 之前不准把 `withEchoWidget` 加進 `app.json`。**（`RUNBOOK.md` 第 2 步的 🔒 註記
  已經寫死：正本要等第 7 步全綠才改。）
- ❌ 8/17 之前不跑第一次 `eas build` with plugin。`RUNBOOK.md` 第 7 步標題就是
  「**別在快沒時間的時候第一次跑**」。
- ✅ RUNBOOK 本來就寫了：「Live Activity **不是 8/17 Pre-Demo Day 的必要條件**。
  既有的每日通知已經覆蓋『提醒』。」

> 🚨 **Plan C 的紅線一併重申**（`RUNBOOK.md`）：`expo-widgets` 的訊號是無佇列、無持久化的
> `NotificationCenter`，JS runtime 沒起來的那一按會**靜默丟失**。可以展示，
> **絕不可以**進 SRS 帳本，**絕不可以**在 pitch 裡講「每一次按壓都被接住」——
> 那正是本專案的核心主張，講錯的代價比技術債高得多。

### 3.2 一個必須先講清楚的區別：本機沒 Xcode ≠ 不能出 build

`eas build` **跑在 EAS 的雲端機器上**，不需要本機 Xcode。所以「本機沒 Xcode」擋住的是：

| 擋住 | 沒擋住 |
| --- | --- |
| `swiftc -typecheck`（第一次真型別檢查） | `eas build`（雲端） |
| `expo prebuild` 後的 pbxproj 逐項檢查 | `eas update`（OTA） |
| 模擬器測試、`simctl` 挖答案檔 | 純 JS/資產的重新 build |
| Instruments、符號化 crash report | |

**結論：不含 plugin 的重新 build（例如只換 icon）在 8/17 之前是可行的；
含 plugin 的第一次 build 不可行**——因為那條程式碼路徑一次都沒被真實 prebuild 跑過，
而本機沒有任何辦法先驗證它。

### 3.3 逐項衝刺清單

類型欄位：**OTA** = `eas update` 就夠｜**重 build** = 必須出新 binary｜
**伺服器** = 只動 Supabase，app 完全不用改｜**文件** = 不碰程式碼。

| # | 做什麼 | 類型 | 為什麼是現在 | 期限 |
| --- | --- | --- | --- | --- |
| 1 | **把 migration 006 套用到線上** | **伺服器** | 這是投報率最高的一項：JS 端**早就在送** `selected` / `saved` / `segmentation`，是伺服器在退件。套用之後這三種訊號立刻開始落地，**app 一個字都不用改、不用 OTA、不用 build**。不做的話 pitch 裡任何關於「框選訊號」的伺服器端數字都是 0 | 8/14 |
| 2 | 套用後**實際產一筆** `selected` 與一筆 `saved`，確認落地 | 驗證 | migration 從沒在任何地方跑過，套用即驗證。不驗證就等於把「已修好」建立在假設上 | 8/14 |
| 3 | **確認 demo 裝置拿到最新 OTA**（`preview` channel），並在 pitch 前**手動**檢查一次 | OTA | 殼是 8/04 的 build 2，之後 10 個 commit 沒有一個換過殼。demo 當下才發現沒更新是最廉價也最致命的失誤。repo 已有「顯示執行中的 bundle 版本 + 手動檢查更新」（commit `d45c472`），用它 | 8/16 |
| 4 | **創辦人集中 dogfood**，把 `difficulty_items` 從 0 做出真實筆數 | 使用 | demo 要有真資料。**但必須誠實標示 N=1**——把單人資料講成使用者數據是不實陳述 | 8/14–8/16 |
| 5 | 補寫 `weekly-log/` W2–W6 | 文件 | NTU Day 的發表材料來源就是這個資料夾；現在只有 W1 | 8/16 |
| 6 | app icon 換掉（**參考線還印在上面**） | **重 build** | 任何螢幕錄影或裝置實拍都看得到。技術上可行（雲端 build，不需本機 Xcode，且不碰 plugin），但要付 build + TestFlight processing + 重新安裝的成本 | 見下方判斷 |
| 7 | 真實生活模式 → **改用概念影片** | 文件／影片 | `six-week-plan.md` 風險與砍法第 2 條的既定降級路徑。Phase 2 在 RN 側無實作，硬做只會拖垮 8/17 | 8/16 |

**關於第 6 項（icon）的判斷**：這是這三天唯一值得考慮的重新 build。

- **做**：只要沒有其他原生改動一起夾帶進去，風險低（不碰 `plugins`、不碰 entitlements、
  dependencies 仍是 14）。換 icon 後 build number 變 3。
- **不做**：把 3 天全部留給第 1–5 項，icon 留到 8/17 之後與第一次 widget build 一起處理。
- **判準**：**8/15（六）中午之前**沒有啟動就不要啟動——TestFlight processing（5–30 分）
  加上重新安裝，越接近 8/17 越不該碰殼。

> ⚠️ **不論做不做第 6 項，都不准順手把 `withEchoWidget` 一起加進去。**
> 「反正都要 build 了」是這份路線圖最想擋掉的一種決策。

### 3.4 8/17 之前的每次改動都要跑的四道閘

來自 `RUNBOOK.md` 第 0 步，不需要 Xcode，30 秒：

```bash
APP="$(git rev-parse --show-toplevel)/app"
cd "$APP"
npx tsc --noEmit                                    # 必須通過
npx expo export --platform ios                      # 必須通過
node -e "console.log(Object.keys(require('./package.json').dependencies).length)"   # 必須是 14
node --check plugins/withEchoWidget.js              # plugin 的語法
```

> ⚠️ `expo export` 通過**不代表** `lib/liveActivity.ts` 是對的。本輪 grep 再次確認：
> **沒有任何檔 import 它**，所以它不在 Metro graph、也不在輸出的 `.hbc` 裡，
> 改壞了 export 照樣全綠。**真正涵蓋它的只有 `tsc --noEmit`。**

---

## 4. 8/17 之後的原生化路徑（按投報率排序）

**前提：第 0 項是所有其他項目的共同前置。**

### 第 0 項（前置）— 裝 Xcode，跑 `RUNBOOK.md` 第 1 步與 1.1

| | |
| --- | --- |
| **工時量級** | 半天（多數是下載安裝等待） |
| **前置條件** | 無。磁碟空間 |
| **完成的定義** | `xcrun --sdk iphoneos --show-sdk-version` 有輸出；`xcrun simctl list runtimes \| grep iOS` 至少一個 **≥ 17.0** |

裝完**第一件事是切 developer directory**，否則所有 `xcrun` 還是指向 CLT：

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

接著跑 `RUNBOOK.md` 第 1.1 步——**它自己標注「這一步是本 runbook 最划算的一步」**：

```bash
cd "$APP"
swiftc -typecheck \
  -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -target arm64-apple-ios17.0-simulator \
  targets/EchoWidget/*.swift
```

六個檔要一起餵（它們互相引用）。過了這一步，「Swift 能不能編譯」就從**完全未知**
降級成「還沒連結、還沒跑起來」。**在這之前不要開始 prebuild**——編不過時會分不清
是 Swift 的錯還是 plugin 的錯。

> 預期會在這裡第一次看到的錯（本機從來沒機會知道對不對）：`.invalidatableContent()`、
> `activity.content.state`、`@Parameter` 用 `Int` 這三個 API 的正確性。

---

### 第 1 項 ★ 最高投報率 — 把核心訊號從**推斷**變成**量測**

| | |
| --- | --- |
| **是什麼** | 自己註冊 `MPRemoteCommandCenter` 的 target，在原生層攔到 remote command 後 emit 事件給 JS |
| **規模** | **約 60 行 Swift**（估計值，待實作確認） |
| **工時量級** | 1–2 天（含第一次真機驗證） |
| **前置條件** | 第 0 項；一次成功的原生 build |
| **刪掉什麼** | `App.tsx` 的整套位置推斷（`EXTERNAL_REWIND_MIN_SEC`、兩道 seek 閘、`lastTimeRef` / `lastCommandedRef`），以及 ADR-0016 的推斷段落 |

**為什麼排第一**：它把產品的**核心主張**從「我們推測他倒帶了」變成「我們量到他倒帶了」。

現況是 11 筆 replay event 全是 `'screen'`（呼叫端提供）——推斷路徑從 08-08 上線至今
**從未觸發**。做完這一項之後，`trigger_source: 'lockscreen'` 才會是真的量測值，
而且 ADR-0016 自己已經寫好了退場條件：

> 「真的要滴水不漏，得等 `expo-audio` 把 remote command 以事件送進 JS（上游議題），
> **到時這整套推斷就可以拆掉並 supersede 這份**。」

**我們自己寫那 60 行，就是不等上游。** 完成後要寫 ADR **supersede ADR-0016**
（不是 amend——推斷機制整個被移除，不是被擴充）。

**額外收穫**：這個機制與 Phase 2 的 AirPods 手勢是**同一個 API 面**，
所以第 1 項做完等於替第 2 項鋪好了一半的路。

---

### 第 2 項 — Phase 2 的全部（背景 rolling buffer + AirPods 手勢）

| | |
| --- | --- |
| **是什麼** | `AVAudioEngine` 的 `installTap`，環狀保留最近 N 秒 PCM；手勢觸發時把 buffer 落地成 capture |
| **工時量級** | **2–4 週**（新的原生子系統，不是補丁） |
| **前置條件** | 第 0 項、第 1 項（共用 remote command 機制）；麥克風背景權限；耗電剖析 |
| **擋住什麼** | **這是 Phase 2 的唯一入場券**，React Native 完全做不到 |

`six-week-plan.md` W4 的「真實生活模式 demo」就是這一項。8/17 之前走概念影片（第 3.7 項），
**8/17 之後這是最大的一塊工程**，也是 pitch 裡「Phase 2 不是 PPT」的唯一實證。

**要先解的兩個非程式問題**（都不是寫 code 能繞過的）：
1. **耗電**。背景常駐音訊 tap 是這個 app 最真實的耗電風險，要用 Instruments 實測
   （見第 5 項）。
2. **隱私與同意**。持續錄下日常對話牽涉到對話另一方。這是產品／法務議題，
   **必須在寫 code 之前有明確立場**，不能等做完再補。

---

### 第 3 項 — Live Activity（藍圖已在 `targets/`）

| | |
| --- | --- |
| **是什麼** | 鎖屏複習卡。1,160 行 Swift + 25.8KB config plugin **已經寫好** |
| **工時量級** | 3–5 天（大部分是驗證，不是寫 code） |
| **前置條件** | 第 0 項；然後**嚴格照 `RUNBOOK.md` 第 1→8 步，不准跳步** |
| **風險** | **14 條完全沒驗證過的事**（`targets/README.md` §7），其中 2 條可能推翻整個設計 |

程式碼已備好，所以看起來像「快贏」——**它不是**。`targets/README.md` §7 列了 14 條
未驗證項，兩條是設計級的：

1. **鎖定畫面上、Face ID 已辨識但尚未上滑時，按鈕能不能觸發 intent。**
   Apple 原話：「On a locked device, buttons and toggles are inactive and the system
   doesn't perform actions unless a person authenticates and unlocks their device.」
   若每題都要主動解鎖，「鎖屏秒答」的賣點基本不成立。**官方文件與論壇都沒有明確答案。**
2. **`LiveActivityIntent` 背景喚醒 app 行程時，會不會連帶冷啟 Hermes + 載入整包 JS bundle。**
   若會，背景視窗可能不夠或被 jetsam 回收。**這是本設計最大的未驗證假設。**

兩條都**只有真機能回答**。所以這一項的工時裡，寫 code 是 0，驗證是全部。

> 這一項落地時，OTA 界線正式改變——見第 5 節。**同一個 commit 必須處理 `runtimeVersion`。**

---

### 第 4 項 — 端上語音辨識（`SFSpeechRecognizer`）｜**待評估，不是決定**

| | |
| --- | --- |
| **假說** | 端上辨識可能讓 `transcribe` 的 Whisper 成本趨近於零 |
| **工時量級** | **先花 1 天做可行性驗證**，再談實作 |
| **前置條件** | 第 0 項 |
| **狀態** | ⚠️ **未查證。以下每一條都是要去驗的問題，不是已知答案。** |

要驗的問題：
1. 端上辨識的**準確度**夠不夠支撐難點診斷？（ADR-0005 的窗口化轉錄餵的是 Claude 診斷，
   逐字稿品質直接決定診斷品質）
2. 有沒有**時長 / 連續辨識**限制？
3. 能不能對**非即時的音檔**跑，還是只能對麥克風輸入？
4. 端上跑的**耗電與發熱**代價是多少？
5. 它能不能給**句子級時間戳**？——ADR-0005 的整條管線依賴 `TranscriptSegment` 的時間戳。

> **在這五題有答案之前，不准在任何文件、pitch 或成本模型裡宣稱「轉錄成本可以歸零」。**
> 目前的事實是：`transcribe` Edge Function 已經做了窗口化，把 148 分鐘一集約 $0.89
> 降到單次窗口上限約 $0.06。那個數字是已實作的，這一項是**可能的下一步**。

---

### 第 5 項 — Xcode 工具鏈本身

| | |
| --- | --- |
| **工時量級** | 0（第 0 項的附帶收穫） |
| **前置條件** | 第 0 項 |

裝了 Xcode 之後直接多出來的三件事，每一件都在解一個現在無解的問題：

| 工具 | 解什麼 |
| --- | --- |
| **Instruments 耗電剖析** | 背景音訊 app 的**真實風險**。第 2 項沒有它就是盲飛 |
| **符號化 crash report** | 現在拿到 crash 只有位址。原生碼一落地，這是唯一的除錯面 |
| **`expo run:ios` 迭代** | 改一行 Swift 的迴圈從「雲端 build 約 15 分鐘」變成「約 30 秒」 |

---

### ❌ 明確不該做：用 Swift 重寫 UI

**兩個獨立的理由，任一個單獨成立就足以否決：**

1. **會失去 OTA——6 週窗口內最大的武器。** 現在 `app/` 底下每一個字都推得動
   （8/04 之後 10 個 commit，殼一次都沒換過）。UI 一旦變原生，每個視覺微調都要重新
   build + 重新安裝。
   ADR-0018 已經為了保住這件事，**放棄了第一方的 `expo-blur` / `expo-linear-gradient`**，
   改用疊層自己做玻璃材質。用 Swift 重寫 UI 會讓那個決定失去意義。
2. **瓶頸不在渲染。** 真正的等待是 Whisper 轉錄（伺服器端）。重寫 UI 不會讓它變快一毫秒。

---

## 5. OTA 界線的完整說明

### 5.1 為什麼 OTA 在 iOS 上合法（機制，不是灰色地帶）

iOS 禁止執行下載來的機器碼，三道各自獨立的限制：

1. **程式碼簽章涵蓋每一頁可執行記憶體**；
2. **W^X**——一頁記憶體不能同時可寫又可執行，第三方 app 沒有 JIT 權限；
3. **審查指南 2.5.2**。

但 **2.5.2 明文豁免「由 WebKit / JavaScriptCore 執行的腳本」**。

機制上的關鍵：**JS bundle 對 iOS 而言是「資料」不是「程式碼」。**
Hermes VM 本身是已簽章的機器碼，它只是去讀那包資料。
**換資料不動簽章 → OTA 合法且技術可行。**

反過來：**改 Swift → 機器碼變了 → 簽章失效 → 必須重新簽章 → 新 binary。**
這不是 Expo 的限制，是平台的。沒有任何工具能繞過。

### 5.2 TestFlight 的正確描述（常見誤解，要更正）

| | 人數上限 | 需要審核嗎 |
| --- | --- | --- |
| **Internal Testing** | 100 | ❌ **不需要審核** |
| **External Testing** | 10,000 | ✅ 需要 Beta App Review |

**但兩者都要付這些成本**：編譯 + 上傳 + Apple processing（5–30 分）+ **測試者重新下載**。

所以「Internal Testing 不用審核」**不等於**「重新 build 很便宜」。
最後那一項——要測試者重新裝一次——才是 6 週窗口裡真正貴的部分。
`eas.json` 的 `preview` profile 就是 `distribution: "internal"`。

### 5.3 判斷法則：這次改動要不要重 build？

**一條規則就夠：改動最後會不會進到 `.ipa` 的二進位或 bundle 資源裡？**

| 改了什麼 | `eas update` 夠嗎 | 為什麼 |
| --- | --- | --- |
| `lib/`、`screens/`、`App.tsx` 等 JS/TS | ✅ 夠 | OTA 更新的就是 JS bundle |
| JS 端 import 的圖片／字型等資產 | ✅ 夠 | 走 Metro，算 bundle 的一部分 |
| Supabase migration、Edge Function | ✅ **連 OTA 都不用** | 伺服器端，app 完全不參與 |
| `targets/EchoWidget/*.swift` | ❌ **一定要重 build** | Swift 編進 `.appex` 二進位，OTA 根本不含原生碼 |
| `plugins/withEchoWidget.js` | ❌ **一定要重 build** | 它只在 prebuild 時執行 |
| `app.json` 的 `plugins` / entitlements | ❌ **一定要重 build** | 同上 |
| **app icon**、`Info.plist`、bundle id、權限描述字串 | ❌ **一定要重 build** | 原生 bundle 資源，不在 JS bundle 裡 |
| 新增任何**原生**依賴（dependencies 14 → 15） | ❌ **一定要重 build** | 這正是 ADR-0018 放棄 `expo-blur` 的理由 |

> **repo 已有「顯示執行中的 bundle 版本 + 手動檢查更新」（commit `d45c472`）。
> 不要因為看到 bundle 版本更新了，就以為鎖定畫面（或 icon、或任何原生東西）
> 也跟著更新了——那是兩件事。**

### 5.4 `runtimeVersion`：現況、風險、以及一個**尚未成為決定**的提案

#### 現況

```jsonc
// app/app.json:52-54
"runtimeVersion": { "policy": "sdkVersion" }   // → exposdk:57.0.0
```

#### 風險（這是這一節存在的理由）

啟用 `withEchoWidget` 之後，**原生內容變了，但 Expo SDK 版本沒變** → `runtimeVersion`
**不會改變** → EAS Update 會把新的 JS bundle 推給**沒有 EchoWidget extension 的舊 binary**。
那些 app 裡沒有原生模組、沒有 extension、`Activity<>` 也不存在。

#### repo 目前的緩解手段是 feature-detect，不是改 policy

`lib/liveActivity.ts:673` 的 `checkEligibility()` 就是為此存在，回傳三種 reason：
`'native-module-missing'`（:691）／`'ios-too-old'`（:688）／`'activities-disabled'`（:695）。
原則是「**所有原生呼叫都必須 feature-detect，模組不在就整段跳過，不准 crash**」。
同類風險在 `lib/selection.ts` 檔頭已有先例（「JS bundle 一定比 SQL 早到」）。

> ⚠️ **但這道防線本身也是待驗證的。** 本輪 grep 確認：**沒有任何檔 import
> `lib/liveActivity.ts`**，所以 `checkEligibility()` 的呼叫端**還不存在**。
> feature-detect 的效力等於它的呼叫端覆蓋率——今天那是 0。
> 「feature-detect 擋得住」在有呼叫端並實測之前，不能當成已成立。

#### repo 白紙黑字寫的退路是 `appVersion`

`docs/adr/0021` :160 與 `app/targets/README.md` :138 兩處講的是同一件事（**用字不完全相同**，
README 那份多給了一條退路）：

> ADR-0021:160 —「若哪天要讓兩者強制對齊，得改成 `runtimeVersion.policy: "appVersion"`——
> **那是另一個決策，要先寫 ADR。**」
>
> README.md:138 —「如果哪天想讓兩者強制對齊，得改成 `runtimeVersion.policy: "appVersion"`
> **或手動指定字串**——那是另一個決策，要先寫 ADR。」

#### 📌 提案（**新的，尚未 accepted**）：改成 `fingerprint` 而不是 `appVersion`

> **必須講清楚的界線：`fingerprint` 這個字在整個 repo 的文件與設定裡一次都沒出現過**
> （本輪 grep 全庫核對：只在 `package-lock.json` 以套件名出現）。
> **它不是這個 repo 的既有決定。** 以下是提案與理由，落地前**必須先寫 ADR-0022**。

**為什麼 `fingerprint` 比 repo 原本寫的 `appVersion` 好：**

| | `appVersion` | `fingerprint` |
| --- | --- | --- |
| 何時改變 | `app.json` 的 `version` 被**人手動**改動時 | **原生輸入的雜湊**改變時（config plugin、原生依賴等） |
| 對應的失敗模式 | 加了原生 target 但**忘記** bump version → **同一個 bug 原封不動再發生一次** | 加了原生 target → 雜湊自動改變 → OTA 自動不會送到舊 binary |
| 本質 | **人的紀律** | **機制** |

這個 repo 的問題正是「原生內容變了但版本號沒變」。`appVersion` 只是把「記得改版本號」
這個責任交還給人；`fingerprint` 讓它變成自動的。**用機制取代紀律，是這裡的核心理由。**

**成本要一起講清楚：**

- `runtimeVersion` 變成不透明的雜湊值，人眼看不出兩個 build 相不相容，只能靠工具算。
- **任何**原生輸入改變都會切斷 OTA——包含例行的依賴升版。也就是說，沒有跟著更新 binary
  的使用者會被**更頻繁地**從 OTA 通道上切掉。這正是它的作用，但也是它的代價。
- build 端與 update 端必須用**相同版本的工具**計算指紋，否則兩邊算出來的值對不上。

**可行性（本輪實際核對，不是記憶）：**

- ✅ `fingerprint` 是安裝版 SDK 57 合法的 policy 值：
  `node_modules/@expo/config-types/build/ExpoConfig.d.ts:37`
  → `policy: 'nativeVersion' | 'sdkVersion' | 'appVersion' | 'fingerprint'`
- ✅ 機制已安裝：`node_modules/expo-updates/utils/build/resolveRuntimeVersionAsync.js`、
  `createFingerprintForBuildAsync.js`
- ✅ **不增加 dependency**：`@expo/fingerprint@0.20.6` 已經是 `expo` 自己的直接依賴
  （`node_modules/expo` → `^0.20.6`），已在 `node_modules` 裡。
  **dependencies 維持 14，預算不破。**
- ⚠️ **待驗證**：本輪**沒有實跑過** `fingerprint` policy 的 build 或 update。
  以上四點證明「它是合法選項且工具在位」，**不證明它在這個專案跑得起來**。

**時機——這是這整段最關鍵的一句話：**

> **改 `runtimeVersion` 必須與「把 `withEchoWidget` 加進 `app.json`」在同一個 commit 裡。**

- **不能更早**：現在就改，會讓 8/04 那個 build 2 的安裝立刻從 OTA 通道上被切掉，
  而它現在是唯一在跑的殼。**毫無理由地失去這三天的 OTA 能力。**
- **不能更晚**：兩者之間的**每一分鐘**都正好是那個 crash 窗口——原生內容已經變了，
  但 `runtimeVersion` 還沒跟上，OTA 照送。
- 對應到流程上，就是 `RUNBOOK.md` **第 8 步**（第 3–7 步全綠之後才改正本 `app.json`）。
  **改完要重跑第 0 步的四道閘再 commit。**

---

## 6. 風險登記簿

**「誰負責」欄位的說明**：今天這個專案的工程資源是**一個人**（真實使用者也是同一個人）。
所以這一欄寫的是**做這件事時戴哪頂帽子**，以及**真相來源在哪個檔**——
如果之後有第二位工程師加入，這一欄就是切分線。

| # | 現象 | 根因 | 緩解 | 誰負責 |
| --- | --- | --- | --- | --- |
| R1 | `'lockscreen'` 訊號 11 筆裡 0 筆，推斷從 08-08 起從未觸發 | `expo-audio` 的 remote command handler 在原生層直接 `AVPlayer.seek`，不經過 JS（ADR-0016）；位置推斷刻意偏向漏記 | **短期**：接受，並在 pitch 中只引用 `'screen'` 的數字。**長期**：第 4 節第 1 項，約 60 行 Swift 換成真量測，完成後 supersede ADR-0016 | 原生／iOS。真相來源 `docs/adr/0016` |
| R2 | 三種手動指出的訊號在伺服器端一筆都沒有 | migration 006 未套用線上；`saved`/`selected` 撞 `captures_strength_check`，`segmentation` 撞 `captures_selection_kind_check` | 套用 006（第 3.3 節第 1 項，**伺服器端，不需 build 也不需 OTA**），並實際產一筆驗證 | 後端／資料。真相來源 `CONTEXT.md` §4 |
| R3 | 資料問題對使用者完全不可見，可能再次長期潛伏 | local-first（ADR-0004）：`store.ts` 是唯一真相，Supabase 是 fire-and-forget，寫失敗不影響 UI | 建立**定期比對**本機筆數與伺服器筆數的習慣；R2 修好後第一件事就是比對一次 | 後端／資料。真相來源 ADR-0004 |
| R4 | 一次原生 build 都沒跑過，1,160 行 Swift 從未編譯 | 本機無 Xcode、無 iOS SDK；`swiftc -parse` 只證明語法合法 | **8/17 之前不碰**（第 3.1 節，RUNBOOK 中止條件已觸發）。之後照 RUNBOOK 第 0→1.1 步，型別檢查是最划算的一步 | 原生／iOS。真相來源 `RUNBOOK.md` |
| R5 | 啟用 plugin 後 OTA 把新 JS 推給沒有 extension 的舊 binary | `runtimeVersion` 是 `sdkVersion`，加原生 target 不改變它 | 三層：① feature-detect（`checkEligibility()`，但**呼叫端還不存在**）② `runtimeVersion` 提案（第 5.4 節，**需先寫 ADR-0022**）③ 兩者必須與 plugin 啟用**同一個 commit** | 原生／iOS。真相來源 `docs/adr/0021` Consequences |
| R6 | 鎖定畫面按鈕可能根本不觸發 intent | Apple：「On a locked device, buttons and toggles are inactive…」官方文件與論壇皆無明確答案 | **只有真機能答**（RUNBOOK 第 6 步）。證實不作用 → 改動態島展開作答，或整個功能回 app 內 | 原生／iOS。真相來源 `targets/README.md` §7 ❌1 |
| R7 | 背景喚醒可能冷啟 Hermes + 整包 bundle，答案沒寫完就被 jetsam 砍 | `perform()` 是純 Swift，但**行程的啟動路徑不是我們控制的**。找不到任何一手文件 | **本設計最大的未驗證假設**。RUNBOOK 第 6 步實測；證實被砍 → Plan D | 原生／iOS。真相來源 `targets/README.md` §7 ❌2 |
| R8 | 加 widget extension 破壞主 app 的 Embed Frameworks，一啟動就被 dyld 殺 | apple-targets #194 的死法（RN 0.83+；**我們是 RN 0.86**）。我們的 plugin 是「只加不動」，但**沒有任何本機方法可以證明** | 第一次真機啟動即見真章。確認是它就**立刻停手改走 Plan B**（`react-native-widget-extension`），不要手改 `ios/` | 原生／iOS。真相來源 `RUNBOOK.md` 排錯 ② |
| R9 | 按鈕看得到、按下去毫無反應，build 全綠無錯誤訊息 | 共用檔沒編進主 app target。**這是唯一的靜默失敗模式** | RUNBOOK 第 4 步的 `grep -c` 對照：三個共用檔**必須是 4**，三個 extension-only 檔**必須是 2**。量到 `2` 就是壞掉那個形狀的簽名 | 原生／iOS。真相來源 `RUNBOOK.md` 第 4 步（該組數字以此為準） |
| R10 | demo 當下裝置跑的不是最新版 | 殼是 8/04 的 build 2，之後 10 個 commit 沒有一個換過殼；OTA 生效時機不由我們控制 | pitch 前**手動**檢查更新（用 commit `d45c472` 的功能），且**不在 8/16 之後改動任何東西** | 產品／pitch |
| R11 | pitch 把未發生的事講成已發生 | 這個 repo 的複查**已經抓過三次**同類問題 | 三條硬規則：① Swift **沒編譯過** ② plugin **沒跑過真實 prebuild** ③ 真實生活模式**在 RN 側無實作**。另外**永遠不准寫「四選一」**——正式名稱是「三選一 + 想不起來」（猜對率 33%） | 產品／pitch。真相來源 `targets/README.md` §8 |
| R12 | 把 N=12 研究講成「Mirror 有效」 | 主觀偏好顯著（C3 四項全第一）容易被讀成效果 | **原作者自己報的是 null**：客觀四指標不分離且互相矛盾。只能引用為**動機**證據，結論是「**瓶頸是測量，不是動機**」 | 產品／pitch |
| R13 | 把 N=1 的 dogfood 資料講成使用者數據 | 真實使用者 1 位、`difficulty_items` 0 筆，但 demo 需要畫面上有東西 | 任何數字都標注 N；里程碑表五條**全部仍是 `[ ]`**，不打勾 | 產品／pitch。真相來源 `six-week-plan.md` |
| R14 | 為了「反正都要 build 了」而順手夾帶原生改動 | 重新 build 成本高，心理上會想一次做完 | **一次 build 只解一個變因。** 8/17 前若做 icon build，**不准同時加 `withEchoWidget`**（第 3.3 節第 6 項） | 原生／iOS |
| R15 | dependencies 從 14 變 15 | `expo-dev-client`、`expo-blur` 等都很有理由被加 | 14 是硬預算（ADR-0018 / ADR-0021 都以它為理由）。RUNBOOK 第 0 步把它列為每次必跑的四道閘之一 | 原生／iOS |
| R16 | 背景音訊 app 耗電失控 | Phase 2 的 `AVAudioEngine` tap 常駐 | **Instruments 耗電剖析**（第 4 節第 5 項）。沒有它就是盲飛——這也是第 0 項的附帶價值之一 | 原生／iOS |
| R17 | 「端上辨識讓轉錄成本歸零」被當成已知事實寫進成本模型 | 這是**未查證**的假說 | 第 4 節第 4 項列了五個必須先回答的問題。**在有答案之前不准寫進任何文件或 pitch** | 原生／iOS |
| R18 | demo 機 iOS < 17.0 | Live Activity 按鈕是 iOS 17+ API；16.4–16.9 會看到一張**沒有按鈕、無法作答**的卡——比不顯示更糟 | demo 前確認裝置版本。（8/17 走 Plan D 的話本項暫時不適用，但第 3 項落地時必須回來看） | 原生／iOS。真相來源 `targets/README.md` §7 ❌10 |

---

## 7. 決策紀錄：這份文件產生了哪些待寫的 ADR

| 提案 | 內容 | 何時寫 |
| --- | --- | --- |
| **ADR-0022** | `runtimeVersion` 改用 `fingerprint` policy（第 5.4 節）。**目前 repo 寫的退路是 `appVersion`，`fingerprint` 是新提案** | 與啟用 `withEchoWidget` 的同一個 commit **之前** |
| **supersede ADR-0016** | 自寫 remote command target，移除整套位置推斷（第 4 節第 1 項） | 那 60 行 Swift 在真機驗證通過之後 |

> 兩份都**還沒寫**。在它們 accepted 之前，`app.json` 的 `runtimeVersion` 維持 `sdkVersion`，
> ADR-0016 的推斷機制維持有效。

---

## 8. 這份文件沒有涵蓋的事

- `docs/03-fundraising/`、`docs/04-research/`、`docs/01-product/competitors.md`、
  `architecture.md`（🔒 本機保留、不在公開 repo）——本輪未讀，不在此做任何宣稱。
- Android。`app.json` 有 Android 設定，但三階段願景與所有原生工作都以 iOS 為前提
  （ADR-0001）。Android 至今**沒有任何 build**。
- 測試套件。`CONTEXT.md` §4 列為技術債：**還沒有測試套件**，而 `captureEngine` 與 `srs`
  是純函式、是最高價值的單元測試目標。這件事不需要 Xcode、不需要 build，
  但也不在 8/17 之前的關鍵路徑上。
