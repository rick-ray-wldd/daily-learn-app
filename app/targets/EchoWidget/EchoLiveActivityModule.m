//
//  EchoLiveActivityModule.m
//  Echo —— **只編進主 app target，不進 extension**
//
//  `EchoLiveActivityModule.swift` 的註冊墊片。
//
//  為什麼需要這一支：`RCT_EXTERN_MODULE` / `RCT_EXTERN_METHOD` 是 Objective-C 巨集，
//  Swift 裡沒有對應物。純 Swift 的替代路徑（自行 conform `RCTBridgeModule` 再從
//  `RCTBridgeDelegate.extraModules` 塞進去）要動 AppDelegate，而 AppDelegate 是
//  `expo prebuild` 的產出物——在上面手改的東西下一次 prebuild 就會被洗掉
//  （ADR-0021 ①：`ios/` 是輸出不是輸入）。所以留這支 10 行的 .m 最穩。
//
//  ⚠️ 方法簽章必須與 Swift 的 `@objc(...)` selector **逐字對齊**，包含每一個
//  參數標籤。對不齊不會有編譯錯誤——JS 呼叫時才會拿到
//  「is not a function」，而且看起來像是模組整個沒載入。
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE (EchoLiveActivity, NSObject)

RCT_EXTERN_METHOD(areActivitiesEnabled
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(start
                  : (NSDictionary *)payload resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(update
                  : (NSString *)activityId payload
                  : (NSDictionary *)payload resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(end
                  : (NSString *)activityId payload
                  : (NSDictionary *)payload resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(listActivityIds
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(listAnswers
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(deleteAnswers
                  : (NSArray *)answerIds resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(readCursor
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

@end
