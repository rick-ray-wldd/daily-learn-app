# ADR-0026 — 出題欄位由 `diagnose` 生成：`gloss_zh` 與 `explanation_zh` 分成兩欄；干擾項過三道閘（最後一道是盲測複核）；舊資料靠**裝置端重新診斷**補，不做 SQL backfill

- **Status:** accepted
- **Date:** 2026-08-14

## Context

ADR-0021 的鎖屏複習卡與 ADR-0022 的通知答題共用同一個出題器（`lib/liveActivity.ts` 的
`buildCard`），而那個出題器要三樣東西：**題面、正解、兩個干擾項**。0022 與 0024 的
Consequences 都寫著同一句話：**`gloss_zh` / `distractors_zh` 在整個 repo 沒有任何生產者**，
所以 `buildQuiz` 恆回 `blocked`，本輪之前排得出去的題目通知數是 **0**。

本輪補的就是那個生產者，補在 `diagnose` Edge Function 上（沿用 ADR-0007 的 strict-schema
tool call、ADR-0008 的 server 端金鑰）。

三個限制決定了設計：

1. **鎖屏 App Intent 與通知 action 都不能連網**（ADR-0021）。選項必須在**排程之前**就
   存在於裝置上 —— 只能預生成，現算不可能。
2. **答錯會寫進 SRS。** ADR-0022 ⑤ 的單向寫入：答錯／想不起來 → `gradeSrsItem(item,
   'again')`。所以一張「四個選項裡有兩個都對」的卡，產出的不是一次糟糕的體驗，是一筆
   **捏造的「他不會這個詞」**。這個 app 全部的論點是「這些數字是真的」。
3. **線上既有的 diagnosis 只有 4 個 key，不准壞。**

## Decision

### ① `gloss_zh` 與 `explanation_zh` 是**兩欄**，不是一欄

|  | `gloss_zh` | `explanation_zh` |
| --- | --- | --- |
| 出現在 | 鎖屏／通知的**按鈕上** | 練習卡 |
| 長度 | ≤ 8 字（`OPTION_LABEL_MAX_CHARS`） | ≤ 60 字 |
| 回答的問題 | 「這個詞**在這句話裡**是什麼意思」 | 「你為什麼聽不懂這句話」 |
| 形態 | 一個名詞或名詞片語、**單一義項**、無標點 | 完整段落 |
| 缺了會怎樣 | 那張卡出不了題（skip `'no-gloss'`） | 練習卡少一段解釋 |

不合併的**決定性**理由不是長度，是合併會**產出一個很漂亮的假正確率**：正解 60 字、三個
干擾項 5 字，光看長度就能選對，測驗當場失效，SRS 卻照樣收到一串「他都會」。這條禁令
現在寫在 `types.ts` / `liveActivity.ts` / `quiz.ts` 三處註解裡。

第二個理由：**截斷不是解法。** `pickGloss` 對超長的 gloss **一律丟棄、不准截斷** —— 截過的
字串照樣通過 client 的長度檢查（那道檢查在洗牌之前跑），但語意已經壞掉，而壞掉的語意在
按鈕上看起來和好的一模一樣。

第三：**一詞多義**。gloss 要的是「這句話用到的那個義項」，explanation 可以把整個字根家族
講一遍（線上唯一那筆就是這樣寫的）。這是兩種互斥的寫作要求，同一欄寫不出來。

### ② 干擾項是 LLM 生成的，所以**假設它會出錯**，用三道閘擋（順序＝由便宜到昂貴）

| 閘 | 位置 | 擋什麼 | 為什麼知道它必要（實測） |
| --- | --- | --- | --- |
| ① 純字串 | `pickQuizFields` / `pickGloss` / `pickDistractors` | 型別必須是 `vocab`、`focus_phrase` 必須單一詞、≤8 字、無標點 | prompt 早就寫了這些，但 prompt 當唯一那層時**實測會漏**：`type: linking` 的回應仍帶著 gloss；「終止、放棄」只有 5 個 code point，長度放行，可是那是**兩個義項**串在一起 |
| ② 字面重疊 | `overlaps()` | 相等、互相包含 | 「藥物學」vs「藥物學名詞」兩個都對 |
| ③ **盲測複核** | `verifyQuizOptions`（第二次 API 呼叫） | **語義**重疊：同義、近義、上位／下位、換句話說、簡繁異寫 | v3（只有 ①②）人工判讀 11 組，**2 組真的有第二個正解** |

