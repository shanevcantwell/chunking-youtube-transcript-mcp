import { getSubtitles, AdChapter, CaptionTrack, VideoMetadata, SubtitleResult } from './youtube-fetcher.js';

export interface TranscriptLine {
  text: string;
  start: number;
  dur: number;
}

export interface CachedTranscript {
  cacheId: string;
  videoId: string;
  language: string;
  fetchedAt: number;
  lines: TranscriptLine[];
  metadata: VideoMetadata;
  adChapters: AdChapter[];
  availableLanguages: CaptionTrack[];
  actualLang: string;
  requestedLang: string;
  sizeBytes: number;
}

export interface CacheInfo {
  cacheId: string;
  videoId: string;
  language: string;
  totalDurationSeconds: number;
  totalLines: number;
  totalCharacters: number;
  metadata: VideoMetadata;
}

export interface ChunkResult {
  lines: TranscriptLine[];
  hasMore: boolean;
  totalLines: number;
  chunkLines: number;
  startSeconds: number;
  endSeconds: number;
}

export class TranscriptCache {
  private cache = new Map<string, CachedTranscript>();
  private inFlightRequests = new Map<string, Promise<CachedTranscript>>();
  private readonly ttlMs: number;
  private readonly maxTotalSizeBytes: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { ttlMs?: number; maxTotalSizeBytes?: number }) {
    this.ttlMs = options?.ttlMs ?? 3600000; // 1 hour default
    this.maxTotalSizeBytes = options?.maxTotalSizeBytes ?? 50 * 1024 * 1024; // 50MB default

    // Run cleanup every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 300000);
    // Don't let the timer prevent process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Build a deterministic cache key from video ID and language.
   * Same video + language always maps to the same cache entry,
   * so parallel workers automatically share cached data.
   */
  private cacheKey(videoId: string, lang: string): string {
    return `${videoId}:${lang}`;
  }

  /**
   * Ensure a transcript is cached. Handles three scenarios:
   * 1. Already cached and fresh → return immediately
   * 2. Another request for same video in-flight → wait for it (deduplication)
   * 3. Not cached → fetch, cache, return
   */
  async ensureCached(videoId: string, lang: string): Promise<CachedTranscript> {
    const key = this.cacheKey(videoId, lang);

    // Check cache first
    const existing = this.cache.get(key);
    if (existing && (Date.now() - existing.fetchedAt) < this.ttlMs) {
      return existing;
    }

    // Check for in-flight request (deduplication for parallel calls)
    const inFlight = this.inFlightRequests.get(key);
    if (inFlight) {
      return inFlight;
    }

    // Start new fetch
    const fetchPromise = this.fetchAndCache(videoId, lang, key);
    this.inFlightRequests.set(key, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.inFlightRequests.delete(key);
    }
  }

  private async fetchAndCache(videoId: string, lang: string, key: string): Promise<CachedTranscript> {
    const result: SubtitleResult = await getSubtitles({
      videoID: videoId,
      lang,
      enableFallback: true,
    });

    // Estimate size: ~2 bytes per character + object overhead
    const sizeBytes = result.lines.reduce((sum, l) => sum + l.text.length * 2 + 24, 0);

    // Evict oldest entries if we'd exceed the size limit
    this.evictIfNeeded(sizeBytes);

    const entry: CachedTranscript = {
      cacheId: key,
      videoId,
      language: result.actualLang,
      fetchedAt: Date.now(),
      lines: result.lines,
      metadata: result.metadata,
      adChapters: result.adChapters,
      availableLanguages: result.availableLanguages,
      actualLang: result.actualLang,
      requestedLang: result.requestedLang,
      sizeBytes,
    };

    this.cache.set(key, entry);
    console.error(`[transcript-cache] Cached ${videoId}:${lang} (${result.lines.length} lines, ${sizeBytes} bytes)`);
    return entry;
  }

  /**
   * Get a chunk of transcript by time range.
   * Returns only lines whose start time falls within [startSeconds, endSeconds).
   * Optional context buffer extends the range for sentence boundary preservation.
   */
  getChunk(
    cacheId: string,
    startSeconds: number,
    endSeconds: number,
    options?: {
      includeContextSeconds?: number;
      stripAds?: boolean;
    }
  ): ChunkResult {
    const entry = this.cache.get(cacheId);
    if (!entry) {
      throw new Error(`Cache entry not found: ${cacheId}. Use cache_transcript first.`);
    }

    // Check if expired
    if ((Date.now() - entry.fetchedAt) >= this.ttlMs) {
      this.cache.delete(cacheId);
      throw new Error(`Cache entry expired: ${cacheId}. Use cache_transcript to re-cache.`);
    }

    let lines = entry.lines;

    // Strip ads if requested
    if (options?.stripAds !== false && entry.adChapters.length > 0) {
      lines = lines.filter(line => {
        const lineStartMs = line.start * 1000;
        return !entry.adChapters.some(ad =>
          lineStartMs >= ad.startMs && lineStartMs < ad.endMs
        );
      });
    }

    const contextSeconds = options?.includeContextSeconds ?? 0;
    const effectiveStart = Math.max(0, startSeconds - contextSeconds);
    const effectiveEnd = endSeconds + contextSeconds;

    const chunkLines = lines.filter(l => l.start >= effectiveStart && l.start < effectiveEnd);
    const hasMore = lines.some(l => l.start >= endSeconds);

    return {
      lines: chunkLines,
      hasMore,
      totalLines: lines.length,
      chunkLines: chunkLines.length,
      startSeconds,
      endSeconds,
    };
  }

  /**
   * Get cache info without returning the full transcript.
   * Useful for planning chunk strategy.
   */
  getCacheInfo(cacheId: string): CacheInfo | null {
    const entry = this.cache.get(cacheId);
    if (!entry || (Date.now() - entry.fetchedAt) >= this.ttlMs) {
      return null;
    }

    const lastLine = entry.lines[entry.lines.length - 1];
    const totalDuration = lastLine ? lastLine.start + lastLine.dur : 0;
    const totalChars = entry.lines.reduce((sum, l) => sum + l.text.length, 0);

    return {
      cacheId: entry.cacheId,
      videoId: entry.videoId,
      language: entry.actualLang,
      totalDurationSeconds: Math.ceil(totalDuration),
      totalLines: entry.lines.length,
      totalCharacters: totalChars,
      metadata: entry.metadata,
    };
  }

  /**
   * Invalidate a specific cache entry
   */
  invalidate(cacheId: string): boolean {
    return this.cache.delete(cacheId);
  }

  private getTotalSize(): number {
    let total = 0;
    for (const entry of this.cache.values()) {
      total += entry.sizeBytes;
    }
    return total;
  }

  private evictIfNeeded(newSize: number): void {
    while (this.cache.size > 0 && this.getTotalSize() + newSize > this.maxTotalSizeBytes) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this.cache.entries()) {
        if (entry.fetchedAt < oldestTime) {
          oldestTime = entry.fetchedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        console.error(`[transcript-cache] Evicting ${oldestKey} (size limit)`);
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  /**
   * Clean up expired entries
   */
  cleanup(): number {
    let removed = 0;
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.fetchedAt >= this.ttlMs) {
        console.error(`[transcript-cache] Expiring ${key}`);
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Stop the cleanup timer (for graceful shutdown)
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
