# ADR-0022 — 互動式通知出題：沿用鎖屏出題器；答題**單向**寫入 SRS（收窄 ADR-0021⑤）

- **Status:** accepted
- **Date:** 2026-08-14

## Context

ADR-0021 的鎖屏複習卡需要一個 **widget extension**，而 widget extension 是原生 target：
**不能 OTA**。本輪（2026-08-14）的全部產出都必須能 OTA 送出，Pre-Demo Day 是 8/17，
中間沒有再做一次 EAS Build 並讓使用者重裝的空間。

所以這一輪用**本地排程 + 通知 category** 把 Live Activity 補到七成：一則通知一題，
標題是英文題面，下拉出現三個中文選項加一個「想不起來」。四個力量壓在這個決定上：

1. **不准新增 dependency（維持 14）、不准動 `app.json`。**
   `expo-notifications` 已在 dependencies 但**不在 `app.json` 的 plugins**——本地通知與
   category 都是 runtime JS 呼叫，**不需要 plugin**（官方文件確認）；遠端推播才需要，
   本輪不做推播。加 plugin 會讓下一次 EAS Build 依賴未驗證的東西。
2. **`gloss_zh` / `distractors_zh` 這兩欄在整個 repo 裡沒有任何生產者。**
   `grep -rn "gloss_zh"` 只命中 `lib/liveActivity.ts` 的型別宣告與消費端。更關鍵的是
   `lib/diagnose.ts` 的 `validateDiagnosis` 是**逐欄位重建物件**回傳，所以即使 Edge
   Function 哪天開始回傳這兩欄，client 這一側也會先把它靜靜丟掉。
3. **ADR-0021⑤ 明文禁止鎖屏答題推進 SRS。** 通知答題與鎖屏答題是同一類東西
   （一次點擊、三選一、1/3 猜對率），這條規則直接壓在本輪的功能上。
4. **app 被殺掉時，JS 不保證跑得完。** `opensAppToForeground: false` 的 action 在 app
   被殺時**不會**觸發 `NotificationResponseReceived`；官方指定的替代路徑是
   `registerTaskAsync` 背景任務，而 expo #36282（至今未解）正是那個窗口的 JS 不保證
   執行完畢。

### 被否決的方案

| 方案 | 為什麼不用 |
| --- | --- |
| **在 `quiz.ts` 另寫一套出題邏輯** | 會變成第三份「今天要問什麼」。`liveActivity.ts` 鐵律②已經記載佇列有兩份實作而且分岔過；出題器再分岔，「鎖屏問的」與「通知問的」會是兩個答案不同的題目，而我們無從得知使用者答的是哪一個。 |
| **`opensAppToForeground: false`（背景作答，不打開 app）** | 體驗上明顯更好，但 app 被殺時那一按就**永遠收不到**。見 Context 4。可靠性優先於優雅。 |
| **共用一個 category、按鈕寫「選項 A/B/C」** | iOS 的 action 按鈕標題在 **category 註冊時**就固定，共用就只能寫佔位字。那等於把題目藏起來，卡片當場失去測驗價值。 |
| **拿 `explanation_zh`（≤60 字）當正解** | 正解 60 字、干擾項 5 字，**光看長度就選得對**。會產出一個很漂亮的假正確率。 |
| **跨 capture 借 gloss／隨機中文詞湊干擾項** | 跨 capture 的語意天差地遠，干擾項一眼排除 → 95% 的假正確率，正好砸掉這個產品唯一的論點（這些數字是真的）。 |
| **拿六類難點標籤（`DIAGNOSIS_LABELS_ZH`）當選項** | 那測的是「你同不同意 app 的猜測」，與本輪「診斷延後」要消滅的錨定效應直接打架。 |
| **DAILY repeating 觸發器** | 會把同一題每天重播到天荒地老。app 每次啟動都會重排，用 DATE 一次性正好。 |

## Decision

### ① `lib/quiz.ts` 是 `lib/liveActivity.ts` 的**轉接層**，不是第二套出題器