③ 的做法：三個選項**洗牌**後交給模型，**不告訴它哪一個是預定的正解**，逐一判斷「能不能
當作這個片語在這句話裡的意思」；只有「**恰好一個 true 且那個就是正解**」才採用。判準
刻意偏**寬**（近義、上下位、只差一個修飾語、簡繁異寫全部算 true），而且**一律 fail
closed**：複核出錯、超時、格式不對，全部當成沒通過。

為什麼值得多花一次呼叫：①② 全是字面檢查，**擋不到語義**。實測 `focus_phrase =
"reluctant"`，正解「不願意」配干擾項「猶豫的」——三個字串兩兩無子字串關係，①② 全部
放行，但「猶豫的」對那句話也講得通。v3 的人工判讀漏網率約 **2/11 ≈ 18%**（另一例：
`pharmacologic substance` 的正解「藥物性物質」配干擾項「生物製劑」，後者本身就是一種
pharmacologic substance —— 教科書級的下位詞）。v4 上線後盲測在真實流量擋下 17 組裡的 2 組
（`catalyzes` 三個選項全被判 true；`potent` 有兩個），**兩張在 v3 都會出貨**。

順帶一條便宜的加強：prompt 裡**明講**「這組選項接下來會交給另一個看不到你意圖的模型
逐一判斷」，讓模型在第一步就自己砍掉近義詞，省掉一次浪費的複核。

🔴 **必須寫清楚的邊界：③ 是模型判斷，不是不變式。** `types.ts` 的註解已經改成「server 端
保證的**只有字面不重疊**」。任何下游都不准因為有這道閘就省掉自己的防線。簡繁異寫
（「藥物學」／「药物学」）只被 ③ 的**判準文字**涵蓋，沒有寫死的判別式 —— 本輪禁止新增
dependency，而 Unicode 正規化本身不做簡繁映射。

### ③ 出題欄位走**第二條、完全獨立的路**：不合格就只回原本 4 個 key

`validateDiagnosis` **逐欄位重建**物件、**不 spread**：模型回的 `gloss_zh` /
`distractors_zh` 一律不從那裡出去，它們只能經 `pickQuizFields` + `verifyQuizOptions` 兩道
閘之後**掛回去**。任何一道不過，回傳物件就與線上既有的 diagnosis **逐位元組同形**。

配套的三個實作決定：

- **strict schema 把兩欄列進 `required`**（本專案慣例，`annotate` 同）。strict 模式不支援
  `maxLength` / `minItems` / `maxItems`（會被 API 400 掉），所以「8 字以內」「恰好 3 個」
  只能寫在 prompt 再由 server 擋一次；品質不夠時由模型回 `""` / `[]`。
- **all-or-nothing**：有 gloss 但干擾項不足**也不 emit**。理由見 ④。
- **`max_tokens` 512 → 1024 是迴歸防護，不是新功能的需求**：多兩欄一旦撞上限，`tool_use`
  block 被截斷 → 整筆 diagnosis 解析失敗 → **連原本 4 個欄位一起丟掉**，等於用新功能弄壞
  舊功能。成本影響可忽略。

兩支消費端各自怎麼處理「舊 diagnosis 沒有新欄位」：

| 消費端 | 缺欄位時的行為 |
| --- | --- |
| **出題端** `liveActivity.ts buildCard` → `quiz.ts buildQuiz` | 讀不到就回 `reason: 'no-gloss'`，**那張卡被跳過、其餘卡照排**；一張都湊不出來就回 `deck: null` / `blocked` —— 不丟例外、不排佔位通知、不換來源湊題 |
| **練習卡端** `screens/Practice.tsx` | **根本不讀這兩欄**，只用 4 個舊 key 渲染 → 舊 diagnosis 的顯示行為**零變化**。它改的是另一件事：`needsDiagnosis` 讓舊格式的 vocab 卡有一次補救機會（見 ④） |
| （共用）client validator `lib/diagnose.ts` | 兩欄**一律當 optional 讀**，**絕不可以加進 reject 條件**——加了等於讓線上既有的 diagnosis 整筆作廢。空字串／空陣列**不寫進物件**，否則下游分不清「還沒生成」與「生成了但是空的」。這裡只做型別安全 + trim，**不重做**長度／去重檢查（唯一規格來源是 `buildCard`，抄第二份只會漂移） |

