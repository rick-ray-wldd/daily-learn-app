# TestFlight 外部測試送審 —— 全部文案與流程

- **建立日期：** 2026-08-18
- **狀態：** 可執行（文案可直接複製）。**§2 的檢查清單有兩項是紅燈，沒清掉不要按送出。**
- **讀者：** 執行送審的人（現在是創辦人本人）
- **範圍：** External Testing（10,000 人上限、公開連結）→ 需要 **Beta App Review**。
  Internal Testing（100 人）不需要審核，這份文件不處理它。

> 寫作規則同 ADR：講為什麼與代價，不寫行銷詞。每個技術宣稱都要對得到檔案，
> 對不到的標「待驗證」。**本文所有「已核對」的欄位都在 §5 列出對應檔案與行號。**

---

## 0. 送審當下的事實基準（2026-08-18 實查）

送審文案會被審查人員拿去對照 app 的真實行為，所以先把「app 現在真的是什麼樣子」釘死。
下面每一列都是本輪實際讀檔核對的，不是沿用舊文件。

| 項目 | 現況 | 來源 |
| --- | --- | --- |
| bundle id | `com.rickray.echo` | `app/app.json` |
| 顯示名稱 | `Echo` | `app/app.json` |
| version / buildNumber | `version: "1.0.0"`，但 `appVersionSource: "remote"` → **版本號的真值在 EAS 伺服器上，不是 app.json**；`production` profile 有 `autoIncrement: true` | `app/app.json`、`app/eas.json` |
| `usesNonExemptEncryption` | `false` ✅ | `app/app.json` → `ios.config` |
| 麥克風用途字串 | 已填（繁中） | `app/app.json` → `ios.infoPlist.NSMicrophoneUsageDescription` |
| 登入 | 匿名，首次啟動自動 `signInAnonymously()`，**沒有登入畫面、沒有輸入框** | `app/lib/supabase.ts:70` |
| 分頁 | 首頁 / 探索 / 練習 | `app/App.tsx:76-79` |
| 通知：每日提醒 | **真的存在**，每天 08:00 本地時間，純文字無按鈕 | `app/lib/notifications.ts:122-160`；呼叫端 `App.tsx:506`、`screens/Practice.tsx:722` |
| 通知：題目通知 | 互動式，3 選項 + 「想不起來」，四顆按鈕全部 `opensAppToForeground: true` | `app/lib/notifications.ts:400-410` |
| 通知權限詢問時機 | **首次啟動就跳**（開 app → effect 呼叫 `syncQuizNotifications` / `syncDailyReminder` → `ensurePermissions`） | `app/App.tsx:502,506` → `lib/notifications.ts:107-121` |
| 麥克風權限詢問時機 | **只在練習頁按下錄音時**才跳 | `app/screens/Practice.tsx:778` |
| 示範題延遲 | **12 秒** | `app/App.tsx:1110` `DEMO_QUIZ_DELAY_SEC = 12` |
| DevProbes 面板入口 | 首頁**右上角**灰色小字 `倒帶 N 筆 · 題目 N`，點一下展開 | `app/App.tsx:909`、`1152-1225` |
| 示範鎖屏卡按鈕 | **會回報原生模組不存在**——`withEchoWidget` 不在 `app.json` 的 `plugins` 陣列裡，Swift 端從未編譯過 | `app/app.json`（plugins 只有三個）、`app/lib/liveActivityNative.ts:22-23` |
| 內建示範集 | 3 集：Huberman Lab Essentials（有現成逐字稿，秒開）、NPR Planet Money、LibriVox 公共領域有聲書 | `app/lib/episodes.ts:32-66` |
| 探索頁難度帶 | 存在（`LevelChip` + 等級底色），搜尋結果與單集列都有 | `app/components/PodcastBrowser.tsx:279-305, 436-471` |
| dependencies | 14（硬上限） | `app/package.json` |
| 介面語言 | **只有繁體中文**。學習素材是英文 podcast | 全 app 目視 |

> ⚠️ **審查人員大機率不懂中文。** 這不是加分題，是 §2 風險 4 的根源：
> Review Notes 必須用英文寫，而且要把每個中文按鈕的字面值原樣抄進去，
> 讓他能在畫面上「比對字形」找到按鈕，而不是靠讀懂。

---

## 1. Test Information 逐欄文案

位置：**App Store Connect → 你的 App → TestFlight → Test Information**。
這一頁的內容是**整個 app 共用的**（不是每個 build 一份），改了會套用到所有 build。

> 字數上限：以 App Store Connect 當場顯示的計數器為準（三個大欄位都在 4,000 字元量級）。
> 下面每一段都遠低於上限。

