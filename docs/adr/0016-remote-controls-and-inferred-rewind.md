# ADR-0016 — 系統播放控制項；外部倒帶靠「位置忽然往回」推斷回同一條管線

- **Status:** accepted
- **Date:** 2026-08-08

## Context

實機測試發現控制中心／鎖定畫面的播放器對 Echo 是死的：不顯示曲目，按鍵沒反應。

原因不是設定漏了，而是**少呼叫一個函式**。`expo-audio` 57 的 iOS 端有完整的
`MediaController`（`MPNowPlayingInfoCenter` + `MPRemoteCommandCenter`），但它要等到
有人把某個 player 設成 active 才會啟動——在那之前每個 remote command 都是
`isEnabled = false` 且沒有 target，系統手上也沒有這個 app 的曲目資訊。

背景播放本身沒問題：`expo-audio` 的 config plugin 預設 `enableBackgroundPlayback`，
`UIBackgroundModes: ['audio']` 早就在 binary 裡，所以這件事**不需要重新 build**。

真正的難題在第二層。`MPRemoteCommandCenter` 的 handler 在原生層直接呼叫
`AVPlayer.seek`，**完全不經過 JS**：

```swift
remoteCommandCenter.skipBackwardCommand.addTarget { [weak self] event in
  let seekTime = currentTime - CMTime(seconds: event.interval, ...)
  player.ref.seek(to: seekTime, ...)          // ← JS 這邊什麼都收不到
}
```

也就是說，一旦把系統控制項打開，使用者從鎖定畫面倒帶——**這個產品唯一在乎的訊號**
——會憑空消失。ADR-0003 早就把「鎖定畫面遙控」列為 `trigger_source` 之一，但那份
ADR 假設事件會由我們自己的程式送出。

## Decision

**一、啟用系統控制項，而且只啟用一次。**

`setActiveForLockScreen(true, metadata, { showSeekBackward, showSeekForward })` 接在
`setAudioModeAsync` 的 promise 之後（`interruptionMode` 必須先是 `'doNotMix'`，
系統才會把控制項對應到這個 player）。

⚠️ 這個呼叫**不可重複**。`enableRemoteCommands()` 每次都 `addTarget`，而對應的
`removeTarget(self)` 移不掉 block 形式的 handler——重複啟用會讓按一次往回鍵 seek
好幾次。換集一律走 `updateLockScreenMetadata`。

往回／往前的秒數由 `expo-audio` 寫死成 10 秒，JS 改不了，所以鎖定畫面的往回幅度
與 app 內的 ↺15 不一致。接受這個不一致：難點窗口是從 `fromPos` 往回算的
（`captureEngine`），跟系統跳了幾秒無關。

**二、外部倒帶用播放位置推斷，回到同一條管線。**

狀態每 250ms 取樣一次，外部 seek 之後下一格 `currentTime` 就會忽然往回。往回超過
`EXTERNAL_REWIND_MIN_SEC`（3 秒）且不是我們自己送的 seek → 記成一筆
`trigger_source: 'lockscreen'` 的 replay event，走 `logReplayEvent` 的原路。

「不是我們自己送的」用兩道閘，都放在 ref 而不是 state（`seekTo` 送出到 state 生效
之間會有 status tick 進來，那一格會把自家的 ↺15 誤判成外部倒帶）：

1. `seekTo` 開一個 `SEEK_SETTLE_MS` 的時間窗，窗內的位置跳動一律不算。
2. 位置落在最後一次自家 seek 目標的 ±`SEEK_SETTLE_SEC` 內 → 是遲到才生效的自家
   seek（音檔還在載入時送出的），不算。

換集時 `lastTimeRef` 歸零、`lastCommandedRef` 清空——`replace()` 一定會把位置打回
0，那不是倒帶。

## Consequences

- 鎖定畫面／控制中心／耳機線控的暫停、播放、往回、往前、拖曳進度條全部可用，
  而且往回會被記成訊號。**純 JS，OTA 可送。**
- 從鎖定畫面按播放會沿用目前的播放速度（原生的 play command 讀 `player.currentRate`），
  0.7x／0.85x 不會被打回 1.0x。
- **偏向漏記而不是誤記。** 兩道閘都可能吃掉真的外部倒帶（例如外部倒帶剛好落在
  上一次自家 seek 目標的 1.5 秒內）。這是刻意的：幻覺事件會替一句學習者從沒重聽
  過的話建出 capture，比少一筆更傷。
- **3 秒門檻是產品判斷，不是技術常數。** 系統往回鍵是 10 秒，遠在門檻之上；門檻
  存在是為了擋掉緩衝抖動與微幅拖曳。之後若加入耳機的小幅度手勢要回來重看。
- **JS 被 iOS 暫停期間的倒帶會漏掉。** 背景音訊模式下 JS thread 通常還活著，但不
  保證。真的要滴水不漏，得等 `expo-audio` 把 remote command 以事件送進 JS
  （上游議題），到時這整套推斷就可以拆掉並 supersede 這份。
- 練習頁播放時不會搶走鎖定畫面（`PracticeScreen` 的 player 從未註冊），所以控制
  中心仍然停在暫停中的 podcast 上——從那裡按播放就是回到 podcast，行為正確。

**沒有 supersede 任何 ADR。** ADR-0003 的單一管線不變，這份只是把它列為未來來源的
「鎖定畫面遙控」真的接上去。