### ④ backfill：**不做 SQL backfill**，改成在裝置上重新診斷一次

三個理由，第一個是決定性的：

1. 🔴 **SQL backfill 到不了裝置。** ADR-0004 的 local-first 不只是「本機優先」，而是
   單向的：整個 app 對 `captures` 只有 upsert / insert，`.select(` 在
   `supabase/functions/` 之外**零出現**，`hydrate()` 只讀 AsyncStorage。改了 Postgres
   那一列，裝置永遠看不到，而且下一次本機 upsert 還會把 backfill 的內容**蓋回去**。
2. **要 backfill 的資料量是 1 筆**（見 Consequences）。寫一支到不了裝置的腳本，比在練習頁
   按一次「看全文」貴。
3. **不能從 `explanation_zh` 推導 gloss** —— 那正是 ① 禁止的合併，只是換個地方做。真要補
   只能重跑診斷，而**重跑不具決定性**：同一句話先後餵三次，`focus_phrase` 分別回
   `"pharmacology, pharmacologic substance"` / `"spike adrenaline"` / `"pharmacology"`。
   backfill 出來的不是「那張卡本來的題目」，是一題新的。

所以補救路徑放在 `Practice.tsx` 的 `needsDiagnosis`：**有 diagnosis、type 是 `vocab`、
缺 `gloss_zh`** → 揭露全文時補診斷一次。三條護欄：

- module-level `Set` 擋重試，而且**在送出請求時就記**（失敗也算試過，否則失敗會變成每次
  揭露都重打一次）。這是「這次 app 啟動期間試過了」的暫時狀態，不值得多一個
  AsyncStorage key。
- **非 `vocab` 不重試**：出題本來就只做 vocab，重試是白花錢。
- **只有真的補到出題欄位才覆寫**既有 diagnosis。否則拿一筆一樣出不了題的新診斷去換掉他
  已經讀過的那一筆，只是把畫面上的字換掉、什麼也沒換到。

④ 同時是 ③ 那條 **all-or-nothing** 的理由：半成品（有正解、沒干擾項）會被 `needsDiagnosis`
當成「已經有了」→ 那張卡**永久**卡在 `'not-enough-distractors'`。要嘛給一張出得了題的，
要嘛什麼都不給、讓它下次還有機會。

### ⑤ 題面**只能**是 `diagnosis.focus_phrase`——他親手圈的字不准當題面（收窄 ADR-0017，不是推翻）

`gloss_zh` 是**針對 `focus_phrase`** 生成的；而 `selection_text` 從頭到尾沒有進過診斷
（`Practice.tsx` 只送 `{ sentence, context }`），`focus_phrase` 是模型自己從整句挑的。
**兩者可以指向不同的詞** —— ADR-0017 明文說那個不一致本身是有價值的資料。

原本 `buildCard` 讓 `selection_text` 當第一順位題面，錯得很安靜：題面印「alpha GPC」，
三顆按鈕卻是 `spike` 的三個選項——**一顆都不對**。使用者無論按哪顆，2/3 被判錯而寫下一筆
捏造的 `'again'`，剩下 1/3 判對、記下的是一件同樣不真的事。

ADR-0017 沒有被推翻，框選仍是最強訊號；被否決的只有「把兩個不同來源的字串湊成同一題」。
**要讓他圈的字回到題面上，正確做法是把 `selection_text` 一起送進診斷、讓 `focus_phrase`
對齊他圈的字**——那會動到 Edge Function 的輸入契約與 `Practice.tsx`，列為具名 follow-up
（已寫在 `liveActivity.ts` 裡），不是遺漏。

## Consequences

### 誠實記錄：**今天實際出得了 0 題**

線上直接查的（2026-08-14）：