正確答案／干擾項／題面／否決理由**全部**沿用 `buildDeck`，一行都不重寫。`quiz.ts` 只做
三件事：呼叫 `buildDeck`、把 card 補上 category identifier、把 `SkipReason` 翻成人看得懂的
一句話。它是純函式——不 import `expo-notifications`、不 import `store` / `srs`、不查佇列
（佇列由 `App.tsx` 的三桶傳進來），所以可以在沒有 React、沒有網路、沒有裝置的情況下單獨測。

### ② 一張題目一個 notification category；identifier 是 `echoQuiz<stableHash(card_id)>`

理由見上表。官方 d.ts 明寫 category identifier **不准含 `:` 或 `-`**，而失效的樣子是
「通知照發但按鈕不見了」，沒有任何錯誤訊息。所以：

- category id 走 `stableHash`（保證 `[0-9a-z]`），**不是** `card_id`（UUID 含 `-`）。
- action identifier 是 `quizA/quizB/quizC/quizUnknown`，**不是** `quiz-a`。
- `QUIZ_KIND = 'daily-quiz'`（含 `-`）**只能**當 `data.kind` 與 Android channel id，
  絕不可以拿來當 category identifier。兩者是不同的命名空間。

按鈕靠**位置**對應 `options[0..2]`，不是直接用 option 的 id（'a'/'b'/'c'）——選項順序已經
洗過，用 id 當按鈕 id 會在洗牌後錯位，把答案記到別的選項上。

每次 sync 會刪掉「前綴相同但不在今天清單內」的舊 category，否則一天三個逐日累積。

#### ②-b 選項順序必須是 `card_id` 的**純函式**（`quiz.ts` 的 `fixOptionOrder`）

category 是一份**全域、可被覆寫**的註冊表（原生實作就是
`current.filter{ id≠ } ∪ {new}` 再整包 `setNotificationCategories`），而**已經發出去、
還躺在通知中心**的那則通知，身上帶的是發出當下的 `option_ids` / `correct_id`，
按鈕卻是用 category identifier 現查的。

`buildDeck` 預設用 `Math.random` 洗牌，`syncQuizNotifications` 每次回前景都用**同一個**
`category_id` 重新註冊。於是：12:30 發出一題 → 14:00 使用者開了一次 app（重洗、覆寫
category）→ 18:00 他下拉那則 12:30 的通知，看到的按鈕已經不是通知身上那份答案卷。
他點對了會被記成答錯，而**答錯會寫 `'again'`**——我們拿到一筆「他不會這個」的假資料，
正好砸掉這個產品唯一的論點。

所以順序改成由 `card_id` 決定的固定排列（6 種排列查表 + `cyrb53` 選一種，基準序取字串
排序以擺脫 `buildDeck` 的隨機底盤）。重新註冊必然產生**逐位元組相同**的 category，覆寫
變成 no-op，這個窗口整個不存在——不必依賴「iOS 大概是在送達時就把按鈕定住了吧」這種
沒有白紙黑字的假設。

代價明講：同一張卡的正解永遠在同一顆按鈕上，理論上可以背位置。但那個代價的方向是
**安全的**——背位置的人會答對，而答對**不寫 SRS**（見⑤），最多是少收到一筆真的
「他不會」；順序漂移則是**捏造**一筆假的「他不會」。少收一筆真的遠好過多收一筆假的。

### ③ 四顆按鈕全部 `opensAppToForeground: true`，用 `getLastNotificationResponse()` 收割

這是**可靠性的選擇，不是偷懶**（見 Context 4）。按鈕開 app、冷啟動時同步讀
`getLastNotificationResponse()`、處理完呼叫 `clearLastNotificationResponse()`，是唯一可靠
的路徑。**一律用同步版**——`getLastNotificationResponseAsync` /
`clearLastNotificationResponseAsync` 在 `expo-notifications@57.0.8` 已標 `@deprecated`。

代價是每次作答都會把 app 帶到前景，所以 `App.tsx` 那側刻意**不暫停播放、不關覆蓋層、
不切分頁**：按鈕已經把 app 帶到前景（那本身就夠打擾了），再把他正在聽的東西按停、把畫面
換掉，代價遠大於回饋的價值。只有點通知本體（`DEFAULT_ACTION_IDENTIFIER`）才導頁。

