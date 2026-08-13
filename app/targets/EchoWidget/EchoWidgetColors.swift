//
//  EchoWidgetColors.swift
//  EchoWidget —— **只編進 extension target**
//
//  ⚠️ 檔名說明：任務簡報寫的是 `Theme.swift`，但藍圖規格 §2 與 §5.3（config plugin
//  要加進 Sources build phase 的檔名清單）寫死的是 `EchoWidgetColors.swift`。
//  改名會讓代理 E 的 plugin 找不到這個檔、整個 extension 少一份原始碼，所以這裡
//  以規格為準。內容則照簡報要求，把色票 **與**材質／圓角／間距一起集中在這一個檔。
//
//  ── 這是 lib/theme.ts 的**手抄副本**。lib/theme.ts 是唯一真相，改色要兩邊一起改。──
//
//  為什麼要重複：widget extension 是純 Swift 世界，讀不到 JS，也不可能在 build 時
//  把 theme.ts 轉進來（那要多一個 build step，而這個 repo 刻意維持零 build step）。
//  所以這份重複是**刻意接受的**，代價是「改了 theme.ts 卻忘了改這裡」——防線只有
//  這段註解和 code review。
//
//  theme.ts 的那條鐵律在這裡一樣有效，**沒有例外**：
//
//    綠（accent）    = 「學習者動手了」——答對、選項按鈕、signal。
//    琥珀（highlight）= 「app 在猜／app 的判定」——答錯時揭曉的正解。
//    藍（primary）   = 中性 chrome，不代表任何語意。
//
//  **不准出現紅色。** 這個色盤沒有「錯誤」這個語意：答錯不是錯誤，是訊號。
//  一旦答錯被畫成紅色，使用者就會開始躲著答題，而躲著答題的人不會產生訊號。
//
//  另一條從 theme.ts 帶過來的規則：`faint` 禁止出現在玻璃面板上（它的 5.1:1 是對
//  不透明底色實算的，玻璃底下是變數）。所以「想不起來」那顆按鈕**不是玻璃**，是
//  只有 hairline 外框的空心按鈕——見 EchoReviewLiveActivity 的 escape hatch。
//

import SwiftUI

enum EchoTheme {

    // MARK: - 語意色（對應 theme.ts 的 C）

    /// 頁面底色。深藍黑，不是純黑——純黑在 OLED 上會讓卡片邊界消失。
    static let bg = Color(echoHex: 0x0C1117)
    /// 抬起的卡片。
    static let surface = Color(echoHex: 0x161D26)
    /// 卡片上的卡片。
    static let surfaceAlt = Color(echoHex: 0x1E2A38)
    /// Hairline only（lineWidth 1），不要拿它當填色。
    static let border = Color(echoHex: 0x243244)

    /// 主文字。16.1:1 on bg。
    static let text = Color(echoHex: 0xE8EDF4)
    /// 次要文字：header、metadata。8.2:1 on bg。
    static let dim = Color(echoHex: 0x9FACBC)
    /// 最弱的一階。5.1:1 on bg（AA）。**只准用在不透明底色上**。
    static let faint = Color(echoHex: 0x7A8698)

    /// 綠 = 學習者動手了。
    static let accent = Color(echoHex: 0x4ADE80)
    /// 壓在 accent 上的深墨色。9.7:1 on accent。
    static let accentInk = Color(echoHex: 0x06220F)
    /// 藍 = 中性 chrome。不帶語意。
    static let primary = Color(echoHex: 0x3B82F6)

    /// 琥珀的**行內底色**（半透明，理由見 theme.ts：同一塊標記會落在不同底色上）。
    static let highlight = Color(echoHex: 0xF59E0B, opacity: 0.22)
    /// 琥珀的字色。7.6:1（highlight over bg）。
    static let highlightInk = Color(echoHex: 0xFBBF24)

    /// 綠色的半透明表面。語意與 accent 同一件事，只是當底色用。
    static let accentSurface = Color(echoHex: 0x4ADE80, opacity: 0.18)

    // MARK: - 玻璃材質（對應 theme.ts 的 GLASS）
    //
    // 三層疊出來：底填 + 上緣 1px 高光 + hairline 外框。
    // **上緣那條高光才是玻璃感的來源**，拿掉之後剩下的只是一張半透明灰卡片。
    // 這裡沒有背景模糊，也不需要——底色是純色，模糊純色等於沒模糊。

    /// 面板底。
    static let glassFill = Color.white.opacity(0.055)
    /// 需要再抬高一階時。
    static let glassFillStrong = Color.white.opacity(0.085)
    /// 外框 hairline。**與 border 不得並存於同一個 View**：不透明 hairline 疊在
    /// 半透明填色上，邊緣會多出一圈比面板還實的線，玻璃感當場消失。
    static let glassEdge = Color.white.opacity(0.08)
    /// 上緣 1px 高光。不准省略。
    static let glassSheen = Color.white.opacity(0.14)

    // MARK: - 圓角（對應 theme.ts 的 R）

    static let radiusSm: CGFloat = 8
    static let radiusMd: CGFloat = 12
    static let radiusLg: CGFloat = 16

    // MARK: - 間距（對應 theme.ts 的 SP：4pt scale）

    /// `sp(3)` → 12。所有 padding / spacing 走這個，不寫裸數字。
    static func sp(_ n: CGFloat) -> CGFloat { n * 4 }

    // MARK: - 字級（對應 theme.ts 的 TYPE）

    /// 對應 TYPE.caption（12 / 600）：header、狀態列、按鈕副標。
    static let captionFont = Font.system(size: 12, weight: .semibold)
    /// 對應 TYPE.mono：等寬「數字」，"3/5" → "4/5" 換位時寬度不變、不會抖。
    static let counterFont = Font.system(size: 12, weight: .semibold).monospacedDigit()
    /// 題面。字級沿用 TYPE.body 的 16，但字重從 400 提到 .semibold——
    /// 鎖定畫面是「一瞥」的場景，題目必須先被看到；body 的 400 是為了長段逐字稿
    /// 的閱讀舒適度，這裡沒有長段。
    static let promptFont = Font.system(size: 16, weight: .semibold)
    /// 選項按鈕上的中文。比 caption 大一階，因為它是唯一要被「按」的字。
    static let optionFont = Font.system(size: 13, weight: .semibold)
}

extension Color {
    /// 讓色票能用與 lib/theme.ts 完全相同的十六進位寫法留在原始碼裡——
    /// 兩個檔可以直接用眼睛 diff，這是防止手抄副本漂移的唯一便宜手段。
    init(echoHex hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}