### 1.1 Beta App Description（測試者會看到）

App Store Connect 的這一欄**只有一格**，不分語言。作法：
**中文在前、英文在後，中間用一條分隔線**——測試者以華語圈 cohort 為主，
但公開連結會被轉出去，英文段是給轉出去之後的人看的。

<!-- ↓↓↓ 直接複製這一整段（含分隔線）↓↓↓ -->

```text
Echo 是一個把「重聽」當成訊號的 podcast 英語學習 app。

你聽 podcast 時每按一次「往回 15 秒」，Echo 就記下那個位置——那裡很可能是你沒聽懂
的地方。這些位置會被切成句子、送去轉錄與診斷，隔天變成你的練習卡片。

這輪 beta 想知道三件事：
1. 「往回 15 秒」有沒有被穩定地記成訊號（app 內就看得到計數）
2. 練習卡的三段漸進揭露（形狀遮罩 → 提示 → 原句）會不會真的讓你想起來
3. 鎖屏通知出題，能不能讓你在不打開 app 的情況下複習

已知限制，先講清楚免得你以為壞掉：
- 介面只有繁體中文；學習素材是英文 podcast。
- 目前真實使用者是 1 位（開發者本人）。你看到的任何統計都是從零開始，不是你的資料
  沒存到。
- 首頁右上角那行灰色小字是開發用的量測面板，刻意留在這輪 beta 裡——它就是你回報
  問題時最有用的那個畫面，請連它一起截圖。
- 錄音功能會用到麥克風，只在你主動按下錄音時才要權限。錄音留在你的裝置與你自己的
  帳號底下。

回報方式：TestFlight 內建的截圖回報最快，或直接寄信給我。

──────────────────────────────────────────

Echo is a podcast player that treats rewinding as a signal.

Every time you tap "back 15 seconds" while listening, Echo records that position —
odds are it's something you didn't catch. Those positions get sliced into sentences,
transcribed, and turned into practice cards the next day.

This beta is trying to answer three questions:
1. Does the back-15s tap get recorded as a signal reliably?
2. Does the three-stage reveal on a practice card (shape mask -> hint -> full
   sentence) actually help you recall it?
3. Can a lock-screen notification quiz replace opening the app to review?

Known limits, stated up front so you don't think it's broken:
- The interface is Traditional Chinese only. The listening material is English.
- Echo has one real user so far (the developer). Every counter you see starts at
  zero — that's not your data failing to save.
- The small grey line at the top right of the home screen is a measurement panel,
  deliberately left in this beta. It's the single most useful screen to include
  when you report something.
- Recording uses the microphone, and only asks for permission when you tap record.
  Recordings stay on your device, under your own account.

Fastest way to report: TestFlight's built-in screenshot reporter, or email me.
```

<!-- ↑↑↑ 到這裡 ↑↑↑ -->

### 1.2 What to Test（這一版要測什麼）

規則：**每一條都是一個可以做完的動作，而且要說「做完之後畫面上會出現什麼」**——
沒有後半段，測試者做完不知道算成功還是失敗，回報就會變成「沒感覺」。

<!-- ↓↓↓ 直接複製 ↓↓↓ -->

