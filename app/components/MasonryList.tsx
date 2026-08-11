/**
 * MasonryList — 高度不一、下緣不齊的多欄清單。
 *
 * 為什麼要自己寫，而不是用 FlatList 或第三方套件：
 *
 *   `FlatList numColumns` 會把同一列的卡片**拉成等高**，而「下緣不齊」正是這個
 *   清單存在的理由——那條參差的邊界就是「還有更多」的視覺暗示，一對齊就變成
 *   一張規規矩矩的表格，往下捲的動機當場消失。
 *   第三方 masonry（含 FlashList）是原生模組，裝下去使用者就得重新 build，
 *   而這六天只能靠 OTA 迭代。
 *
 * 所以底層是 `ScrollView` + 自己算的欄高平衡：item 依序丟進**目前累積高度最矮**
 * 的那一欄（shortest-column-first）。這個貪心法只需要一次線性掃描，且對同一批
 * 資料永遠得到同一個結果——使用者是靠形狀在清單裡認卡片的，重排會讓他迷路。
 *
 * 代價是**沒有虛擬化**：所有卡片都掛載著。這是刻意的取捨——呼叫端用分頁
 * （每次 +10）控制總量，而卡片本身只有封面 + 兩行字，幾十張的成本遠低於
 * 為了虛擬化而引入原生依賴。真的長到上百張時，該做的是收斂分頁上限。
 *
 * 這支檔案是**泛型**的，不認得 Episode，也只從 theme 取一個預設間距。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type RefreshControlProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { SP } from '../lib/theme';

export interface MasonryRenderInfo<T> {
  item: T;
  index: number;
  /** 這一欄的實際寬度（已扣掉欄距），卡片內容照它排版。 */
  width: number;
  /** itemHeight 回傳的高度，卡片必須確實長這麼高，否則欄底會對不齊。 */
  height: number;
}

export interface MasonryListProps<T> {
  data: readonly T[];
  keyExtractor: (item: T, index: number) => string;
  /**
   * 這張卡要多高。**必須是純函式且對同一個 item 永遠回同一個值**——
   * 高度是分欄演算法的輸入，值一變欄位分配就會整個重排、卡片在畫面上亂跳。
   */
  itemHeight: (item: T, columnWidth: number, index: number) => number;
  renderItem: (info: MasonryRenderInfo<T>) => ReactElement | null;
  /** 欄數，預設 2。 */
  columns?: number;
  /** 欄距與列距，預設 SP(3)。 */
  gap?: number;
  /** 捲到離底部這麼近（px）就觸發 onEndReached，預設 400。 */
  onEndReachedThreshold?: number;
  /** 同一批內容只會觸發一次；內容長高之後才會再次可觸發。 */
  onEndReached?: () => void;
  ListHeaderComponent?: ReactElement | null;
  ListFooterComponent?: ReactElement | null;
  ListEmptyComponent?: ReactElement | null;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  /**
   * 型別寫成 `ReactElement<RefreshControlProps>` 而不是裸的 `ReactElement`：
   * React 19 的 `ReactElement` 預設 props 是 `unknown`（以前是 `any`），直接往
   * ScrollView 塞會編不過。實務上唯一會傳進來的就是 `<RefreshControl />`。
   */
  refreshControl?: ReactElement<RefreshControlProps>;
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  scrollEventThrottle?: number;
  showsVerticalScrollIndicator?: boolean;
  testID?: string;
}

/** 一張已經分配好欄位的卡片。`index` 保留原始順序，keyExtractor / renderItem 都要它。 */
interface Placed<T> {
  item: T;
  index: number;
  height: number;
}

/**
 * Shortest-column-first 分欄。
 *
 * 累加的是 `height + gap` 而不是 `height`：欄內每張卡下面都會多一個列距，
 * 少算它會讓短卡多的那一欄被高估為「還很矮」，越塞越歪。
 */
function pack<T>(
  data: readonly T[],
  columnWidth: number,
  columns: number,
  gap: number,
  measure: (item: T, columnWidth: number, index: number) => number,
): Placed<T>[][] {
  const cols: Placed<T>[][] = [];
  const heights: number[] = [];
  for (let c = 0; c < columns; c += 1) {
    cols.push([]);
    heights.push(0);
  }

  for (let i = 0; i < data.length; i += 1) {
    // 嚴格小於 → 平手時取最左欄，所以第一張永遠落在第一欄，順序穩定可預測。
    let target = 0;
    for (let c = 1; c < columns; c += 1) {
      if (heights[c] < heights[target]) target = c;
    }
    // 取整：高度同時是 style 的 height 與演算法的輸入，兩邊用同一個值才不會
    // 累積出半像素的誤差。負數／NaN 一律夾成 0，一張壞卡不該把整個版面拉爛。
    const raw = measure(data[i], columnWidth, i);
    const height = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
    cols[target].push({ item: data[i], index: i, height });
    heights[target] += height + gap;
  }

  return cols;
}

