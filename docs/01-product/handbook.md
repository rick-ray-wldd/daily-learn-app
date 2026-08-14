# Echo 使用手冊 — 每個功能怎麼用，以及它憑什麼有用

> **這份文件的用途**：把「產品長什麼樣」與「背後的教育理論」放在同一頁。
> 給三種人讀：想快速理解產品的人（導師／投資人）、要接手的工程師、以及未來的自己。
>
> 架構決策的「為什麼」在 `docs/adr/`。這份談的是**體驗**與**證據**。
> §4 的每個數字都是直接查線上資料庫得到的，**不是估計**。
>
> 最後更新 2026-08-14。標 🚧 的是寫好但尚未在實機驗證過的。

---

## 0. 一分鐘看懂

> 學習者每按一次返回鍵，就是在告訴我們他哪裡聽不懂——我們是第一個把這個訊號接住的 app。

```
聽 podcast
    │
    │  ↺15  ← 這一下就是訊號。他不必做任何額外的事
    ▼
replay_event         原始訊號（位置、速度、來源）
    │
    │  captureEngine 在裝置上聚合（3 秒內連續往回 = 同一個訊號）
    ▼
capture              一個難點窗口 [T-15, T]，前後各 +6s 當重播 context
    │
    │  隔天的每日練習才展開
    ▼
逐字稿 → 診斷 → 跟讀 → 評分 → SRS
```

**核心主張**：市面上所有單字 app 都要求學習者**主動標記**。Echo 不用——
「按返回鍵」本來就會發生，我們只是第一個把它當成資料的人。

---

## 1. 逐功能演示

### 1.1 首頁（三分頁之一）

```
┌─────────────────────────────┐
│ 正在播放                     │  artwork · 集名 · 進度
│ ⏮15  ▶/⏸  ⏭15   🔊────      │  音量滑桿（PanResponder 手刻）
├──────────┬──────────────────┤
│ 今日練習   │ 本週訊號環        │  重聽 N → 確認 M → 掌握 K
│    5     │      8.8         │
├──────────┼──────────────────┤
│ 🔥 連續   │ 難點詞庫          │  最近圈過的詞（橫向捲動）
├──────────┴──────────────────┤
│ 探索（雙欄 masonry，無限延伸） │
└─────────────────────────────┘
```

**怎麼用**：一開 app 就能播放、調音量、前後 15 秒——不必先進播放器。

**為什麼上半是 bento、下半是 masonry**（ADR-0020）：這是兩種**相反的組織原則**。
bento 是固定、策展、有限（你的數據）；masonry 是無界、均質、無限（內容）。
並排會互相消解，只能上下疊。

**音量為什麼要自己手刻**：RN 核心沒有 Slider。而且 `onStartShouldSetPanResponder`
必須回 `false`，否則在 ScrollView 裡垂直拖曳會被滑桿吃掉、音量跳到手指的 x 座標。

---

### 1.2 播放器與逐字稿閱讀器

**跟播**：當前句用**三個訊號同時**表達——字級（21 vs 18）、亮度（`text` / `dim` /
`faint` 三階）、左側 3px 藍色標記。

> 為什麼要三個：單一訊號在快速捲動時會被忽略。而**藍色**在 `theme.ts` 的語意是
> 「中性 chrome ＝進度」，用在這裡正確——它表達的是播放位置，不是「你動手了」（綠）
> 也不是「app 在猜」（琥珀）。

**「還沒播到」的句子刻意不是幾乎看不見的灰**（對比度下限訂在 AA 5.1:1）：
學習者會主動往下讀來預判內容，讀不動就等於沒有逐字稿。

#### 📚 理論：時長線索與詞界

放慢播放（0.7x）是**時間伸縮**，它把所有音段等比拉長。但真實的慢speech是
**母音與停頓拉長、子音幾乎不變**。後果：

| 被破壞的 | 為什麼要緊 |
| --- | --- |
| 音段時長比例 | L2 聽者靠時長分辨 tense/lax 母音（/i/–/ɪ/、/æ/–/ɛ/） |
| 塞音爆破（transient smearing） | 爆破是偵測**詞界**最強的線索之一 |
| F0 輪廓 | 音高變化率下降 → 語調失真 |
| **弱讀** | "wanna" 放慢**還是** "wanna"——他需要的是邊界，拉長不會生出邊界 |

所以 0.7x 是**權宜之計**，正確解法是合成一份原生慢速的音檔（見 §1.6）。

---