| 指標 | 值 |
| --- | --- |
| `captures` | 15 |
| 其中有 `diagnosis` | **1** |
| 其中有 `gloss_zh` | **0** |
| 有 `transcript_text` | 7 |
| 有 `selection_text` | **0** |
| `difficulty_items`（＝今日佇列上限） | **1**（`due_date 2026-08-12`） |
| `replay_events` | 22 |
| 真實使用者 | 1 |

而且 —— **那唯一一張到期的卡，就是那筆唯一有診斷的 capture**（`c8355dc4…`）。它的
`focus_phrase` 是 `"pharmacology, pharmacologic substance"`：多詞，被本輪新增的
`MULTI_TERM_RE` 直接擋在出題之外。

所以：

- **今天排得出去的題目通知是 0 則**，和上一輪一樣。改變的只有**理由**：不再是「沒有
  生產者」，而是「既有資料還沒經過新的生產者」。`blocked` 也從 `'no-gloss'` 變成
  `'no-prompt'`（15 筆裡 14 筆連 diagnosis 都沒有），文案已經跟著改成指得到動作的那一句。
- **就算一切順利，今天的天花板是 1 題**，不是 ADR-0022 的一天 3 則 —— SRS 佇列上只有
  1 張到期卡。而要拿到那 1 題，必須有人在裝置上打開那張卡、按「看全文」、而且那次重診
  剛好回一個單詞的 vocab 並通過三道閘（不具決定性，見 ④-3）。
- 因此：**不准在任何地方把「通知答題」講成已上線的功能。** 它現在的狀態是「有題就發得
  出去，而今天沒有題」。ADR-0024 的同一條禁令繼續有效。

### 其他

- **成本**：有 vocab 候選時，diagnose 變成**兩次** Haiku 呼叫（診斷 + 複核，複核
  `max_tokens: 256`）。一次仍遠低於 $0.01；`DAILY_LIMIT 120` 不變，複核不另計 quota。
- **卡會變少，而且是刻意的。** 三道閘任何一道不過就不出題。少一張卡 = 使用者今天少一次
  曝光；多一張有兩個正解的卡 = 一筆捏造的 SRS `'again'`。這個交換率不對稱，所以永遠往
  fail closed 那一邊倒。**唯一看得出「今天為什麼卡變少」的是
  `[diagnose] quiz options rejected by blind check:` 那行 log，不要拿掉。**
- 🟡 **只取模型輸出順序的前 2 個干擾項。** prompt 要 3 個、schema 收 3 個，但
  `pickDistractors` 湊滿 `REQUIRED_DISTRACTORS = 2` 就 break —— 第 3 個被無條件丟棄，
  **即使它比前兩個乾淨**。這是實作的簡化，不是設計判斷；要改成「挑最好的 2 個」得先有
  一個品質分數。
- 🔴 **盲測複核的漏網率沒有量測值。** 18% 是 **v3（沒有複核）** 的人工判讀結果。v4 上線後
  只知道 17 組擋下 2 組，**沒有人逐張人工判讀過通過的那 15 組**。下一個做這件事的人請
  重新人工判讀，**不要引用 18%**。
- **驗證期間在 `auth.users` 留下 3 個匿名測試帳號**（現共 11 筆、全部 `is_anonymous`）。
  任何以「使用者數」當指標的地方要先扣掉 —— ADR-0011 的北極星靠的正是這些數字是真的。
- **零新增 dependency、未動 `app.json`**：全部落在 OTA 界線內（見
  `docs/02-execution/roadmap-expo-to-native.md` 的 OTA 規則），diagnose 是 Edge Function
  部署、其餘是 JS。
- **沒有 supersede 任何 ADR。** ADR-0007 的 strict-schema 契約原封不動（只加欄位）；
  ADR-0008 的 `verify_jwt` 與 server 端金鑰不變；ADR-0022 的出題器與單向 SRS 寫入不變；
  ADR-0024 的天花板（通知答題永不計入「練了」）不變；ADR-0017 被 ⑤ **收窄使用範圍**，
  論點不變。
- **follow-up（具名，不是「以後再說」）**：① 把 `selection_text` 送進診斷、讓
  `focus_phrase` 對齊他圈的字（⑤）；② 出題資格的診斷力目前只有 `console.warn`，**沒有
  任何地方數得出「今天有幾張卡被哪一道閘擋掉」**——要調閘門鬆緊之前得先有這個數字。