export default function MasonryList<T>(props: MasonryListProps<T>): ReactElement {
  const {
    data,
    keyExtractor,
    itemHeight,
    renderItem,
    columns: columnsProp = 2,
    gap: gapProp = SP(3),
    onEndReachedThreshold = 400,
    onEndReached,
    ListHeaderComponent,
    ListFooterComponent,
    ListEmptyComponent,
    style,
    contentContainerStyle,
    refreshControl,
    onScroll,
    scrollEventThrottle = 16,
    showsVerticalScrollIndicator = false,
    testID,
  } = props;

  const columns = Math.max(1, Math.floor(columnsProp));
  const gap = Math.max(0, gapProp);

  const [width, setWidth] = useState(0);

  /**
   * itemHeight 刻意**不進 useMemo 的 dep**：呼叫端幾乎一定寫成 inline 箭頭函式，
   * 每次 render 都是新 identity，放進 dep 等於每一幀都重排全部卡片。規格已經要求
   * 它是純函式（同一個 item 恆定回同一個高度），所以用 ref 取最新的一份就夠了。
   */
  const measureRef = useRef(itemHeight);
  measureRef.current = itemHeight;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    // 次像素抖動（旋轉、鍵盤、捲動條）也會送 onLayout；差不到半個像素就當沒變，
    // 否則每次抖動都會重跑 pack 並讓所有卡片重畫。
    setWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
  }, []);

  const columnWidth = width > 0 ? (width - gap * (columns - 1)) / columns : 0;
  const ready = columnWidth > 0;

  const packed = useMemo(
    () => (ready ? pack(data, columnWidth, columns, gap, measureRef.current) : []),
    [data, columnWidth, columns, gap, ready],
  );

  /**
   * onEndReached 去重：記住**上次觸發時的內容總高**，只有內容真的長高了才允許
   * 再觸發一次。用 boolean flag 的話，第一次觸發後即使又載進 10 張卡也永遠不會
   * 再觸發；而不去重的話，在底部輕輕晃一下就會一口氣翻好幾頁。
   */
  const lastEndHeightRef = useRef(0);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      onScroll?.(e);
      if (!onEndReached) return;
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
      if (distance <= onEndReachedThreshold && contentSize.height > lastEndHeightRef.current) {
        lastEndHeightRef.current = contentSize.height;
        onEndReached();
      }
    },
    [onScroll, onEndReached, onEndReachedThreshold],
  );

  return (
    <ScrollView
      testID={testID}
      style={style}
      contentContainerStyle={contentContainerStyle}
      refreshControl={refreshControl}
      onScroll={handleScroll}
      scrollEventThrottle={scrollEventThrottle}
      showsVerticalScrollIndicator={showsVerticalScrollIndicator}
      // removeClippedSubviews 一律不開：iOS 上它會讓絕對定位的子層（bloom、sheen）
      // 在捲出畫面再捲回來之後消失，而每張玻璃卡都靠那兩層才不是灰卡片。
      removeClippedSubviews={false}
    >
      {ListHeaderComponent}

      {/*
        量寬度的是**這一層**而不是 ScrollView 本身：contentContainerStyle 若帶了
        左右內距，ScrollView 的寬度會比卡片真正能用的寬度大，欄寬就會算爆一點點。
        這個 View 在 content container 裡，量到的就是卡片實際可用的寬。
      */}
      <View onLayout={onLayout}>
        {/*
          第一幀 width 還是 0。此時**一張卡都不 render**——用 0 寬去問 itemHeight
          會得到一批錯的高度，卡片先以錯的形狀掛載再全部重排，畫面會明顯抖一下。
        */}
        {ready && data.length === 0 ? ListEmptyComponent : null}

        {ready && data.length > 0 ? (
          <View style={[styles.row, { gap }]}>
            {packed.map((col, colIndex) => (
              <View key={colIndex} style={[styles.column, { gap }]}>
                {col.map((p) => (
                  // 外面這層 View 把高度釘死：卡片內容再怎麼長，欄高平衡算出來的
                  // 版面才是對的，否則實際高度一偏離，下面所有卡片就跟著錯位。
                  <View key={keyExtractor(p.item, p.index)} style={{ height: p.height }}>
                    {renderItem({
                      item: p.item,
                      index: p.index,
                      width: columnWidth,
                      height: p.height,
                    })}
                  </View>
                ))}
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {ready ? ListFooterComponent : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  // flex: 1 讓每一欄平分扣掉 gap 之後的寬度，與 columnWidth 的算式是同一件事，
  // 由 yoga 自己算比在 JS 裡寫死寬度更耐得住旋轉與字級變化。
  column: { flex: 1 },
});