### 1.3 琥珀詞（annotate）

逐字稿裡被淡琥珀底色標起來的詞，點下去出現**中文解釋**。

**誰標的**：`annotate` Edge Function，Claude Haiku 4.5，一個 10 分鐘窗口約 $0.005。
它是三支 Edge Function 裡呼叫量最大的。

**為什麼用 LLM 而不是詞頻表**：詞頻表只能說「這個詞罕見」，說不出它在**這個句子裡**
的意思——一詞多義、片語動詞、專有名詞背景都需要上下文。

**為什麼是琥珀色**：`theme.ts` 的鐵律是綠＝學習者動手了、琥珀＝app 在猜、藍＝中性。

> annotation 猜錯是常態，**它必須永遠看起來像個猜測**。

而且是**半透明**不是實色：同一個詞可能出現在當前句（`surfaceAlt` 底）也可能在
非當前句（`bg` 底），實色會在其中一種糊掉。

#### 📚 理論：glossing 的效益與它的天花板

- **L1 gloss 優於 L2 gloss**：用母語解釋的保留率穩定較高 → `explanation_zh` 是對的
- **但「看完就關掉」是保留率最低的條件**。Involvement Load Hypothesis
  （Laufer & Hulstijn 2001）把任務拆成 **need（需要）· search（尋找）·
  evaluation（判斷）**，純閱讀三者都接近零

所以 TermSheet 上的「**＋ 加入練習**」才是把它變成有效益的關鍵——它建立一個 `need`，
並把 `evaluation`（這是詞還是句型？懂了嗎？）**延到隔天的練習卡**。

**為什麼不在當下就問**：聽的當下不打斷是產品底線。要求判斷的步驟一律留到隔天。

---

### 1.4 兩點框選（B 模式）

閱讀器右上開啟「框選」→ 點第一個字定起點 → 點第二個字定終點 → 中間整段高亮 →
確認後問「單字還是句型」。

**為什麼是兩點而不是長按拖曳**：
- 不需要手勢仲裁（就是兩次 `Pressable`）；長按拖曳會與垂直捲動打架
- **單手、走路中做得到**——這是聽力 app 的真實使用情境
- 天然對應既有的 `window_start / window_end` 跨度模型

開啟框選時 **tap-to-seek 停用**：同一個字上兩種手勢會讓人意外跳走播放位置。

#### 📚 理論：noticing 的實驗證據

這是整個產品最直接的證據。Cambridge *Bilingualism: Language and Cognition* 的
「Noticing vocabulary holes aids incidental second language word learning」：

| 比較 | 立即 | 15 分鐘後 | Odds ratio |
| --- | --- | --- | --- |
| 被要求出聲、注意到缺口 vs 沒注意到 | **+70%** 正確音素 | +58% | 4.57 |
| **自發**注意到缺口 vs 沒注意到 | **+59%** | +40% | 3.06 |
| 出聲組 vs 自發組 | 無顯著差異 | — | — |

**第三列最重要**：被強迫做動作 ≈ 自發注意到，**沒有差別**。

> 真正起作用的是「意識到自己有洞」，不是「做了什麼動作」。
> **而按返回鍵就是自發意識到有洞的瞬間。**

意涵：框選不需要做得很重，它只要**把那個已經發生的 noticing 固定下來**。

---

### 1.5 「我聽不出這裡有幾個字」

框選動作列的第三顆按鈕。**只要點一個字就能按**，目標是那個字所在的整句。

**為什麼需要這個出口**：框選預設使用者**知道自己漏聽的是哪個詞**。但詞界切分失敗
時，他根本沒把聲音切成詞——**框不出來**。逼他框只會讓他亂框或放棄。

#### 📚 理論：lexical segmentation

Field (2003) 與後續研究：

- 低層次的**詞界切分錯誤會摧毀整段理解**——切錯一個詞，後面整串話的詮釋跟著崩
- 190,000 詞的英語口語語料中，**90% 的實詞以強音節開頭**，聽者靠重音切詞
- **第一個 1000 詞的聽覺詞彙知識 + 切分能力，合起來解釋 TOEIC / Eiken 聽力成績
  34–38% 的變異**

**這是 Echo 資料上的護城河**：市面上沒有任何 app 收集「學習者連詞界都切不出來的
位置」。閱讀 app 永遠看不到它——文字裡沒有連音。

---

### 1.6 每日練習卡