### ④ 通知標題**就是題面**

iOS 的 action 按鈕預設收起來，要下拉才看得到。即使他不展開，光看到那個英文詞也已經是
**一次提取練習**。category 一併設 `showTitle: true`，讓關掉通知預覽的人也看得到題面。

### ⑤ SRS **單向寫入**：只有答錯與想不起來寫 `'again'`。這是 ADR-0021⑤ 的**收窄，不是 supersede**

| 使用者做了什麼 | SRS | `capture.status` | daily session / 北極星 |
| --- | --- | --- | --- |
| 選對 | **不動** | 不動 | 不計入 |
| 選錯 | `gradeSrsItem(item, 'again')` | 不動 | 不計入 |
| 想不起來 | `gradeSrsItem(item, 'again')` | 不動 | 不計入 |
| 明確滑掉（dismiss） | **不動** | 不動 | 不計入 |
| 點通知本體（tap） | **不動** | 不動 | 不計入 |

ADR-0021⑤ 禁止鎖屏答題推進 SRS，理由是「1/3 猜對率會灌水 ADR-0011 的北極星」。
**那個理由只對『答對』成立。** 一次點擊的證據強度遠低於「重聽 → 揭露 → 跟讀 → 自評」，
把它記成掌握就是捏造。

但**答錯與想不起來是相反方向的證據**：它只會把卡片拉回今天、把 ease 調低，**不可能**
灌水任何指標，而且那是使用者親口說的「我不會」。丟掉它才是在假裝他答對了。所以本輪採
單向寫入：**只准往「更常出現」的方向動，不准往「掌握了」的方向動。**

`status` 一律不改成 `'practiced'`、`addPracticeRecord` 一律不碰——完成度、streak、北極星
全部不受影響。ADR-0021⑤ 的精神（鎖屏／通知答題是額外曝光，不是完成）**完整保留**，
本 ADR 只把它從「完全不寫 SRS」收窄成「不往掌握方向寫 SRS」。

「想不起來」**不是第四個選項**，是逃生口：猜對率的分母永遠是 3
（`liveActivity.ts` 鐵律⑤），統計時 `unknown` 單獨一格，**不准併進答錯**。

#### ⑤-b 那個 `'again'` 還要再過一道**卡片資格閘**：只有 `confirmed` / `practiced` 會真的寫

`getSrsItem(id) ?? newSrsItem(id)` 這一行會**憑空生出 SRS item**，而通知的佇列第一桶
正是 `officialPending`（`status === 'pending'`）。對一張 pending 的卡寫下去，會造出一張
**沒有任何畫面收得掉的幽靈卡**：他之後在練習頁按「只是分心，滑掉」，`status` 變
`dismissed`，但那個 SRS item 沒有人刪得掉（`store.ts` 沒有 `removeSrsItem`）。從那一刻起

- `App.tsx` 的 `computeTodayBuckets` 永遠把它算進 `dueItems`（那道 filter 只看 `isDue`
  與 pendingIds，**不看 `capture.status`**）→ 徽章永遠 +1，而且它會一直被拿去出題；
- `Practice.tsx` 的複習佇列要求 `practiced | confirmed` → 永遠不顯示它，也就永遠沒有人
  把它評分掉（`due_date` 停在過去，`isDue` 恆真）。

那正是這個 repo 反覆寫下的那個最傷信任的病：**徽章說有 1 張、點進去是空的**——而且
還在拿他親口否決過的東西繼續煩他。

而且對 pending 的卡來說，這一寫本來就**不換來任何東西**：昨天以前的 pending 每天都在
正式佇列裡，今天照樣會出現在他面前。少寫這一筆沒有損失，寫下去卻可能留下一張清不掉
的卡。

（修的是「不製造那個狀態」，不是去改徽章：`dueReviews` 不過濾 `capture.status` 是既有
落差，動它會改到徽章數字，仍然是另一輪的題目。見 Follow-up。）

