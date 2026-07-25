# 六週執行計劃（2026-07-13 → 08-21）

節奏：每週一 NTU Day（09:30–12:30 @ SIT）= sprint review。
每週日晚上寫 `weekly-log/`，週一直接報告。
**8/17（一）Pre-Demo Day，12 分鐘 —— 一切倒推自這一天。**

## 總覽
| 週 | 日期 | 主題 | 週一 NTU Day 交付 |
| --- | --- | --- | --- |
| W1 | 7/13–7/19 | 驗證 + 骨架 | 宣布題目、招募 cohort 當 beta 用戶 |
| W2 | 7/20–7/26 | Capture pipeline 打通 | Demo：rewind → 句子被抓下來 |
| W3 | 7/27–8/2 | 練習閉環 + TestFlight | 10 位 beta 用戶開始用 |
| W4 | 8/3–8/9 | 迭代 + vision demo + deck v1 | 首批留存數據 + demo 影片粗剪 |
| W5 | 8/10–8/16 | Traction 衝刺 + pitch 演練 | 30+ 用戶、deck v2、mock pitch |
| W6 | 8/17–8/21 | **8/17 Pre-Demo Day** + 投資人會議 | 正式 pitch + 後續行動 |

## 逐週細節

### W1（7/13–7/19）驗證 + 骨架 —— 同步進行，不要先訪談再開工
- **訪談 15+ 人**（cohort 15 人 + Stanford/灣區國際學生）：用
  `docs/04-research/user-interview-guide.md`。要驗證的不是「想不想學英語」，
  是「重聽行為存在嗎、頻率多高、事後想不想撿回來」
- **Expo app 骨架**：RSS 訂閱 + 播放器 + 背景播放 + rewind 事件上報 Supabase
  （E2E 打通，醜沒關係）
- 自己開始每天用（founder dogfooding 從 day 1）
- 決定產品名（候選：Echo / Relisten / Loopback）+ 註冊 domain

### W2（7/20–7/26）Capture pipeline
- Whisper ASR + 句子對齊 + 擷取窗口演算法（見 signal-design.md §4）
- Claude 診斷分類 v0（六類難點）
- 每晚生成「明日練習」digest（先用推播 + 簡單列表）
- 里程碑：**自己連續 7 天每天被 app 抓到 ≥3 個真難點,且 confirm rate ≥60%**

### W3（7/27–8/2）練習閉環 + 上 TestFlight
- Daily session UI：滑掉誤報 → 重聽（原速/0.7x）→ 逐字稿 → shadowing 錄音 → SRS
- Streak + 每日推播
- TestFlight 發給 10–15 人（cohort 優先），PostHog 事件埋好
- 開始每天看數據：captures/日、session 完成率

### W4（8/3–8/9）迭代 + 融資材料啟動
- 依 beta 回饋迭代 2 輪（每輪 ≤3 天）
- **真實生活模式 demo**：背景 rolling buffer + AirPods 手勢（技術驗證，
  拍進 demo 影片用）
- 錄 90 秒 demo 影片（腳本見 pitch-outline.md）
- Deck v1（10 頁）
- **送出 accelerator 申請：Z Fellows（隨到隨審）、YC（W27 batch）、Neo**
  ——W4 就送，不要等 W6

### W5（8/10–8/16）Traction 衝刺 + pitch 演練
- 用戶衝到 30–50：cohort 轉介、Stanford 國際學生社團、r/EnglishLearning、
  小紅書留學生圈
- Metrics dashboard 一頁（給投資人看的版本）
- 透過課程導師 + Plug & Play workshop 約投資人/導師會議（目標：W5–W6 排 10+ 場）
- Deck v2 + 12 分鐘 pitch 完整演練 3 次（對 cohort、對導師、對鏡頭）

### W6（8/17–8/21）Pre-Demo Day + 收割
- 8/17 正式 pitch
- 投資人/angel 會議執行；每場後 24h 內 follow-up email
- 收集：angel 意向、accelerator 面試、導師 warm intro
- 寫下 8/21 之後的路徑決定：回台繼續做？申請下一批 accelerator？

## 可融資里程碑（8/21 檢核）
- [ ] 30+ 真實用戶，D7 留存 ≥25%
- [ ] 活躍用戶平均 ≥3 captures/日、session 完成率 ≥50%
- [ ] 90 秒 demo 影片（含真實生活模式）
- [ ] 2–3 個 accelerator 申請已送出，≥1 個面試
- [ ] 10+ 場投資人/導師會議，≥2 位 angel 進入 SAFE 層級討論

## 風險與砍法（時間不夠時的優先序）
1. 先砍：發音比對回饋、弱點儀表板
2. 再砍：真實生活模式 demo 改用「概念影片」呈現
3. 絕不砍：核心循環（rewind→capture→daily session）+ 留存數據 + demo 影片