```
┌─ ▓▓▓░░ +2          第 3 / 7 張
│
│  ★ 弱訊號            Huberman Lab Essentials
│  難點窗口 5:07 – 5:37
│  你在這裡重聽了 1 次
│
│ ┌─────────────────────────────┐
│ │ 這一句           5:07–5:37   │
│ │ 前一句當線索（灰）            │
│ │ ▬▬ ▬▬▬▬ ▬ ▬▬▬▬▬▬ ▬▬        │  ← 遮罩帶著原句形狀
│ │ [▶ 原速]  [慢速 0.7x]        │  ← 永遠可按
│ └─────────────────────────────┘
│
│  聽完再決定。是真的沒聽懂，還是只是分心？
│  [這段是真的沒聽懂]  [只是分心，滑掉]
└─
```

確認後展開：**三段漸進揭露** → 診斷卡 → 跟讀錄音／原音對照 → 評分 → SM-2。

#### 三段揭露：clue → hint → full

| 階段 | 顯示什麼 |
| --- | --- |
| `clue` | 只給**前一句**當線索；目標句用依真實字長排出的橫條遮著 |
| `hint` | 骨架換成「首字母 + 點」，字數與長度都在，仍要自己補完 |
| `full` | 全文（**後一句**這時才出現） |

**為什麼線索是前一句而不是後一句**：聽力理解是往前推進的。前一句是他**已經聽懂**
的那一句，拿它當支點才叫線索；後一句等於先看結局。

**為什麼遮罩要帶著原句的形狀**：學習者看得到句子有多長、哪個字特別長、節奏是什麼，
卻讀不到內容。均勻的一整塊灰做不到這件事，而**形狀正是聽力重建句子時真正用得上的
線索**。這也是「六張卡不會長得一模一樣」的來源。

#### 📚 理論：desirable difficulties 與 retrieval practice

漸進揭露的設計依據是**提取難度**——太容易提取不會留下記憶痕跡，太難則會放棄。
三段給的是可調的難度階梯。

而「跟讀完回到原音、遮住字幕、再聽一次」🚧 是 **retrieval practice**（提取練習），
記憶介入裡效果最強的一類。它同時是 Mirror 的**問責機制**：如果你能把自己的克隆音
跟讀得完美，卻依然聽不懂主持人，那個鷹架就沒有轉移。

#### 📚 理論：shadowing 的效益與邊界

- shadowing **啟動由下而上的處理**，幫助解碼語流中的語言單位
- 對**初學者與低程度學習者**在「感知聲音、辨識連續語流中的詞」上有效
- **進階學習者受益較少**，尤其在高層次理解任務
- **重複次數是關鍵變數**——次數越多，聽力進步越大

意涵：跟讀對 `linking` / `segmentation` 類的卡應該是**主線**而非選配，而且要支援
連續多次。對高程度使用者則可淡化。

---

### 1.7 訊號四級

```
saved      點了 app 標的琥珀詞說想學（**沒有倒帶**）    ← 最弱
weak       倒帶了
strong     倒帶 + 10 秒內開了逐字稿
selected   倒帶 + 開稿 + 親手指出是哪幾個字            ← 最強
```

**為什麼是一條管線而不是四張表**（ADR-0003 / ADR-0017）：它們在下游（診斷、SRS、
每日 session）的行為完全一樣，分表只會讓每個查詢都要 union。

**⚠️ `saved` 被排除在每一個訊號指標之外**——首頁漏斗、倒帶確認率、難點總數、
完成畫面的計數、`weakTypesFromCaptures`。因為它**沒有理解斷點**。

> 這裡犯過兩次錯：`selected` 曾污染 confirm rate，把「倒帶偵測有多準」變成
> 「使用者多常用框選」。所以規則是**白名單不是黑名單**。

還有一個更隱蔽的：`saved` 出生就是 `confirmed`，如果它的診斷回頭餵進 `annotate`
的 `weakTypes`，就變成「app 標詞 → 使用者收下 → 影響 app 下次標什麼」，**全程零倒帶**。
用 `hasRewindEvidence()` 白名單擋掉。

---

## 2. 教育理論總表