```text
這一版請照順序做完這五件事，每件都有「做完應該看到什麼」。
看到的跟寫的不一樣 = 有 bug，請截圖。

【1】往回 15 秒有沒有被記到（30 秒）
開 app 就停在「首頁」，已經載好一集 Huberman Lab Essentials。
按播放 → 等 10 秒 → 按「往回 15 秒」那顆鍵 → 再按兩次。
應該看到：右上角灰色小字從「倒帶 0 筆」變成「倒帶 3 筆」。
不動的話請截圖那行字。

【2】展開量測面板，確認 app 怎麼解讀你的動作（30 秒）
點右上角那行「倒帶 N 筆 · 題目 N」。
應該看到：一張卡片展開，裡面逐行列出每一次位置回跳的時間與跳幅。
這行字如果是琥珀色而不是灰色，代表這台裝置有一項音訊能力沒拿到——請把整張卡截圖。

【3】鎖屏通知答題（1 分鐘，這一版最想測的東西）
在同一張面板裡按「示範題 · 12 秒後響（按完請鎖螢幕）」→ 按完立刻把螢幕鎖上。
12 秒後應該看到：鎖定畫面跳出一則通知，長按（或下拉）會展開三個選項 + 「想不起來」。
按其中一個。
應該看到：app 被帶到前景，標題底下出現一行回饋（答對是綠字，答錯是琥珀字）。
※ 示範題用的是預設單字，不會寫進任何統計，也不會推進複習排程。
※ 沒收到通知的話，先確認首次啟動時有按「允許」通知。

【4】練習分頁的「⚡ 搶先練」與三段漸進揭露（2 分鐘）
切到「練習」分頁。有卡片的話會看到綠色區塊「⚡ 搶先練（N）」，按「開始搶先練 N 張」。
應該看到：句子是被遮住的，而且遮罩帶著原句的形狀——每個字一根依真實字長的橫條，
所以你能看出「這句有幾個字、哪個字特別長」。
接著按「再給一點提示」→ 遮罩變成第二段。再按揭露 → 看到完整原句。
想測的就是這件事：形狀那一段有沒有比全黑更容易讓你想起來？
※ 這一區要有卡片才會出現。沒有的話先做【1】，隔天再回來。

【5】探索頁的難度帶徽章（30 秒）
切到「探索」分頁，用搜尋框找任一個英文 podcast。
應該看到：每一列節目卡上有一個難度徽章，而且整列的底色會跟著難度變。
想知道的是：這個難度標對你來說準不準？覺得不準的那一列請截圖，附一句你自己的判斷。

【不用測的東西（已知不會動，不是 bug）】
- 面板裡的「示範鎖屏卡（需要新 build）」按鈕：會回報找不到原生模組。那一塊功能還沒
  編進這顆 binary，按了不會怎樣。
- 首頁右上角的「已連線 / 本地模式」小圓點是給開發者看的。
```

<!-- ↑↑↑ 到這裡 ↑↑↑ -->

### 1.3 三個 URL 欄位

| 欄位 | 填什麼 | 備註 |
| --- | --- | --- |
| **Feedback Email** | `allcare.rickray@gmail.com` | 測試者按 TestFlight 內建回報時的收件人。**必填**。 |
| **Marketing URL** | 留空 | 選填。目前沒有產品頁，留空好過填一個 404。 |
| **Privacy Policy URL** | `https://github.com/rick-ray-wldd/daily-learn-app/blob/main/PRIVACY.md` | 🔴 **這個網址現在是 404**。見 §2 風險 1——不修好不要送。 |

### 1.4 Beta App Review Information

| 欄位 | 填什麼 |
| --- | --- |
| First Name | `Rick` |
| Last Name | `Ray` |
| Phone Number | `<填入可接通的號碼，含國碼>` ← **本文件不代填**，送審當下自己補 |
| Email | `allcare.rickray@gmail.com` |
| **Sign-in required** | ☐ **不勾**（留白 / No） |

> **為什麼不勾 Sign-in required：** app 走匿名登入（ADR-0013），
> 首次啟動自動 `signInAnonymously()`，**沒有登入畫面、沒有帳號密碼欄位**。
> 勾了反而要填 demo 帳密，填不出來就會被退。
> 但**不勾不等於不用解釋**——審查人員的預設反應是「找不到登入在哪」，
> 所以 Review Notes 第一段就要主動講。

### 1.5 Review Notes（Sign-In Information 底下那格）

**用英文寫。** 中文按鈕字面值原樣保留（讓他能在畫面上比對字形找按鈕），
每個中文後面括號補英文。

<!-- ↓↓↓ 直接複製 ↓↓↓ -->

