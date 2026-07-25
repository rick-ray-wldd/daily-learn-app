# Echo — 核心閉環雛形（Expo，W1+W2）

英語學習 podcast app 的可跑閉環：
**聽 podcast → 按 Back 15s（rewind 訊號）→ capture 自動生成分級 → 逐字稿/診斷（可選）→ 今日練習（確認→重聽→跟讀→SRS）**。
產品脈絡見 `../docs/01-product/mvp-spec.md`、訊號設計見 `../docs/01-product/signal-design.md`。

## 怎麼跑

```bash
npm install
npx expo start
```

1. 手機裝 **Expo Go**（App Store / Play Store）。
2. 手機和電腦連同一個 Wi-Fi。
3. 用 Expo Go（Android）或相機（iOS）掃 terminal 顯示的 QR code。

> 音源是網路串流（NPR simplecast / archive.org），第一次載入要幾秒。
> **全程 Expo Go 可跑**：零原生模組、無 ffmpeg、無 react-navigation（分頁是 state 切換）。

## 核心閉環怎麼玩

1. **播放器** tab：播放任一集，聽不懂就按綠色大按鈕「↺15」（或在進度條往回拖）。
2. 每次 rewind 都進 `lib/captureEngine.ts` 即時歸併成 capture 並分級
   （signal-design.md §2）：
   - 同一段重聽 ≥2 次（窗口重疊）→ **★★★ strong**，窗口取兩次交集
   - rewind 後 10 秒內降速 → **★★★ strong**
   - 單次 rewind → **★ weak**（可能只是分心）
   - rewind 後 3 秒內又往更早倒 → 視為找段落，只合併窗口不升級
3. **今日練習** tab（badge = 待練數）：一次一張卡——
   - **確認**：「真的沒聽懂」/「只是分心，滑掉」（滑掉也記錄＝免費的雜訊標註）
   - **重聽**：1x / 0.7x 重播該段 context 窗口（前後各 +6s，到點自動停）
   - **逐字稿**：先遮住、點開才看；有 Anthropic key 會附六類難點診斷卡
   - **跟讀**：錄音 → 播自己的錄音 → 再播原音對照
   - **評分**：再來一次 / 記住了 / 太簡單 → 簡化 SM-2 排程明天以後的複習
4. 全部做完顯示今日統計（練了幾句、strong/weak、明日到期數）。

所有資料存在手機（AsyncStorage + FileSystem cache）；設定 Supabase 後
captures / difficulty_items / practice_sessions 會 best-effort 同步上雲。

## .env 設定（全部選填）

```bash
cp .env.example .env   # 填值後 npx expo start -c 重啟
```

| 變數 | 沒設的行為 | 設了的行為 |
| --- | --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` + `ANON_KEY` | 本地模式，資料只存手機 | replay_events / captures / difficulty_items / practice_sessions best-effort 上雲 |
| `EXPO_PUBLIC_OPENAI_API_KEY` | 練習卡顯示「逐字稿待轉錄」，流程照常 | 每集自動 Whisper 轉錄一次並快取（segments 含時間戳） |
| `EXPO_PUBLIC_ANTHROPIC_API_KEY` | 略過診斷卡，流程照常 | 顯示逐字稿時自動診斷該句（六類難點＋中文解釋＋練習建議） |
| `EXPO_PUBLIC_DIAGNOSE_MODEL` | 預設 `claude-haiku-4-5-20251001` | 換診斷模型 |

**成本估算（founder 自用量級）**：Whisper ≈ $0.006/分鐘（25 分鐘一集 ≈ $0.15，
每集只轉一次）；Claude Haiku 4.5 診斷單句 ≈ 數百 tokens，遠低於 $0.01/句。
一天聽一集＋練 10 句 < $0.2。

**⚠️ 安全 TODO（W3）**：`EXPO_PUBLIC_*` 會被打包進 JS bundle——拿到 app 的人
就拿得到 key。目前僅限 founder 自用 dogfood；W3 要把 Whisper / Claude 呼叫移到
Supabase Edge Functions（server 端持 key），client 全面去 key。

Supabase 端：在 SQL Editor（或 `supabase db push`）跑
`supabase/migrations/001_init.sql`——六張表、開發期 RLS、demo seed
（episode UUID 跟 `lib/episodes.ts` 硬編的一致，FK 才成立）。

## 資料夾結構

```
app/
├─ App.tsx                      # 播放器 + 分頁（播放器｜今日練習，state 切換）
├─ screens/
│  └─ Practice.tsx              # 每日練習：確認→重聽→逐字稿/診斷→跟讀→評分
├─ lib/
│  ├─ episodes.ts               # 硬編 2 集 demo episode（UUID 對齊 DB seed）
│  ├─ replay.ts                 # ReplayEvent 型別 + best-effort Supabase 同步
│  ├─ captureEngine.ts          # rewind 訊號分級/歸併 → Capture（§2 §4）
│  ├─ store.ts                  # AsyncStorage 持久化 + in-memory cache + subscribe
│  ├─ transcript.ts             # Whisper 逐字稿（可選；快取每集只轉一次）
│  ├─ diagnose.ts               # Claude 難點診斷（可選；strict tool-use JSON）
│  ├─ srs.ts                    # 簡化 SM-2 純函式
│  ├─ types.ts                  # Capture / Diagnosis / SrsItem / … 共用型別
│  └─ supabase.ts               # env 齊才建 client，否則 null（本地模式）
├─ supabase/
│  └─ migrations/001_init.sql   # 六張表 + 開發期 RLS + demo seed
├─ .env.example
└─ README.md
```

## Expo Go 的已知限制（刻意的取捨，維持不變）

- **耳機遙控 / 鎖屏控制還接不到**：iOS 的 `MPRemoteCommandCenter`（AirPods
  back-15s、鎖屏播放器）需要原生模組 `react-native-track-player`，不能在
  Expo Go 裡跑，需要 dev build（`npx expo prebuild` + EAS）。目前用畫面按鈕
  驗證「重聽=訊號」；`replay_events.trigger_source` 與 captureEngine 的輸入
  已預留 `headphone` / `lockscreen`，接上之後管線零改動。
- **背景播放在 Expo Go 不保證**：已設 `shouldPlayInBackground`，穩定背景播放
  + lock screen artwork 要等 dev build。
- **音檔切片（ffmpeg-kit）不可用**：所以 >25MB 的音檔直接放棄轉錄（Whisper
  上限），練習重播用的是串流 seek 而非切片檔。

## 下一步（W3+）

- Whisper / Claude 移到 Supabase Edge Functions（去掉 client key）
- dev build + `react-native-track-player`：耳機遙控 back-15s（trigger_source: 'headphone'）
- iTunes Search + RSS 訂閱，取代硬編 episodes
- 每日推播（「你昨天存了 N 個難點，花 8 分鐘清掉」）+ streak
- Mirror 模式（自聲流利版對照，見 mvp-spec P1）