| 理論 | 對應功能 | 證據強度 |
| --- | --- | --- |
| **Noticing 缺口** | 倒帶＝訊號、框選 | 🟢 強。OR 3.06–4.57；**自發 ≈ 強迫** |
| **Lexical segmentation**（Field 2003） | 「我聽不出幾個字」出口、linking 分類 | 🟢 強。解釋聽力成績 34–38% 變異 |
| **Involvement Load**（Laufer & Hulstijn 2001） | 「單字/句型」那一問、加入練習 | 🟢 強。原始研究 + 複製研究 |
| **L1 gloss > L2 gloss** | `explanation_zh` | 🟢 穩定 |
| **Retrieval practice** | 回原音驗收 🚧、SRS | 🟢 強 |
| **Formulaic sequences**（Wray 2002） | 句型整塊學、跟讀整塊 | 🟡 中。與流暢度相關明確 |
| **Shadowing** | 跟讀錄音 | 🟡 中。**低程度受益，高程度較少** |
| **HVPT**（79 篇 meta-analysis） | 未實作（跨集同詞複習） | 🟢 強。g=0.92 / 0.67 |
| **Collocation 處理** | **尚未納入分類** | 🟡 中。對中文母語者價值高 |
| **Golden speaker / Mirror** | Mirror 音 🚧 | 🔴 **弱。主觀偏好顯著，客觀 null** |
| **Spaced repetition** | 簡化 SM-2 | 🟢 強（但見下） |

### ⚠️ 關於 Mirror 的誠實聲明

創辦人自己做過 N=12 的受試者內實驗（《Shadow Your Perfect Self》，CSIE7641）：

- **主觀**：學習者壓倒性偏好自己的聲音。C3（自己·L1腔）在 helpful / like-me /
  easiest / comfortable **四個維度全部第一**；C1（母語陌生人）**在任一維度都沒領先過**
- **客觀**：四指標**不分離且互相矛盾**。H1 未成立
- **原作者結論**：**「瓶頸是測量，不是動機。」**

所以**不可以說「用自己的聲音練發音更有效」**——自己的資料不支持。正確說法是：

> 我們把它當**入門門檻的降低**，不是療效。而且每次練習最後一定回到真實原音驗收，
> **橋有沒有走過去，我們量得到。**

### ⚠️ 關於 SRS：為什麼還沒換 FSRS

FSRS 用 DSR 模型（Difficulty / Stability / Retrievability），在數億次複習的
benchmark 上達到同樣保留率**少 20–30% 複習量**。

**但低於約 1000 次複習，FSRS 擬合不出個人參數、退回預設值，表現與 SM-2 相當。**
目前 `difficulty_items` 是 **1 筆**。距離那個門檻還有三個數量級，所以現在換是純成本零收益。

**現在該做、且零成本的**：把 review log 存好（每次評分的 rating、elapsed days、
當時 interval）。之後要換 FSRS 或訓練自己的 half-life regression 才有資料。
**現在不存，之後永遠補不回來。**

---

## 3. 刻意不做的事

| 不做 | 理由 |
| --- | --- |
| 聽的當下要求任何判斷 | 打斷聆聽是產品底線。confirm/dismiss 一律留到隔天 |
| 用綠色標難點詞 | 綠＝學習者動手了。學習者會以為那個詞可以按 |
| 讓 annotation 進入訊號 | 它是**推測**。只有 confirmed capture 才算數 |
| 一個 capture 教多個文法點 | ADR-0012：一個學習焦點。多了診斷準確率會崩 |
| 無上限的每日佇列 | ADR-0011：有上限的清單會被做完，無上限的會被放棄 |
| 把 `saved` 算進訊號指標 | 它沒有理解斷點。混進去會讓指標量到別的東西 |
| 擴充難點分類到 8–9 類 | 分類越多，Claude 分類準確率越低、UI 選項越沒人用 |

---

## 4. 實測狀態（2026-08-14 直接查線上資料庫）

> 這一節的每個數字都是跑 SQL 查出來的，不是估計。日期一過就會失準——
> 引用前先重查。

### ✅ 已驗證會動的

**核心閉環完整跑通過一次**（這是整個產品第一次端到端成立）：

```
08-08 04:41  倒帶 → capture (weak)
             → transcript_text  "Now, it's vitally important to point out
                                  that you do not need pharmacology…"
             → diagnosis        type=vocab
                                focus_phrase="pharmacology, pharmacologic substance"
             → practiced
             → difficulty_items  ease 2.5 · interval 1 · due 08-12 · reps 1
```

**鎖定畫面的倒帶推斷有效**（ADR-0016）：

| trigger_source | 筆數 | 跳幅範圍 |
| --- | --- | --- |
| `screen` | 19 | 1.6 – 1334.7 秒 |
| `lockscreen` | **3** | **10.0 – 10.1 秒** |

