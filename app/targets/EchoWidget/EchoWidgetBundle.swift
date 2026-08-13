//
//  EchoWidgetBundle.swift
//  EchoWidget —— **只編進 extension target**
//
//  Extension 的進入點。這個檔應該永遠只有這幾行。
//
//  **不要**在這裡加主畫面 widget、不要加 Control、不要加第二個 widget。
//  每多一個 widget 就多一份要在真機上驗證的東西，而本輪唯一要證明的假設是
//  「鎖定畫面上的按鈕能不能不進前景就把答案記下來」。其他都是雜訊。
//

import SwiftUI
import WidgetKit

@main
struct EchoWidgetBundle: WidgetBundle {
    var body: some Widget {
        EchoReviewLiveActivity()
    }
}