```text
NO ACCOUNT IS NEEDED. There is no sign-in screen and nothing to type.
The app signs in anonymously in the background on first launch, so every tester
gets their own isolated data with zero friction. That is why no demo account is
provided — there is nothing to log into.

The interface is Traditional Chinese only (the target users are Mandarin-speaking
learners of English). The exact on-screen labels are quoted below so you can match
them visually without reading Chinese.

WHAT THE APP DOES
Echo is a podcast player for English learners. It treats a "back 15 seconds" tap as
evidence that the listener missed something, records that position, and turns it
into a vocabulary/sentence practice card later.

--- SEE THE CORE FEATURE IN 30 SECONDS ---
1. Launch. Tap "Allow" on the notification permission alert (it appears on first
   launch; it is needed for step 4).
2. The app opens on the "首頁" (Home) tab with an episode already loaded. Tap the
   play button, wait ~10 seconds, then tap the back-15-seconds button 3 times.
3. Look at the TOP-RIGHT CORNER of the screen: a small grey line reading
   "倒帶 3 筆 · 題目 0" (= "3 rewinds · 0 questions"). The first number counts the
   rewinds you just made. THIS IS THE CORE SIGNAL OF THE PRODUCT.
4. Tap that grey line to expand a diagnostics card. Inside it, tap the amber pill
   button "示範題 · 12 秒後響（按完請鎖螢幕）" (= "demo question, fires in 12
   seconds, please lock the screen now"), then lock the device.
   After 12 seconds a notification arrives on the lock screen. Long-press it to
   reveal 3 answer choices plus a "想不起來" ("can't recall") button. Tap any of
   them; the app comes to the foreground and shows one line of feedback under the
   header. That is the full loop.

PERMISSIONS AND WHY
- Notifications (requested on first launch): two uses, both local notifications,
  no push server. (a) One repeating daily reminder at 08:00 local time to do the
  day's review. (b) Interactive review questions delivered to the lock screen so
  the user can answer one word without opening the app. The four buttons on that
  notification all open the app to the foreground; this is deliberate, because
  background-only notification actions are not delivered reliably when the app has
  been terminated.
- Microphone (requested ONLY when the user taps record inside the "練習"
  (Practice) tab): the app records the learner reading a sentence aloud for
  shadowing practice, and plays it back to them. Nothing records in the
  background, and no recording is made anywhere else in the app.

THINGS YOU WILL SEE THAT ARE INTENTIONAL
- The small grey line at the top right of the home screen opens a developer
  diagnostics panel. It is deliberately left visible in this beta so testers can
  screenshot what the app measured when they report a problem. It contains no
  functionality beyond the two demo buttons described here.
- Inside that panel, a second button reads "示範鎖屏卡（需要新 build）"
  (= "demo lock-screen card, needs a new build"). It will report that a native
  module is unavailable. That is correct and expected: the Live Activity widget is
  not compiled into this binary.
- All counters start at zero. This build has essentially no usage history yet.

CONTENT SOURCES
Podcast search uses the public iTunes Search API; feeds are public RSS. Three demo
episodes are bundled: Huberman Lab Essentials, NPR Planet Money, and a LibriVox
public-domain audiobook. Audio playback and transcription both require a network
connection.

Thank you — happy to answer anything at allcare.rickray@gmail.com.
```

<!-- ↑↑↑ 到這裡 ↑↑↑ -->

---

## 2. 送審前檢查清單 —— 會被退件的風險與對策

依「不修好就一定出事」排序。**紅燈兩項，兩項都跟 build 無關，都是今天就能修的。**

### 🔴 風險 1 — Privacy Policy URL 現在是 404（最可能害這次被退）

**狀態：實查確認。** `git ls-tree --name-only origin/main` 的輸出是
`.gitignore / CLAUDE.md / CONTEXT.md / README.md / app / design / docs`——
**沒有 `PRIVACY.md`**。整個 repo 裡也 `find` 不到任何 privacy 檔案。
所以 §1.3 那個網址現在指向 GitHub 404。

而且不只是「檔案不在」：`origin/main` 停在 `7fd9133 Initial public repo`，
**本地分支比它多 27 個 commit**，目前工作分支是 `security/adr-0008-edge-functions-auth`。
就算現在寫出 `PRIVACY.md`，**沒 merge 進 main 並 push，那個 `/blob/main/` 網址一樣是 404。**

**為什麼這條特別致命：** 這個 app 錄使用者的聲音、把音訊送去第三方轉錄（Whisper）、
把逐字稿送去第三方診斷（Claude）。這種 app 沒有隱私政策不是格式瑕疵，是實體問題——
Beta App Review 會點那個連結，而 App Store Connect **不會**在送出時幫你驗證它通不通。

**對策（送審前必做，三步）：**
1. 寫 `PRIVACY.md`，至少涵蓋：收哪些資料（音訊、逐字稿、重聽時間點、匿名 user id）、
   送給誰（Supabase、OpenAI Whisper、Anthropic Claude）、存多久、怎麼刪、聯絡信箱。
2. **merge 進 `main` 並 push 到 `origin`。**
3. 用**無痕視窗**開一次那個網址，確認看得到內容再填進 App Store Connect。

> 順帶：`docs/02-execution/roadmap-expo-to-native.md` 與 `native-app-blueprint.md`
> **沒有被 `.gitignore` 擋**。推 main 的時候順手確認一次要推的檔案清單，別為了修 404
> 把不該公開的東西一起推上去。（`demo-day-runbook.md`、`03-fundraising/`、
> `04-research/`、`competitors*.md`、`SV_DemoDay2026.pdf` 已被擋。）

### 🔴 風險 2 — app icon 還是 Expo 範本，設計參考線印在上面

**狀態：實查確認，尚未更換。** `app/assets/icon.png` 的 mtime 是 **Jul 12 13:37**，
與其他 Expo 範本資產同一秒；`git log -- app/assets/icon.png` 沒有任何更新 commit。
目視確認：1024×1024，藍色 `A` 字圖形，**上面壓著虛線建構線、兩個同心圓、與一個十字準心**。

