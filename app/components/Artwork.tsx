/**
 * 單集封面。有圖用圖，沒有就畫一張**認得出來**的替代圖。
 *
 * 替代圖的色相由 episode.id 推出，所以同一集永遠長同一個樣子——使用者是靠圖在
 * 清單裡認集數的，全部畫成同一塊灰底方塊等於沒有封面。
 *
 * 從 App.tsx 抽出來：mini player、Now Playing、探索清單三處都要用同一張圖，
 * 三份實作遲早會走鐘。
 */
import { Image, StyleSheet, Text, View } from 'react-native';

import { Episode } from '../lib/episodes';
import { C, R } from '../lib/theme';

/** 小於這個邊長的封面已經不是封面、只是裝飾。呼叫端據此決定要不要畫大圖。 */
export const ART_MIN_SIZE = 140;

function hueFrom(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

interface Props {
  episode: Episode;
  size: number;
  /** 大圖才投影；縮圖投影只會讓清單看起來髒。 */
  shadow?: boolean;
  radius?: number;
}

export default function Artwork({ episode, size, shadow, radius }: Props) {
  const r = radius ?? (size >= ART_MIN_SIZE ? R.xl : R.md);
  const hue = hueFrom(episode.id);
  const initial = episode.podcast.trim().charAt(0).toUpperCase() || '♪';

  return (
    // 陰影畫在外層、裁切在內層：同一個 View 既 overflow:hidden 又要投影，
    // 陰影會被自己的裁切一起剪掉。
    <View
      style={[
        { width: size, height: size, borderRadius: r, backgroundColor: C.surface },
        shadow && styles.shadow,
      ]}
    >
      <View style={[styles.clip, { borderRadius: r }]}>
        {episode.artworkUrl ? (
          <Image source={{ uri: episode.artworkUrl }} style={styles.fill} />
        ) : (
          <View
            style={[
              styles.fill,
              styles.placeholder,
              { backgroundColor: `hsl(${hue}, 38%, 26%)` },
            ]}
          >
            {/* 專案沒有 gradient 套件，用一塊旋轉的實色頂替斜切的第二色。 */}
            <View
              style={[
                styles.wedge,
                {
                  backgroundColor: `hsl(${(hue + 42) % 360}, 44%, 17%)`,
                  width: size * 1.8,
                  height: size * 1.8,
                  left: -size * 0.4,
                  top: size * 0.52,
                },
              ]}
            />
            <Text style={[styles.initial, { fontSize: size * 0.34 }]}>{initial}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: {
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 10,
  },
  clip: { flex: 1, overflow: 'hidden' },
  fill: { width: '100%', height: '100%' },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  wedge: { position: 'absolute', transform: [{ rotate: '-24deg' }] },
  initial: { color: C.text, fontWeight: '800', opacity: 0.92 },
});
