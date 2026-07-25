/**
 * iTunes Search API — podcast 搜尋（免 API key）。
 * https://itunes.apple.com/search?media=podcast&term=…
 *
 * 注意：部分結果可能缺 feedUrl（已下架/受限節目）→ 直接過濾掉。
 */
export interface PodcastSearchResult {
  collectionId: number;
  title: string; // collectionName
  author: string; // artistName
  feedUrl: string;
  artworkUrl?: string; // artworkUrl100 ?? artworkUrl600
  episodeCount?: number; // trackCount
  genre?: string; // primaryGenreName
}

const SEARCH_URL = 'https://itunes.apple.com/search';

/** 丟出 Error（含 AbortError，由呼叫端辨識忽略）。 */
export async function searchPodcasts(
  term: string,
  signal?: AbortSignal,
): Promise<PodcastSearchResult[]> {
  const url = `${SEARCH_URL}?media=podcast&limit=12&term=${encodeURIComponent(term)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`iTunes 回應 ${res.status}`);
  const json = (await res.json()) as {
    results?: Array<Record<string, unknown>>;
  };
  return (json.results ?? [])
    .filter((r) => typeof r.feedUrl === 'string' && r.feedUrl.length > 0)
    .map((r) => ({
      collectionId: typeof r.collectionId === 'number' ? r.collectionId : 0,
      title: typeof r.collectionName === 'string' ? r.collectionName : '(未命名節目)',
      author: typeof r.artistName === 'string' ? r.artistName : '',
      feedUrl: r.feedUrl as string,
      artworkUrl:
        (typeof r.artworkUrl100 === 'string' ? r.artworkUrl100 : undefined) ??
        (typeof r.artworkUrl600 === 'string' ? r.artworkUrl600 : undefined),
      episodeCount: typeof r.trackCount === 'number' ? r.trackCount : undefined,
      genre: typeof r.primaryGenreName === 'string' ? r.primaryGenreName : undefined,
    }));
}
