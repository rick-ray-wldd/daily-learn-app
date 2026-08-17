/**
 * PodcastBrowser — 搜尋列 + 訂閱節目橫列 + 單集清單（player 分頁上半部）。
 *
 * 單畫面 state 切換（無 modal / navigation）：
 *   搜尋模式（results !== null）原地取代 feed 橫列與單集清單；
 *   訂閱成功 → 清空搜尋、自動選中新 feed。
 * 退訂用卡片右上 ✕ 一鍵完成（captures / episodeIndex 不刪，無資料損失，
 * 故不做確認框——founder-dogfood）。
 */
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { DEMO_EPISODES, Episode } from '../lib/episodes';
import { PodcastSearchResult, searchPodcasts } from '../lib/podcastSearch';
import { fetchAndParseFeed } from '../lib/rss';
import { C as THEME, ELEV, GLASS, LEVEL, LEVEL_UNKNOWN, R, SP, TYPE } from '../lib/theme';
import { estimateLevel, type LevelEstimate } from '../lib/level';
import { getSegments } from '../lib/transcript';
import LevelChip from './LevelChip';
import { t, useLang } from '../lib/i18n';
import {
  addFeed,
  getCaptures,
  getFeed,
  getFeedEpisodes,
  getFeeds,
  removeFeed,
  setFeedEpisodes,
  subscribe,
} from '../lib/store';

/**
 * 單集的難度帶。優先序見 `lib/level.ts`：實聽 > 逐字稿 > 類型。
 *
 * 「實聽分鐘數」用**這一集已經產生 capture 的最遠位置**當代理——我們沒有真正的
 * 收聽時長紀錄（那要另一條 telemetry），但 `max(window_end)` 至少是「他至少聽到
 * 這裡」的下界。低估比高估安全：低估會讓倒帶密度看起來偏高、等級偏難，而把一個
 * 難的材料標成簡單才是真的會害到人。
 */
/**
 * iTunes 的封面 URL 把尺寸寫在路徑裡（`.../100x100bb.jpg`），換掉就拿得到大圖。
 * `podcastSearch` 優先取 `artworkUrl100`，那在 40px 的縮圖時代夠用，但放大到
 * 72px 之後會糊——而封面現在是這個畫面的視覺主角。
 *
 * 比對不到就原樣回傳：Apple 之外的來源（有些 feed 自帶 `itunes:image`）路徑格式
 * 不同，硬改會生出 404。
 */
function hiResArtwork(url: string): string {
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/i, '/600x600bb.$1');
}

function episodeLevel(ep: Episode): LevelEstimate | null {
  const mine = getCaptures().filter((c) => c.episode_id === ep.id);
  const reach = mine.reduce((m, c) => Math.max(m, c.window_end), 0);
  return estimateLevel({
    segments: getSegments(ep.id),
    listened: reach > 0 ? { rewinds: mine.length, minutes: reach / 60 } : undefined,
  });
}

const MAX_WHISPER_BYTES = 25 * 1024 * 1024;
const STALE_MS = 30 * 60 * 1000;

interface Props {
  selectedEpisodeId: string;
  onSelectEpisode: (ep: Episode) => void;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  return `${d.getFullYear()}/${mm}/${dd}`;
}