`srs_written: false` 因此有好幾種完全不同的意思，所以 `QuizOutcome` 多一個 `srs_skip`
（`stale-deck` / `card-missing` / `card-unconfirmed` / `card-dismissed` / `write-failed`），
畫面上那一行字照它講對是哪一種。對一張還在 pending 佇列裡的卡說「這張卡不在今天的佇列
裡」，是一句可以當場被戳破的謊。

### ⑥ 冪等三層，缺一不可

1. **模組層 `seenQuizKeys: Set<string>`**，key = `${request.identifier}:${actionIdentifier}`。
   🔴 必須在**任何 `await` 之前**同步 check-and-add：冷啟動的
   `getLastNotificationResponse()` 與 listener 可能送同一筆進來，兩邊都會在
   `await initStore()` 上排隊，晚一步檢查就會雙寫（同一題被記兩次 `'again'`）。
2. **`clearLastNotificationResponse()`**，由 `App.tsx` 處理完呼叫一次。不清的話
   **每次冷啟動都會重播同一個答案**。
3. **日期閘**：`data.deck_date !== todayStr()` → 不寫 SRS，但仍回傳 outcome 讓 UI 有東西顯示。
   不准用昨天的答案動今天的排程。

   🔴 `deck_date` 是**這則通知會在哪一天響**（`toDateStr(nextSlotDate(slot))`），
   **不是**排程當天。`nextSlotDate` 會把已經過去的時段順延到明天，所以任何在 12:30
   之後跑的 sync 至少有一題是排給明天的；把 `deck_date` 寫成排程當天，明天響的那則被
   作答時就會被自己這道閘擋掉——SRS 一個字都不寫，畫面還回他一句「這張卡不在今天的
   佇列裡」。而那正好是**最該成立的那條路徑**：使用者一整天沒開 app，只從鎖定畫面按了
   一顆按鈕（他若開了 app，重排就會把那則通知換掉）。這道閘要擋的是「隔了一天才回來按
   舊通知」，不是「排程跨過了午夜」。`nextSlotDate()` 因此**只准算一次**，`deck_date`
   與 trigger 共用同一個結果。

**不新增任何 AsyncStorage / store key**（本輪禁令）——三層全部只在記憶體。

任何 SRS 寫入路徑的**第一行必須是 `await initStore()`**：`store.ts` 的 `persist` 寫的是
**整個 `srsItems` 陣列**，未 hydrate 就 upsert 會把 AsyncStorage 裡既有的 SRS 全部蓋成只剩一筆。

### ⑦ 出不了題就**一則都不排**

不排空通知、不排「今天沒有題目喔」這種佔位通知——每日提醒（`daily-reminder`）已經覆蓋
「今天該練習了」這個情境，再發一則只是在說我們沒東西給他。原因由
`getLastQuizStatus()?.summary_zh` 如實顯示在開發者儀表上，**永遠不准說謊或美化**：
使用者／founder 打開 app 就看得到「為什麼今天沒有題目」，而不是以為功能壞了。

題目通知與每日提醒是**兩條互不干涉的線**：各自認自己的 `data.kind`、各自的取消迴圈。
所以「今天沒有題目」的降級狀態，就是「回到今天的樣子」。

### ⑧ `DISMISS` 只能當 best-effort 訊號

Apple 只在使用者**明確清除**通知時才觸發 `customDismissAction`（忽略通知、撥掉 banner
都不算），而且它不開前景，app 被殺時那一按仍落在 expo #36282 的窗口裡。所以
**「連續幾天被滑掉 ⇒ 提醒時間錯了」的分母是不完整的**，
**不准拿它的缺席當「他沒滑掉」的證據**。

## Consequences

**今天（2026-08-14）這個功能必然排 0 則題目通知，而這是設計，不是失敗。**
`buildDeck` 對真實資料必然回 `deck: null`、`skipped` 全部是 `'no-gloss'`（Context 2），
所以 `syncQuizNotifications` 會取消舊的題目通知、然後一則都不排。驗收時
`getAllScheduledNotificationsAsync()` 裡 `data.kind === 'daily-quiz'` 的筆數應為 **0**，
每日提醒照常存在一則。