10.0–10.1 秒正是 `expo-audio` 寫死的往回鍵間隔——這是那三筆真的來自鎖屏、
而不是誤判的簽名。三道閘沒有把真事件吃掉。

> 值得記下來的教訓：這套推斷上線後**曾有三天一筆都沒有**，當時的結論是
> 「可能壞了」。實際上只是還沒有人從鎖屏按過往回鍵。
> **在只有一個使用者的階段，「零筆」通常是使用量的問題，不是程式的問題。**

**migration 006 已套用並往返驗證**：正向寫入 `selected` / `saved` /
`segmentation` 全部 201；負向寫入 `bogus` 被 `23514` 擋下（證明 CHECK 是被
重建的，不是被丟掉沒補回來）。

### 📊 目前的量

| | 筆數 | 備註 |
| --- | --- | --- |
| `captures` | 15 | 7 筆有逐字稿、**只有 1 筆有診斷** |
| `replay_events` | 22 | screen 19 / lockscreen 3 |
| `difficulty_items` | **1** | |
| `practice_sessions` | 2 | |
| **真實使用者** | **1 位** | 創辦人本人 |

### ❌ 還沒發生的

| 項目 | 狀態 |
| --- | --- |
| 框選 / 標註詞加入練習 / 切分出口 | **一次都沒被用過**。`selection_kind` 全為 null、`selected` 與 `saved` 各 0 筆。功能在、006 也通了，但還沒實測 |
| 通知答題 | 出不了題——`gloss_zh` / `distractors_zh` 尚無生產者。而且就算有，**15 筆裡只有 1 筆有診斷** |
| Mirror 音檔 | **一個都不存在**。那條播放路徑從未實際播放過一次 |
| Live Activity | 1,160 行 Swift **從未編譯過**（本機沒有 Xcode）；`app.json` 未引用，不在任何 binary 裡 |
| 搭配詞（collocation） | 未納入六類分類 |
| 英語程度估計 | 未實作。計劃見 §5 |

### 一個貫穿全部的限制

**N = 1。** 上面所有「有效」都只在一個人身上驗證過，而那個人是設計者本人。
這不會讓那些數字變假，但它決定了它們能支撐什麼結論——**它們證明管線通了，
不證明產品有用。**

---

## 5. 下一步的理論依據

**英語程度估計**：每個被框的詞，它的 CEFR 等級就是一個 datapoint。
CEFRLex / EFLLex 提供約 13,000 詞條、每條有 A1–C2 六級的正規化頻率分佈、
machine-readable 可下載。

但只看「他框了什麼」會系統性高估。**負樣本免費**：一段 200 詞的逐字稿他框了 3 個，
其餘 197 個就是弱標記的「大致會」。這構成 IRT 的二元反應矩陣——詞的 CEFR 級當難度
參數，使用者能力 θ 待估。文獻上 IRT + 適性測驗 30 題就能收斂，而**你每一集就是幾百題**，
且是在真實聽力情境下作答的。

---

## 參考文獻

- Noticing vocabulary holes aids incidental second language word learning — *Bilingualism: Language and Cognition*
- Hulstijn & Laufer (2001), Some Empirical Evidence for the Involvement Load Hypothesis — *Language Learning*
- Field (2003), Promoting Perception: Lexical Segmentation in L2 Listening
- Exploring the relationships between L2 vocabulary knowledge, lexical segmentation, and L2 listening comprehension — *SSLLT*
- Wray (2002), Formulaic Language and the Lexicon
- Uchihara & Karas, High variability phonetic training (HVPT): A meta-analysis — *SSLA*
- Zhang, Cheng & Zhang (2021), The Role of Talker Variability in Nonnative Phonetic Learning — *JSLHR*
- Shadowing for Developing EFL Learners' Bottom-up Listening Skills: A Systematic Review
- What contributes to fluent L2 speech? L2 collocational processing — *Applied Psycholinguistics*
- Ding et al. (2019), Golden speaker builder — *Speech Communication*
- Kusz & Pawliszko, Efficacy of AI Voice Cloning in Phonetic Self-Imitation — *IJAL*
- 蔡秉叡 (2026), *Shadow Your Perfect Self* — CSIE7641 多模態人機互動期末專案（N=12）
- Settles & Meeder (2016), A Trainable Spaced Repetition Model for Language Learning — ACL
- FSRS — Free Spaced Repetition Scheduler（DSR 模型）
- CEFRLex / EFLLex — UCLouvain
- Estimating Learners' Vocabulary Size under Item Response Theory — *Vocabulary Learning and Instruction*