**為什麼會被退：** 這是 Apple 每天看幾百次的 Expo 預設圖，而準心與虛線就是
「placeholder / 未完成資產」的字面定義（Guideline 2.3.8）。它出現在主畫面、
TestFlight app 列表、以及測試者收到的每一封邀請信上。

**對策：**
1. 換掉 `app/assets/icon.png`。硬性規格：**1024×1024、PNG、無 alpha 通道**、四角不預留圓角。
   （現檔的規格本身是合格的——`sips` 確認 `hasAlpha: no`——**問題純粹是圖案內容**。）
2. **這一定要重 build。** icon 是原生 bundle 資源，不在 JS bundle 裡，`eas update` 送不到
   （`roadmap-expo-to-native.md` §5.3）。
3. build 完**在真機主畫面上看一眼**再送審。EAS 不會告訴你圖換錯了。

### 🟡 風險 3 — App Store Connect 的 app 名稱「Echo」幾乎確定被佔用

**狀態：待驗證**（本輪無法查 App Store 名稱庫）。但「Echo」是單字通用詞，
被註冊的機率極高，而 App Store Connect 的 App Name **必須全球唯一**。
這會在**建立 app record 的那一刻**就卡住，連 build 都還沒上傳。

**對策：** 先想好備案再去開 record。可以用的事實：
**App Store Connect 的 App Name 與裝置上的顯示名稱是兩件事**——
record 叫 `Echo：聽力難點練習`，`app.json` 的 `name` 仍然可以是 `Echo`，
主畫面圖示底下顯示的還是「Echo」。**不要為了這件事去改 `app.json`**，
改了又是一次重 build。

### 🟡 風險 4 — 中文介面 + 審查人員讀不懂 → 找不到功能就退件

**狀態：確定會發生，只能靠文案緩解。** app 全繁中，而審查人員大機率不懂中文。
更糟的是**核心功能藏在右上角一行灰色小字後面**——那在 Apple 眼裡是
「hidden feature」的典型長相。

**對策（三項都做）：**
1. Review Notes 用英文寫，**中文按鈕字面值原樣抄進去**（§1.5 已經照做）。
2. 主動揭露 DevProbes 面板是什麼、為什麼留著（§1.5 已經照做）。
   **主動講的診斷面板不是 hidden feature；被發現的才是。**
3. App Store Connect 的 **Primary Language 設成 Chinese (Traditional)**。
   設成英文而 app 全中文，是自己製造「metadata 與 app 不符」的爭議。

### 🟡 風險 5 — 送 TestFlight 的那顆 build 拿不到最新 JS（OTA channel 走岔）

**狀態：設定上確實會發生。** `eas.json` 的 `production` profile 用 `channel: "production"`，
但 `roadmap-expo-to-native.md` §3.3 第 3 項寫的是 demo 裝置在 **`preview`** channel。
一直以來的 `eas update` 如果推的是 `preview`，那麼**用 `production` profile 出的 build
會只跑 binary 裡烤進去的那份 JS**，測試者拿到的是舊功能，你卻以為 OTA 會補上。

**對策：** build 完、submit 之前，明確對 `production` 發一次：

```bash
cd "$(git rev-parse --show-toplevel)/app"
npx eas-cli update --branch production --message "TestFlight 外部測試首版"
```

然後在真機上用首頁的 `UpdateStatus`（那行顯示執行中 bundle 的字）確認版本對得上。

### 🟢 風險 6 — Export Compliance（已解決，列出來是為了不要有人再去動它）

`app/app.json` → `ios.config.usesNonExemptEncryption: false` ✅ 已設定。
Expo 會把它寫成 Info.plist 的 `ITSAppUsesNonExemptEncryption`，
**App Store Connect 因此不會再問加密問題**，每次上傳都自動跳過。
不要拿掉，拿掉就變成每顆 build 都要人工回答一次。

### 🟢 風險 7 — 匿名登入本身（已有對策，列出來是為了別自作聰明）

匿名登入不是問題，**不解釋才是問題**。§1.4 不勾 Sign-in required、
§1.5 第一段用全大寫講「NO ACCOUNT IS NEEDED」，這兩件一起做就夠了。
**不要**為了「保險」去生一組假 demo 帳號填進去——app 裡根本沒有地方輸入它，
審查人員試著登入卻找不到欄位，那才是真的會被退。

### 送審前最後三分鐘：能不能按送出