**要讓它有題可出，得先做不屬於本輪的三件事**（`DiagnosisGloss` 註解裡的 ①②③）：
`Diagnosis` 加 optional `gloss_zh` / `distractors_zh` → diagnose Edge Function 的 strict
tool schema 一併回傳 → **client 與 server 兩份 `validateDiagnosis` 都要改**（client 是逐
欄位重建物件，只改 server 會被靜靜丟掉）。好消息：`captures.diagnosis` 是 jsonb 整包寫，
**不需要 migration**。

**已知的殘餘風險（接受）**：process 在「寫完 SRS」與「`clearLastNotificationResponse()`」
之間被殺，下次冷啟動會重放一次 `'again'`。後果是某張卡的 ease 多降一級、多出現一次
——方向與使用者的真實回答一致，不會產生假的「掌握」，所以可接受。

**已知的殘餘風險（接受）②**：一張卡在下一次 sync 前被練掉 → 它掉出今天的清單 →
清理迴圈 `deleteNotificationCategoryAsync` 把它的 category 刪掉。若那則通知已經發出去
且還沒被清除，它的按鈕可能就此消失（使用者仍可點通知本體，只是沒得作答）。這只是
**降級**，不會把答案記到錯的選項上，所以不擋；要修得留一天的寬限期，代價與價值不成
比例。

**變難的事**：一題一個 category 意味著每次 sync 要做 3 次註冊 + 一輪清理，比共用
category 多幾次跨橋呼叫。已用 10 分鐘 + 日期節流（`QUIZ_SYNC_MIN_INTERVAL_MS`）擋住
呼叫端的重複呼叫，代價是錯誤狀態最多停留 10 分鐘。

**遠端寫入仍可能失敗且不影響本地**：`upsertSrsItem` 內部的 `syncSrsItem` 若因
`difficulty_items.capture_id` 的 FK 失敗（capture 還沒上雲）只會 `console.warn`。
`srs_written: true` 指的是**本地 SRS 排程推進成功**——本地才是真相來源（ADR-0004）。

### Follow-up（本輪刻意不做）

- **遠端推播的那一輪必須改成不帶正解。** 本輪把 `correct_id` 放在本地通知的 `data` 裡是
  刻意的：通知從頭到尾沒離開過裝置，而冷啟動時佇列可能已經換了一批，不把正解帶在身上
  就無法可靠判定對錯。一旦要經 push 傳輸，這個欄位就必須拿掉（與
  `LiveActivityContentState` 同一條理由）。
- **`unknown` 的統計面還沒有消費端。** 本輪只保證它單獨一格、不併進答錯。
- **noticing 答案（`screens/Practice.tsx` 的「你覺得卡在哪？」）目前只活在 component
  state，關掉畫面就消失。** `Capture`（`types.ts`）沒有這個欄位，而 migration 006 連現有
  欄位都還沒上線（實測 `selection_text` 回 42703）。這是**已知的資料流失**，記在這裡而
  不是偷偷補一個 capture 欄位——那會在 006 之上再疊一層未上線的 schema 債。
- **`dueReviews` 目前不過濾 `capture.status`**（與 `Practice.tsx` 有已知落差）。本輪不修，
  修它會動到徽章數字，是另一輪的題目。⑤-b 的資格閘是繞開它、不是修它：通知這條路
  不再製造「dismissed 卻有 SRS item」的狀態，但**既有**資料若已經有這種卡，仍然會卡在
  徽章裡——要清它得先有 `removeSrsItem`，那是動 `store.ts` 的另一輪。
- **「你圈的 vs 我們判斷的」比對以詞為單位**（`screens/Practice.tsx` 的 `sameNoticeSpan`）：
  一方的整串詞必須是另一方的**連續子序列**。**不准用裸的 `a.includes(b)`**——
  `'gonna'.includes('on')`、`'they'.includes('the')`、`'stop'.includes('to')` 全是 true，
  他只點了一個 "on" 卻被回一句「同一處」。這一格是診斷延後**唯一要產出的那個數字**
  （學習者自己指出來的斷點 vs app 的猜測），而裸 includes 的偏差剛好偏向「同意」——
  那正是延後診斷要消滅的錨定效應，只是換個地方發生。
