# Echo icon 素材

四張 ChatGPT 產的 logo 稿，加上一份 Expo 範本 icon 的備份。
`app/assets/` 底下的 icon 全部由 `design/build-icons.mjs` 從**這裡的其中一張**產生，
不要手動改 `app/assets/*.png` —— 改了下次跑腳本就被蓋掉。

```
node design/build-icons.mjs            # 產生 + 驗證
node design/build-icons.mjs --verify   # 只驗證現有產出
```

## 檔案

| 檔名 | 原檔名 | 尺寸 | 內容 | 用途 |
| --- | --- | --- | --- | --- |
| **`echo-lockup-square.png`** | `…02_26_01 (4).png` | 1254×1254 | 立方體 mark（上）+ "Echo" wordmark（下），正方畫布 | ⭐ **app icon 的唯一來源**。腳本自動切掉下方 wordmark |
| `echo-lockup-vertical.png` | `…02_26_00 (2).png` | 1122×1402 | 同構圖但 cube 較小，直式畫布 | 直式 lockup 備用 |
| `echo-lockup-horizontal.png` | `…02_26_00 (3).png` | 1672×941 | cube 左、wordmark 右 | 橫式 lockup（簡報頁首、名片、網站 header） |
| `echo-mark-card-mock.png` | `…02_26_00 (1).png` | 1254×1254 | cube 置中在一張**烤進去的白色圓角卡片**上，卡片下方還有烤進去的投影 | ⚠️ 只能當「icon 長怎樣」的示意圖，**不可當素材** |
| `_expo-template-backup/` | — | — | 換掉之前 `app/assets/` 裡的 Expo 範本 icon（上面印著設計參考線） | 保留對照用 |

四張畫的是同一個 mark：等角立方體，頂面是喇叭單體（方形障板 + 同心圓錐盆），
左／正／右三個面切出 `E` `C` `H`。

## 為什麼 app icon 來源選 `echo-lockup-square.png`

不是選那張看起來已經很像 app icon 的 `echo-mark-card-mock.png`。理由由重到輕：

1. **`echo-mark-card-mock.png` 把容器烤進了點陣圖。** 那張白色圓角卡片是 958×959、
   圓角 r≈196.5px 的普通圓弧（superellipse 指數 n≈2.05，r/邊長 = 0.205）。
   iOS 的遮罩是 squircle（r/邊長 ≈ 0.2237），形狀不同 —— 疊起來邊緣會露出灰邊，
   而且會變成圓角套圓角。卡片下方還有一圈 drop shadow（往下延伸到 y≈1212）。
   裁得夠緊確實切得掉這兩樣，但那是「依賴裁切精度」的前提；
   `echo-lockup-square.png` 根本沒有容器，不需要這個前提。
2. **立方體解析度最高。** 719×821，比 card-mock 的 664×745 大 8–10%，
   比橫式的 426×456 大得多。縮到 1024 畫布時是降採樣不是放大。
3. **背景最乾淨。** ink #090909、背景 #FEFEFE、無灰框。
   （`echo-lockup-vertical.png` 四邊各有 1px 灰框（median 226–230），要用得先裁掉外圈 1px。）
4. **一份素材兩用。** cube 與 wordmark 之間有 28 列純背景，腳本靠列掃描自動切開。

## 不要混用四張

四張是同一設計的**四次獨立 render**，不是同一份素材縮放。立方體長寬比分別是
0.8913 / 0.8911 / 0.9342 / 0.8758 —— 彼此差 1.8–7%。
拿橫式的 wordmark 配正方版的 cube 會對不齊。要做新的 lockup 就整張用同一個檔。

## 腳本產出（`app/assets/`）

| 輸出 | 尺寸 | alpha | mark 佔畫布（寬×高） |
| --- | --- | --- | --- |
| `icon.png` | 1024×1024 | **無**（PNG colour type 2） | 68.3% × 78.0% |
| `android-icon-foreground.png` | 1024×1024 | 有 | 54.3% × 62.0% |
| `android-icon-background.png` | 1024×1024 | 無 | 純 #FFFFFF |
| `android-icon-monochrome.png` | 1024×1024 | 有 | 54.3% × 62.0% |
| `favicon.png` | 48×48 | 無 | 68.3% × 78.0% |
| `splash-icon.png` | 1024×1024 | 有 | 40.3% × 46.0% |

`android-icon-foreground.png` 與 `android-icon-monochrome.png` **逐位元組相同**，
這是刻意的：Android 的前景層與 themed 層幾何必須一致，否則使用者切換主題圖示時 mark 會跳動。

腳本每次跑都會把量到的幾何印出來並自我斷言（立方體 bbox、padding 圈是否純背景、
icon.png 四角是否純白）。素材被換過或被重新壓過，會當場失敗而不是默默產出爛檔。

## 已知限制

- **favicon 在 48px 會糊。** 喇叭的同心圓環在 48px 只剩幾個像素，會糊成一團灰。
  立方體輪廓還讀得出來，但細節沒了。要真的清楚就得畫一版簡化 mark（拿掉圓環、
  只留障板與 E/C/H），那是設計決定不是腳本能做的事。
- **`app/app.json` 的 `android.adaptiveIcon.backgroundColor` 仍是範本的 `#E6F4FE`。**
  有 `backgroundImage` 時它會被蓋掉，不影響成品，但兩個值不一致。
- **`app.json` 沒有 `expo-splash-screen` plugin，也沒有 splash 設定區塊** ——
  `splash-icon.png` 目前不被任何設定引用。要用得先補設定。
