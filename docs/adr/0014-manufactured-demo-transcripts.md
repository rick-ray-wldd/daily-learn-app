# ADR-0014 — 示範單集的逐字稿用「自製對齊素材」，與產品內容管線分開

- **Status:** accepted
- **Date:** 2026-08-06

## Context

ADR-0005 定下「有 `podcast:transcript` 就先用它，沒有才轉錄」。實作是對的，但
W3 實測後發現一個現實問題：**主流節目的 RSS 根本沒有 transcript tag**。抽查
Huberman Lab（`feeds.megaphone.fm/hubermanlab`）：`podcast:transcript` 出現 0 次。
官網逐字稿在 Huberman Premium 付費牆後面。

於是每一集都走 Whisper：第一個 10 分鐘窗口要等 45–60 秒才看得到第一行字。要驗證
「跟播捲動 / 點句跳轉 / 難詞標註」這些 UI 行為，每次都要先付這 60 秒和一次配額，
demo 現場更不可能這樣開場。

考慮過的選項：

1. **直接用 YouTube 字幕配 RSS 音檔** — 不行。RSS 版本有動態插入的廣告，時間軸
   跟 YouTube 版對不上，而且偏移量不是常數（mid-roll 位置每次抓都可能不同）。
2. **找有 transcript tag 的小眾節目** — 內容不具代表性，難詞密度低，測不到標註。
3. **自製一組時間軸保證對齊的素材** — 音檔和字幕都取自同一個 YouTube 來源，
   所以時間軸天然一致。

## Decision

我們會**為示範單集自製一組音檔 + 句子級 VTT，兩者同源**，放在 Supabase Storage 的
`demo-media` bucket，並以 `Episode.transcriptUrl` 餵給既有的 ADR-0005 路徑。

轉換工具是 `scripts/vtt_to_sentences.py`：它讀 YouTube 自動字幕的**逐字時間標記**
（`<00:00:02.320><c> where</c>`），還原成 (時間, 單字) 序列，再依標點重新斷句，
輸出一句一個 cue 的乾淨 VTT。不能直接用原始檔——YouTube 是 rolling caption，每個
cue 會把上一行重印一次，斷句也斷在畫面寬度而不是句子邊界。

`/podcast-dl` skill 附的 `clean_vtt.py` 不能取代它：那支刻意丟掉時間軸，產出的是
閱讀用純文字。兩支是不同用途，並存。

## Consequences

**變容易的**：示範單集的逐字稿是秒開的，零 Whisper 成本、零等待。跟播捲動、點句
跳轉、難詞標註可以在幾秒內反覆驗證。Pre-Demo Day 的 demo 不必賭現場網路和轉錄延遲。

**變難的 / 被綁住的**：

- 這條路**只適用於示範素材，不能成為產品內容管線**。它把節目方的音檔重新託管在
  我們自己的公開 URL 上，那是散布他人的著作，且 YouTube 的 ToS 也不允許把抽取的
  內容拿去商業散布。正式產品的逐字稿來源只有兩條：節目方提供的 `podcast:transcript`，
  或對節目方 CDN 上的音檔做轉錄（＝現有的 ADR-0005/0006 路徑）。
- `demo-media` bucket 是**公開讀、不可寫**。上傳素材時開的 insert policy 已在
  migration 005 收回；要加素材就再開一次臨時 policy、傳完再收。匿名註冊是開放的
  （ADR-0013），留著寫入權限等於讓任何人往專案裡丟檔案。
- 自動字幕是 ASR，人名與術語會有錯字（實測 Huberman 這集大致正確，但不保證）。
  難詞標註是建立在這份文字上的，所以示範時挑句要先看過。
- 整集逐字稿一次到齊會打破「一次只多一個窗口」的隱含假設：`TranscriptPanel` 因此
  只把**聽到的位置附近**送去標註（往回 1 分鐘、往前 5 分鐘），否則 295 句會立刻排出
  約 8 個批次，而 annotate 配額是 40 次/天且標註不寫磁碟。

**沒有 supersede 任何 ADR。** ADR-0005 的優先序（現成逐字稿 → Whisper）原封不動，
這份只是說明我們如何為示範單集製造出「現成逐字稿」這個輸入。