export default function PodcastBrowser({
  selectedEpisodeId,
  onSelectEpisode,
}: Props) {
  // 訂閱語言：回傳值不用，作用是切換時重繪好讓 t() 重新查表。
  useLang();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PodcastSearchResult[] | null>(null); // null = 非搜尋模式
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [subscribingUrl, setSubscribingUrl] = useState<string | null>(null);
  const [selectedFeedUrl, setSelectedFeedUrl] = useState<string | null>(null); // null = 「{t('browse.default')}」DEMO
  const [refreshing, setRefreshing] = useState(false);
  const [feedNotice, setFeedNotice] = useState<string | null>(null);

  // Re-render on any store change（feeds / feedEpisodes 更新，同 Practice 模式）
  const [, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((v) => v + 1)), []);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = async (term: string) => {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setSearching(true);
    setSearchError(null);
    try {
      const found = await searchPodcasts(term, ctl.signal);
      if (abortRef.current === ctl) setResults(found);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // 被更新的搜尋取消 → 靜默
      } else if (abortRef.current === ctl) {
        setSearchError(t('browse.search_failed'));
      }
    } finally {
      if (abortRef.current === ctl) setSearching(false);
    }
  };

  const onChangeQuery = (text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const term = text.trim();
    if (term.length >= 2) {
      debounceRef.current = setTimeout(() => void runSearch(term), 400);
    } else {
      abortRef.current?.abort();
      abortRef.current = null;
      setResults(null);
      setSearchError(null);
      setSearching(false);
    }
  };

  const onSubmitQuery = () => {
    const term = query.trim();
    if (term.length < 2) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    void runSearch(term);
  };

  const clearSearch = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    abortRef.current = null;
    setQuery('');
    setResults(null);
    setSearchError(null);
    setSearching(false);
  };

  const onSubscribe = async (r: PodcastSearchResult) => {
    setSubscribingUrl(r.feedUrl);
    try {
      const parsed = await fetchAndParseFeed(r.feedUrl);
      const now = new Date().toISOString();
      addFeed(
        {
          feed_url: r.feedUrl,
          title: parsed.title || r.title,
          author: r.author || parsed.author,
          artwork_url: r.artworkUrl ?? parsed.artworkUrl,
          itunes_collection_id: r.collectionId,
          subscribed_at: now,
          last_fetched_at: now,
        },
        parsed.episodes,
      );
      setSelectedFeedUrl(r.feedUrl);
      setQuery('');
      setResults(null);
      setSearchError(null);
    } catch (err) {
      setSearchError(
        t('browse.subscribe_failed', { msg: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      setSubscribingUrl(null);
    }
  };

  const onRemoveFeed = (feedUrl: string) => {
    removeFeed(feedUrl);
    if (selectedFeedUrl === feedUrl) setSelectedFeedUrl(null);
  };

  const refresh = async (feedUrl: string) => {
    setRefreshing(true);
    try {
      const parsed = await fetchAndParseFeed(feedUrl);
      setFeedEpisodes(feedUrl, parsed.episodes);
      setFeedNotice(null);
    } catch {
      setFeedNotice(t('browse.refresh_failed'));
    } finally {
      setRefreshing(false);
    }
  };

  // stale 自動更新：切到某 feed 且 >30 分鐘沒抓過 → 背景 refresh。
  useEffect(() => {
    setFeedNotice(null);
    if (!selectedFeedUrl) return;
    const feed = getFeed(selectedFeedUrl);
    if (!feed) return;
    const last = feed.last_fetched_at ? Date.parse(feed.last_fetched_at) : NaN;
    if (!Number.isFinite(last) || Date.now() - last > STALE_MS) {
      void refresh(selectedFeedUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFeedUrl]);

  const feeds = getFeeds();
  const searchMode = results !== null || searching || searchError !== null;
  const episodes: Episode[] =
    selectedFeedUrl === null ? DEMO_EPISODES : getFeedEpisodes(selectedFeedUrl);

  return (
    <View style={styles.root}>
      {/* 搜尋列 */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={onChangeQuery}
          onSubmitEditing={onSubmitQuery}
          placeholder={t('browse.placeholder')}
          placeholderTextColor={C.dim}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {query.length > 0 && (
          <Pressable onPress={clearSearch} style={styles.clearBtn} hitSlop={8}>
            <Text style={styles.clearBtnText}>✕</Text>
          </Pressable>
        )}
      </View>

      {searchMode ? (
        /* 搜尋模式：原地取代 feed 橫列 + 單集清單 */
        <View style={styles.searchPane}>
          {searching && (
            <View style={styles.searchStatusRow}>
              <ActivityIndicator color={C.accent} size="small" />
              <Text style={styles.dimText}>{t('browse.searching')}</Text>
            </View>
          )}
          {!searching && searchError && (
            <Text style={[styles.dimText, styles.searchStatusPad]}>
              {searchError}
            </Text>
          )}
          {!searching && !searchError && results && results.length === 0 && (
            <Text style={[styles.dimText, styles.searchStatusPad]}>
              {t('browse.no_results')}
            </Text>
          )}
          {!searching && results && results.length > 0 && (
            <FlatList
              style={styles.resultsList}
              data={results}
              keyExtractor={(r) => `${r.collectionId}-${r.feedUrl}`}
              renderItem={({ item }) => {
                const subscribed = Boolean(getFeed(item.feedUrl));
                const lvl = estimateLevel({ genre: item.genre });
                const tint = lvl ? LEVEL[lvl.level] : LEVEL_UNKNOWN;
                return (
                  <View
                    style={[
                      styles.resultRow,
                      { backgroundColor: tint.fill, borderColor: tint.edge },
                    ]}
                  >
                    {item.artworkUrl ? (
                      <Image
                        source={{ uri: hiResArtwork(item.artworkUrl) }}
                        style={styles.artwork}
                      />
                    ) : (
                      <View style={[styles.artwork, styles.artworkFallback]} />
                    )}
                    <View style={styles.resultMid}>
                      <Text style={styles.resultTitle} numberOfLines={2}>
                        {item.title}
                      </Text>
                      <Text style={styles.resultSub} numberOfLines={1}>
                        {item.author}
                        {item.episodeCount ? t('browse.n_episodes', { n: item.episodeCount }) : ''}
                      </Text>
                      <View style={styles.resultChipRow}>
                        <LevelChip estimate={lvl} />
                      </View>
                    </View>
                    {subscribed ? (
                      <View style={[styles.subBtn, styles.subBtnDone]}>
                        <Text style={styles.subBtnDoneText}>{t('browse.subscribed')}</Text>
                      </View>
                    ) : subscribingUrl === item.feedUrl ? (
                      <View style={styles.subBtn}>
                        <ActivityIndicator color={C.accent} size="small" />
                      </View>
                    ) : (
                      <Pressable
                        onPress={() => void onSubscribe(item)}
                        style={({ pressed }) => [
                          styles.subBtn,
                          styles.subBtnActive,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={styles.subBtnText}>{t('browse.subscribe')}</Text>
                      </Pressable>
                    )}
                  </View>
                );
              }}
            />
          )}
        </View>
      ) : (
        <>
          {/* 訂閱節目橫列 */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.feedRow}
            contentContainerStyle={styles.feedRowContent}
          >
            <Pressable
              onPress={() => setSelectedFeedUrl(null)}
              style={[
                styles.feedCard,
                selectedFeedUrl === null && styles.feedCardSelected,
              ]}
            >
              <Text style={styles.feedCardSub} numberOfLines={1}>
                {t('browse.builtin_demo')}
              </Text>
              <Text
                style={[
                  styles.feedCardTitle,
                  selectedFeedUrl === null && styles.feedCardTitleSelected,
                ]}
                numberOfLines={2}
              >
                {t('browse.default')}
              </Text>
            </Pressable>
            {feeds.map((feed) => {
              const selected = selectedFeedUrl === feed.feed_url;
              return (
                <Pressable
                  key={feed.feed_url}
                  onPress={() => setSelectedFeedUrl(feed.feed_url)}
                  style={[styles.feedCard, selected && styles.feedCardSelected]}
                >
                  {/* 封面本來就存在 `Feed.artwork_url`，只是先前沒被畫出來——
                      整排純文字卡是這個畫面最不吸引人的地方。 */}
                  {feed.artwork_url ? (
                    <Image
                      source={{ uri: hiResArtwork(feed.artwork_url) }}
                      style={styles.feedArt}
                    />
                  ) : (
                    <View style={[styles.feedArt, styles.artworkFallback]} />
                  )}
                  <Text
                    style={[
                      styles.feedCardTitle,
                      selected && styles.feedCardTitleSelected,
                    ]}
                    numberOfLines={2}
                  >
                    {feed.title}
                  </Text>
                  <Pressable
                    onPress={() => onRemoveFeed(feed.feed_url)}
                    style={styles.feedRemove}
                    hitSlop={8}
                  >
                    <Text style={styles.feedRemoveText}>✕</Text>
                  </Pressable>
                </Pressable>
              );
            })}
          </ScrollView>

          {/* 單集清單 */}
          {feedNotice && <Text style={styles.noticeText}>{feedNotice}</Text>}
          <FlatList
            style={styles.episodeList}
            data={episodes}
            keyExtractor={(ep) => ep.id}
            refreshControl={
              selectedFeedUrl ? (
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => void refresh(selectedFeedUrl)}
                  tintColor={C.dim}
                />
              ) : undefined
            }
            ListEmptyComponent={
              selectedFeedUrl ? (
                <Text style={styles.dimText}>{t('browse.no_playable')}</Text>
              ) : null
            }
            renderItem={({ item }) => {
              const selected = item.id === selectedEpisodeId;
              const metaParts: string[] = [];
              if (item.pubDate) {
                const d = formatDate(item.pubDate);
                if (d) metaParts.push(d);
              }
              if (item.durationSec > 0) {
                metaParts.push(formatDuration(item.durationSec));
              }
              const tooLong =
                !item.transcriptUrl &&
                typeof item.enclosureBytes === 'number' &&
                item.enclosureBytes > MAX_WHISPER_BYTES;
              const lvl = episodeLevel(item);
              const tint = lvl ? LEVEL[lvl.level] : LEVEL_UNKNOWN;
              return (
                <Pressable
                  onPress={() => onSelectEpisode(item)}
                  style={[
                    styles.episodeItem,
                    { backgroundColor: tint.fill, borderColor: tint.edge },
                    selected && styles.episodeItemSelected,
                  ]}
                >
                  {item.artworkUrl ? (
                    <Image
                      source={{ uri: hiResArtwork(item.artworkUrl) }}
                      style={styles.episodeArt}
                    />
                  ) : (
                    <View style={[styles.episodeArt, styles.artworkFallback]} />
                  )}
                  <View style={styles.episodeMid}>
                  <Text
                    style={[
                      styles.episodeItemTitle,
                      selected && styles.episodeItemTitleSelected,
                    ]}
                    numberOfLines={2}
                  >
                    {item.title}
                  </Text>
                  {metaParts.length > 0 && (
                    <Text style={styles.episodeMeta}>
                      {metaParts.join(' · ')}
                    </Text>
                  )}
                  <View style={styles.chipRow}>
                    <LevelChip estimate={lvl} />
                    {item.transcriptUrl && (
                      <View style={styles.chipTranscript}>
                        <Text style={styles.chipText}>{t('browse.transcript_chip')}</Text>
                      </View>
                    )}
                    {tooLong && (
                      <View style={styles.chipTooLong}>
                        <Text style={styles.chipDimText}>
                          {t('browse.too_long')}
                        </Text>
                      </View>
                    )}
                  </View>
                  </View>
                </Pressable>
              );
            }}
          />
        </>
      )}
    </View>
  );
}

/**
 * 色票以 `lib/theme.ts` 為準。
 *
 * 這裡本來自己抄了一份色碼，於是同一個 app 有兩套設計系統——而且已經開始漂移：
 * theme.ts 早就把 `dim` 從 #8A97A8 調亮成 #9FACBC（為了跟 `faint` 拉開距離），
 * 這份副本沒跟上，所以探索頁的次要文字比其他畫面暗一階。
 *
 * 只留三個 theme 沒有的語意色（此元件專屬），其餘一律取用共用 token。
 */
const C = {
  ...THEME,
  /** = THEME.surface，保留舊名避免這支檔案全面改名。 */
  card: THEME.surface,
  cardSelected: THEME.surfaceAlt,
  /** 選中節目的底色（accent 的深色版）。 */
  accentDark: '#14532D',
  /** 取消訂閱等破壞性操作。 */
  danger: '#EF4444',
};

const styles = StyleSheet.create({
  // 探索現在是一個完整的分頁，不再是播放器裡的一塊，所以兩個清單都吃滿剩餘高度
  // （以前是寫死的 maxHeight 320 / 232，那是為了塞進播放器才有的限制）。
  root: { flex: 1 },
  searchPane: { flex: 1 },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    color: C.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  clearBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearBtnText: { color: C.dim, fontSize: 14, fontWeight: '700' },

  searchStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  searchStatusPad: { marginTop: 12 },
  dimText: { color: C.dim, fontSize: 13, lineHeight: 20 },
  noticeText: { color: C.dim, fontSize: 11, marginTop: 6 },

  resultsList: { flex: 1, marginTop: 10 },
  // 底色與外框改由等級 tint 就地指定（inline），這裡只留版面。
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: R.lg,
    borderWidth: 1,
    padding: SP(2.5),
    marginBottom: SP(2),
    gap: SP(3),
    ...ELEV.card,
  },
  /** 72 而不是 40：封面是這個畫面的主角，縮圖尺寸讓它變成裝飾。 */
  artwork: { width: 72, height: 72, borderRadius: R.md },
  artworkFallback: { backgroundColor: GLASS.fill },
  resultMid: { flex: 1, gap: 2 },
  resultTitle: { ...TYPE.heading, fontSize: 15, color: C.text },
  resultSub: { ...TYPE.caption, color: C.dim, fontWeight: '400' },
  resultChipRow: { marginTop: SP(1) },
  subBtn: {
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  subBtnActive: { backgroundColor: C.accent },
  subBtnText: { color: '#06220F', fontSize: 13, fontWeight: '800' },
  subBtnDone: {
    backgroundColor: C.cardSelected,
    borderWidth: 1,
    borderColor: C.border,
  },
  subBtnDoneText: { color: C.dim, fontSize: 13, fontWeight: '700' },

  feedRow: { marginTop: 12, flexGrow: 0 },
  feedRowContent: { gap: 10 },
  feedCard: {
    width: 116,
    backgroundColor: GLASS.fill,
    borderRadius: R.lg,
    padding: SP(2),
    borderWidth: 1,
    borderColor: GLASS.edge,
    ...ELEV.card,
  },
  feedCardSelected: { backgroundColor: GLASS.fillStrong, borderColor: C.primary },
  /** 100×100 的方形封面，圓角比卡片小一階（卡片 lg、圖 md），內縮才不會頂邊。 */
  feedArt: { width: 100, height: 100, borderRadius: R.md, marginBottom: SP(2) },
  feedCardSub: { color: C.dim, fontSize: 11, marginBottom: 4 },
  feedCardTitle: { color: C.dim, fontSize: 12, fontWeight: '600' },
  feedCardTitleSelected: { color: C.text },
  feedRemove: { position: 'absolute', top: 4, right: 6 },
  feedRemoveText: { color: C.dim, fontSize: 12, fontWeight: '700' },

  episodeList: { flex: 1, marginTop: 10 },
  episodeItem: {
    flexDirection: 'row',
    gap: SP(3),
    borderRadius: R.lg,
    borderWidth: 1,
    marginBottom: SP(2),
    padding: SP(2.5),
    ...ELEV.card,
  },
  /** 選中時邊框改成藍（中性 chrome＝「你在這裡」），底色蓋掉等級 tint。 */
  episodeItemSelected: {
    backgroundColor: GLASS.fillStrong,
    borderColor: C.primary,
  },
  episodeArt: { width: 56, height: 56, borderRadius: R.sm },
  episodeMid: { flex: 1 },
  episodeItemTitle: { color: C.dim, fontSize: 13, fontWeight: '600' },
  episodeItemTitleSelected: { color: C.text },
  episodeMeta: {
    color: C.dim,
    fontSize: 11,
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  chipRow: { flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' },
  chipTranscript: {
    backgroundColor: C.accentDark,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chipTooLong: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chipText: { color: C.text, fontSize: 10, fontWeight: '700' },
  chipDimText: { color: C.dim, fontSize: 10, fontWeight: '600' },

  pressed: { opacity: 0.7, transform: [{ scale: 0.97 }] },
});