- [ ] `PRIVACY.md` 已在 `origin/main`，無痕視窗開得起來（風險 1）
- [ ] 新 icon 已在真機主畫面上目視確認（風險 2）
- [ ] App Store Connect 的 Primary Language = Chinese (Traditional)（風險 4）
- [ ] `eas update --branch production` 已發，真機 `UpdateStatus` 版本對得上（風險 5）
- [ ] Beta App Review Information 的電話號碼真的接得通（§1.4）
- [ ] App Privacy（資料收集問卷）已填完 —— 見 §3 步驟 3

---

## 3. 完整操作步驟（含每一步大概要等多久）

時間標示 = 這一步**你需要盯著的時間** + （**等待時間**）。

### 步驟 0 — 前置（如果 Apple Developer Program 還沒好，先停在這裡）

`weekly-log/W1.md` 把「Apple Developer Program 申請」列為待辦。
2026-08-04 出得了 iOS build，代表帳號**很可能**已經好了，但本輪沒有查證。

**先確認：** 登入 https://developer.apple.com/account，看得到 Membership 且未過期。
- 沒有 → 現在去申請。**個人帳號 US$99/年，審核 24–48 小時，有時更久。**
  這一步不完成，後面每一步都不用做。

### 步驟 1 — 建立 App Store Connect 的 app record（10 分鐘）

https://appstoreconnect.apple.com → My Apps → `+` → New App

| 欄位 | 值 |
| --- | --- |
| Platforms | iOS |
| Name | `Echo` → **被佔用就換 `Echo：聽力難點練習`**（風險 3） |
| **Primary Language** | **Chinese (Traditional)**（風險 4） |
| Bundle ID | `com.rickray.echo` ← 下拉選單裡沒有的話，代表 identifier 還沒在 Developer Portal 註冊；`eas build` 第一次跑會自動建，先跳到步驟 4 再回來 |
| SKU | 隨便一個內部字串，例如 `echo-ios-001`，之後不能改 |
| User Access | Full Access |

### 步驟 2 — 填 App Information（5 分鐘）

Category 選 **Education**（次要可留空）。這一頁只要能存檔就好，
**正式上架才需要的截圖、描述、關鍵字，外部測試都不需要。**

### 步驟 3 — 填 App Privacy 問卷（20 分鐘，不要跳過）

左側 **App Privacy**。這一區問「你收集哪些資料」，答錯的代價是之後被抓到要重填重審。
依 app 的真實行為，至少要勾：

| 類別 | 收不收 | 說明 |
| --- | --- | --- |
| Audio Data | ✅ 收 | 跟讀錄音（麥克風）+ 送去轉錄的 podcast 音訊片段 |
| Identifiers → User ID | ✅ 收 | Supabase 匿名 user id（RLS 綁 owner 用） |
| Usage Data → Product Interaction | ✅ 收 | 重聽事件、練習紀錄 |
| **Tracking** | ❌ **不做** | 沒有廣告 SDK、沒有跨 app 追蹤，14 個相依裡沒有任何 analytics/ads 套件。**因此不需要 ATT 權限、也不要去加** |

用途一律選 **App Functionality**，且**不要**勾「Used to Track You」。
「Linked to the User」要勾（資料綁在匿名帳號下）。

> ⚠️ 這裡的每一格都要對得上 `PRIVACY.md` 的內容。兩邊講的不一樣，是自找的麻煩。

### 步驟 4 — 換 icon、跑四道閘、出 build（盯 5 分鐘 +（等 15–40 分鐘））

先換 `app/assets/icon.png`（風險 2），然後：

```bash
APP="$(git rev-parse --show-toplevel)/app"
cd "$APP"

# 四道閘（RUNBOOK 第 0 步，30 秒，不需要 Xcode）
npx tsc --noEmit                                  # 必須通過
npx expo export --platform ios                    # 必須通過
node -e "console.log(Object.keys(require('./package.json').dependencies).length)"  # 必須是 14
node --check plugins/withEchoWidget.js            # 語法檢查（這顆 build 不含它）

# 出 build
npx eas-cli build --platform ios --profile production
```

**⚠️ 不准順手把 `withEchoWidget` 加進 `app.json` 的 `plugins`。**
那條程式碼路徑一次都沒被真實 `prebuild` 跑過，本機沒有 Xcode 也驗不了
（`roadmap-expo-to-native.md` §3.2）。這顆 build 的唯一原生改動就是 icon。

第一次跑會互動式問 Apple 帳號、幫你建 distribution certificate 與 provisioning profile
——照著答，全部讓 EAS 代管。**排隊 + 編譯免費方案通常 15–40 分鐘**（付費方案較快）。

### 步驟 5 — 發 OTA 到 production channel（2 分鐘）

```bash
npx eas-cli update --branch production --message "TestFlight 外部測試首版"
```

理由見風險 5。

### 步驟 6 — 上傳到 App Store Connect（盯 2 分鐘 +（等 5–15 分鐘））

```bash
npx eas-cli submit --platform ios --latest
```

`--latest` = 拿最近一顆成功的 build。`eas.json` 的 `submit.production` 是空的 `{}`，
所以**會互動式問** Apple ID 與 App Store Connect App ID（步驟 1 那個 record 的數字 id）。
答完之後可以把它們寫回 `eas.json` 省得下次再問（`appleId` / `ascAppId`），
不寫也完全沒關係。

### 步驟 7 — 等 Apple processing（（等 5–30 分鐘））

TestFlight 分頁會看到 build 標著 **"Processing"**。處理完會寄一封信。
- 這期間 **Internal Testing 已經可以裝了**（100 人上限，不用審核）——
  **強烈建議先自己裝一次**，確認 icon 換對了、示範題會響、探索頁有難度帶。
  在這裡發現問題，比被 Beta App Review 退件便宜一個數量級。
- 卡在 Processing 超過 1 小時通常是 Apple 側塞車，再等；超過幾小時去看有沒有
  「Invalid Binary」的信。

### 步驟 8 — 填 Test Information（15 分鐘）

TestFlight → **Test Information**，把 §1.1–§1.5 全部貼上，Save。

### 步驟 9 — 建外部測試群組並送審（5 分鐘 +（等 24–48 小時））

1. TestFlight → 左側 **External Testing** → `+` 建群組，例如 `Public Beta`
2. 把步驟 7 那顆 build 加進群組
3. 系統會提示 **Submit for Beta App Review** → 送出

**首次 Beta App Review 約 24–48 小時**（之後同一 app 的新 build 通常快很多，
只有動到權限或核心功能才會再被完整看一次）。
被退件會收到信附理由，修好後可以重送——**通常不需要重出 build**，
如果退的是文案類問題（例如隱私政策連結壞掉），改完 Test Information 直接重送即可。

### 步驟 10 — 開公開連結，拿 QR（5 分鐘）

審核通過後：

1. 進那個 External Testing 群組 → **Enable Public Link**
2. 拿到形如 `https://testflight.apple.com/join/XXXXXXXX` 的網址，**立即生效**
3. 設 **tester 上限**（可設 10,000 以下任意值；建議先設個小數字，例如 100，
   之後隨時可以調高——上限是為了不要一夜之間灌進來一堆裝了就刪的人）
4. QR：用 `meta-wearables-webapp:qr-code` skill 在本機離線產（純 Python stdlib，
   不經第三方服務），輸出 PNG 直接放進海報 / 投影片

> **公開連結的代價，先知道再開：** 任何人拿到連結都能加入，
> 你**不會**拿到他們的 email——TestFlight 公開連結是匿名的。
> 需要對得上人名（例如追蹤 cohort 內誰真的裝了），
> 就走 email 邀請那條路，不要只靠公開連結。

### 全程時間概算

| | 你要盯著 | 純等待 |
| --- | --- | --- |
| 步驟 1–3（ASC 設定） | ~35 分 | — |
| 步驟 4–6（build + submit） | ~10 分 | 20–55 分 |
| 步驟 7（processing） | — | 5–30 分 |
| 步驟 8–9（文案 + 送審） | ~20 分 | **24–48 小時** |
| 步驟 10（開連結） | ~5 分 | — |

**動手到拿到公開連結：最快約 1.5 個工作天，抓 2–3 天比較安全。**
（若 Apple Developer Program 還沒下來，再加 1–2 天。）

---

## 4. 這份文件不涵蓋的東西

- **正式上架 App Store**（Guideline 全套、截圖、審核）——外部 TestFlight 不需要，
  這份文件也不處理。
- **Android / Google Play** —— `app.json` 的 android 區塊存在，但本專案 iOS 為主。
- **Live Activity 鎖屏卡的送審** —— 那需要先讓 `withEchoWidget` 真的跑過一次
  `prebuild`，是 8/17 之後的事（`roadmap-expo-to-native.md` §3.2）。

## 5. 本文宣稱的來源

| 宣稱 | 怎麼查證的 |
| --- | --- |
| `PRIVACY.md` 不存在、URL 404 | `git ls-tree --name-only origin/main`（無此檔）＋ `find . -iname "*privacy*"`（無結果）。**本輪實跑** |
| `origin/main` 落後 27 個 commit | `git rev-list --count origin/main..HEAD` = 27。**本輪實跑** |
| icon 是 Expo 範本且印著參考線 | `ls -la app/assets/` mtime = Jul 12 13:37（與其他範本資產同秒）＋ `git log -- app/assets/icon.png` 無更新 commit ＋ **本輪目視讀圖確認**虛線建構線、同心圓、十字準心 |
| icon 規格合格（1024²、無 alpha） | `sips -g pixelWidth -g pixelHeight -g hasAlpha`。**本輪實跑** |
| `usesNonExemptEncryption: false` | `app/app.json` → `ios.config`。**本輪實讀** |
| 匿名登入、無登入畫面 | `app/lib/supabase.ts:70` `signInAnonymously()`；ADR-0013 |
| 每日提醒 08:00 真的存在 | `app/lib/notifications.ts:122-160`，呼叫端 `App.tsx:506` 與 `screens/Practice.tsx:722`。**本輪 grep 確認有被呼叫**，不是死碼 |
| 通知權限在首次啟動就問 | `App.tsx:502,506` → `lib/notifications.ts:107-121` |
| 麥克風只在按錄音時問 | `screens/Practice.tsx:778` `requestRecordingPermissionsAsync()`，全 app 唯一呼叫點 |
| 示範題 12 秒 | `App.tsx:1110` |
| 示範鎖屏卡按了會失敗 | `app/app.json` 的 `plugins` 不含 `withEchoWidget`；`lib/liveActivityNative.ts:22-23` 註明對應 Swift「從未編譯過」 |
| `production` / `preview` channel 不同 | `app/eas.json`（production → `production`）vs `roadmap-expo-to-native.md` §3.3 第 3 項（demo 裝置在 `preview`） |
| 14 個相依、無 analytics/ads | `app/package.json` 逐項讀過 |
| **待驗證：** 「Echo」名稱被佔用 | 本輪無法查 App Store 名稱庫，屬推測（單字通用詞） |
| **待驗證：** Apple Developer Program 已生效 | 2026-08-04 出得了 iOS build 是間接證據；本輪未登入帳號確認 |
| **待驗證：** Beta App Review 24–48 小時 | Apple 未給 SLA，此為普遍經驗值 |
| **待驗證：** App Privacy 是否為外部測試的硬性前置 | 正式送審必填無疑；外部 TestFlight 是否硬擋本輪未確認。**當成必填做，成本 20 分鐘，賭錯的成本是一輪 24–48 小時** |

---

## 🔴 送審前必讀：`PRIVACY.md` 目前**低報**了送給 Anthropic 的資料

> 2026-08-18 對抗式複核發現，**經創辦人裁示：先記錄，這一輪不修改內容。**
> 記在這裡而不是記在 `PRIVACY.md` 裡，是因為這一條唯一會咬人的時刻就是「按下送審」，
> 而那個動作的檢查清單在這份文件。

`PRIVACY.md` 寫給 Anthropic 的那一行是：

> 「你倒帶的那一句話的逐字稿文字，加上前後幾句作為上下文。」

**這句話只對 `diagnose` 成立。**`annotate`（琥珀詞標註）是另一回事，實際行為在
`app/lib/annotate.ts`：

| 實際送出 | 政策有寫嗎 |
| --- | --- |
| 一批最多 **40 個 segment / 10,000 字元**，送完自動續送下一批 | ❌ |
| 涵蓋**使用者開過逐字稿的全部內容**，不限於他倒帶的地方 | ❌ |
| 附帶 `weakTypes`（`weakTypesFromCaptures()`）——**從他行為算出來的弱點剖繪** | ❌ |

**為什麼這是送審風險而不只是文件瑕疵**：這份政策的全部說服力來自 §12 的「你可以自己
去查」對照表。表裡列了 `lib/annotate.ts`，任何人點進去五分鐘就看得到落差——而政策
與程式碼不符，正是 App Review Guideline 5.1 會被抓的那一類。

**要動的時候改成兩行**（原始建議，未套用）：

- **Claude（diagnosis）** — 你倒帶的那一句＋前後文，一次一句。
- **Claude（transcript annotation）** — 你開啟逐字稿的那些段落，分批送出（一批最多
  40 句／10,000 字元），涵蓋你聽過而且看過稿的全部內容；另附你最常卡住的 1–2 個
  難點類型，讓標註偏向你的弱項。仍然只有文字，沒有音訊、沒有帳號 ID、沒有 IP。

⚠️ **在改掉之前，不要把 `PRIVACY.md` 的 URL 填進 App Store Connect。**
放在 repo 裡是紀錄，填進送審表是宣稱。
