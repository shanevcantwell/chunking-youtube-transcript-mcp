#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
  Tool,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { getSubtitles, AdChapter, CaptionTrack } from './youtube-fetcher.js';
import { TranscriptCache } from './transcript-cache.js';

// Define tool configurations
const TOOLS: Tool[] = [
  {
    name: "get_transcript",
    description: "Extract transcript from a YouTube video URL or ID. Automatically falls back to available languages if requested language is not available.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "YouTube video URL or ID"
        },
        lang: {
          type: "string",
          description: "Language code for transcript (e.g., 'ko', 'en'). Will fall back to available language if not found.",
          default: "en"
        },
        include_timestamps: {
          type: "boolean",
          description: "Include timestamps in output (e.g., '[0:05] text'). Useful for referencing specific moments. Default: false",
          default: false
        },
        strip_ads: {
          type: "boolean",
          description: "Filter out sponsored segments from transcript based on chapter markers (e.g., chapters marked as 'Werbung', 'Ad', 'Sponsor'). Default: true",
          default: true
        }
      },
      required: ["url"]
    },
    // OutputSchema describes structuredContent format for Claude Code
    outputSchema: {
      type: "object",
      properties: {
        meta: { type: "string", description: "Title | Author | Subs | Views | Date" },
        content: { type: "string" }
      },
      required: ["content"]
    },
    annotations: {
      title: "Get Transcript",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "cache_transcript",
    description:
      "Cache a YouTube transcript for chunked access. Returns a cache_id and metadata " +
      "(duration, line count, character count) so callers can plan a chunking strategy. " +
      "Parallel calls for the same video are deduplicated (only one fetch). " +
      "Cached entries expire after 1 hour. Use get_transcript_chunk to retrieve slices.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "YouTube video URL, Shorts URL, or video ID",
        },
        lang: {
          type: "string",
          description:
            "Language code for transcript (e.g., 'en', 'ko'). Falls back to available language if not found.",
          default: "en",
        },
      },
      required: ["url"],
    },
    annotations: {
      title: "Cache Transcript",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "get_transcript_chunk",
    description:
      "Return a specific time-range slice from a cached transcript. " +
      "Accepts either a cache_id (from cache_transcript) or a url (auto-caches on first call). " +
      "Hard-limits the returned context to only the requested range. " +
      "Supports an optional context buffer for sentence-boundary preservation.",
    inputSchema: {
      type: "object",
      properties: {
        cache_id: {
          type: "string",
          description:
            "Cache ID from a previous cache_transcript or get_transcript call. " +
            "Format: 'videoId:lang'. If omitted, url is required.",
        },
        url: {
          type: "string",
          description:
            "YouTube video URL or ID. Used to auto-cache if cache_id is not provided.",
        },
        lang: {
          type: "string",
          description: "Language code (only used when url is provided). Default: 'en'",
          default: "en",
        },
        start_seconds: {
          type: "number",
          description: "Start of the chunk in seconds (inclusive)",
        },
        end_seconds: {
          type: "number",
          description: "End of the chunk in seconds (exclusive)",
        },
        include_context_seconds: {
          type: "number",
          description:
            "Extend the range by ±N seconds for sentence-boundary preservation. Default: 0",
          default: 0,
        },
        include_timestamps: {
          type: "boolean",
          description: "Include timestamps in output (e.g., '[1:05] text'). Default: false",
          default: false,
        },
        strip_ads: {
          type: "boolean",
          description: "Filter out sponsored segments. Default: true",
          default: true,
        },
        max_chars: {
          type: "number",
          description:
            "Hard limit on output size in characters. If the chunk exceeds this, " +
            "it is truncated and a continuation marker is added. Default: no limit",
        },
      },
      required: ["start_seconds", "end_seconds"],
    },
    annotations: {
      title: "Get Transcript Chunk",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
];

interface TranscriptLine {
  text: string;
  start: number;
  dur: number;
}

class YouTubeTranscriptExtractor {
  /**
   * Extracts YouTube video ID from various URL formats or direct ID input
   */
  extractYoutubeId(input: string): string {
    if (!input) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'YouTube URL or ID is required'
      );
    }

    // Handle URL formats
    try {
      const url = new URL(input);
      if (url.hostname === 'youtu.be') {
        return url.pathname.slice(1);
      } else if (url.hostname.includes('youtube.com')) {
        // Handle Shorts URLs: /shorts/{id}
        if (url.pathname.startsWith('/shorts/')) {
          const id = url.pathname.slice(8); // Remove '/shorts/'
          if (!id) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Invalid YouTube Shorts URL: missing video ID`
            );
          }
          return id;
        }
        // Handle regular watch URLs: /watch?v={id}
        const videoId = url.searchParams.get('v');
        if (!videoId) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid YouTube URL: ${input}`
          );
        }
        return videoId;
      }
    } catch (error) {
      // Not a URL, check if it's a direct video ID (10-11 URL-safe Base64 chars, may start with -)
      if (!/^-?[a-zA-Z0-9_-]{10,11}$/.test(input)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid YouTube video ID: ${input}`
        );
      }
      return input;
    }

    throw new McpError(
      ErrorCode.InvalidParams,
      `Could not extract video ID from: ${input}`
    );
  }

  /**
   * Retrieves transcript for a given video ID and language
   */
  async getTranscript(videoId: string, lang: string, includeTimestamps: boolean, stripAds: boolean): Promise<{
    text: string;
    actualLang: string;
    availableLanguages: string[];
    adsStripped: number;
    adChaptersFound: number;
    metadata: {
      title: string;
      author: string;
      subscriberCount: string;
      viewCount: string;
      publishDate: string;
    };
  }> {
    try {
      const result = await getSubtitles({
        videoID: videoId,
        lang: lang,
        enableFallback: true,
      });

      let lines = result.lines;
      let adsStripped = 0;

      // Filter out lines that fall within ad chapters
      if (stripAds && result.adChapters.length > 0) {
        const originalCount = lines.length;
        lines = lines.filter(line => {
          const lineStartMs = line.start * 1000;
          // Check if this line falls within any ad chapter
          return !result.adChapters.some((ad: AdChapter) =>
            lineStartMs >= ad.startMs && lineStartMs < ad.endMs
          );
        });
        adsStripped = originalCount - lines.length;
        if (adsStripped > 0) {
          console.log(`[youtube-transcript] Filtered ${adsStripped} lines from ${result.adChapters.length} ad chapter(s): ${result.adChapters.map((a: AdChapter) => a.title).join(', ')}`);
        }
      }

      return {
        text: this.formatTranscript(lines, includeTimestamps),
        actualLang: result.actualLang,
        availableLanguages: result.availableLanguages.map((t: CaptionTrack) => t.languageCode),
        adsStripped,
        adChaptersFound: result.adChapters.length,
        metadata: result.metadata
      };
    } catch (error) {
      console.error('Failed to fetch transcript:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to retrieve transcript: ${(error as Error).message}`
      );
    }
  }

  /**
   * Formats transcript lines into readable text
   */
  private formatTranscript(transcript: TranscriptLine[], includeTimestamps: boolean): string {
    if (includeTimestamps) {
      return transcript
        .map(line => {
          const totalSeconds = Math.floor(line.start);
          const hours = Math.floor(totalSeconds / 3600);
          const mins = Math.floor((totalSeconds % 3600) / 60);
          const secs = totalSeconds % 60;
          // Use h:mm:ss for videos > 1 hour, mm:ss otherwise
          const timestamp = hours > 0
            ? `[${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`
            : `[${mins}:${secs.toString().padStart(2, '0')}]`;
          return `${timestamp} ${line.text.trim()}`;
        })
        .filter(text => text.length > 0)
        .join('\n');
    }
    return transcript
      .map(line => line.text.trim())
      .filter(text => text.length > 0)
      .join(' ');
  }
}

class TranscriptServer {
  private extractor: YouTubeTranscriptExtractor;
  private server: Server;
  private cache: TranscriptCache;

  constructor() {
    this.extractor = new YouTubeTranscriptExtractor();
    this.cache = new TranscriptCache();
    this.server = new Server(
      {
        name: "mcp-servers-youtube-transcript",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    process.on('SIGINT', async () => {
      await this.stop();
      process.exit(0);
    });
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => 
      this.handleToolCall(request.params.name, request.params.arguments ?? {})
    );
  }

  /**
   * Validates and extracts common URL/lang params
   */
  private parseUrlArgs(args: any): { videoId: string; lang: string } {
    const input = args.url;
    const lang = args.lang ?? 'en';

    if (!input || typeof input !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'URL parameter is required and must be a string');
    }
    if (lang && typeof lang !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Language code must be a string');
    }

    return { videoId: this.extractor.extractYoutubeId(input), lang };
  }

  /**
   * Formats transcript lines into readable text
   */
  private formatLines(lines: { text: string; start: number; dur: number }[], includeTimestamps: boolean): string {
    if (includeTimestamps) {
      return lines
        .map(line => {
          const totalSeconds = Math.floor(line.start);
          const hours = Math.floor(totalSeconds / 3600);
          const mins = Math.floor((totalSeconds % 3600) / 60);
          const secs = totalSeconds % 60;
          const timestamp = hours > 0
            ? `[${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`
            : `[${mins}:${secs.toString().padStart(2, '0')}]`;
          return `${timestamp} ${line.text.trim()}`;
        })
        .filter(text => text.length > 0)
        .join('\n');
    }
    return lines
      .map(line => line.text.trim())
      .filter(text => text.length > 0)
      .join(' ');
  }

  /**
   * Handles tool call requests
   */
  private async handleToolCall(name: string, args: any): Promise<CallToolResult> {
    switch (name) {
      case "get_transcript": {
        const { url: input, lang = "en", include_timestamps = false, strip_ads = true } = args;

        if (!input || typeof input !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'URL parameter is required and must be a string'
          );
        }

        if (lang && typeof lang !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Language code must be a string'
          );
        }

        try {
          const videoId = this.extractor.extractYoutubeId(input);
          console.error(`Processing transcript for video: ${videoId}, lang: ${lang}, timestamps: ${include_timestamps}, strip_ads: ${strip_ads}`);

          const result = await this.extractor.getTranscript(videoId, lang, include_timestamps, strip_ads);
          console.error(`Successfully extracted transcript (${result.text.length} chars, lang: ${result.actualLang}, ads stripped: ${result.adsStripped})`);

          // Auto-cache for future chunk requests
          try {
            await this.cache.ensureCached(videoId, lang);
          } catch {
            // Non-fatal: caching failure shouldn't break the primary response
          }
          const cacheId = `${videoId}:${lang}`;

          // Build transcript with notes
          let transcript = result.text;

          // Add language fallback notice if different from requested
          if (result.actualLang !== lang) {
            transcript = `[Note: Requested language '${lang}' not available. Using '${result.actualLang}'. Available: ${result.availableLanguages.join(', ')}]\n\n${transcript}`;
          }

          // Add ad filtering notice based on what happened
          if (result.adsStripped > 0) {
            transcript = `[Note: ${result.adsStripped} sponsored segment lines filtered out based on chapter markers]\n\n${transcript}`;
          } else if (strip_ads && result.adChaptersFound === 0) {
            transcript += '\n\n[Note: No chapter markers found. If summarizing, please exclude any sponsored segments or ads from the summary.]';
          }

          // Append cache_id hint for chunk access
          transcript += `\n\n[cache_id: ${cacheId}]`;

          return {
            content: [{
              type: "text" as const,
              text: transcript
            }],
            structuredContent: {
              meta: `${result.metadata.title} | ${result.metadata.author} | ${result.metadata.subscriberCount} subs | ${result.metadata.viewCount} views | ${result.metadata.publishDate}`,
              content: transcript.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ')
            }
          };
        } catch (error) {
          console.error('Transcript extraction failed:', error);

          if (error instanceof McpError) {
            throw error;
          }

          throw new McpError(
            ErrorCode.InternalError,
            `Failed to process transcript: ${(error as Error).message}`
          );
        }
      }

      case "cache_transcript": {
        const { videoId, lang } = this.parseUrlArgs(args);

        try {
          console.error(`Caching transcript for video: ${videoId}, lang: ${lang}`);
          const cached = await this.cache.ensureCached(videoId, lang);
          const info = this.cache.getCacheInfo(cached.cacheId);

          if (!info) {
            throw new McpError(ErrorCode.InternalError, 'Cache entry disappeared immediately after creation');
          }

          const response = [
            `Transcript cached successfully.`,
            ``,
            `cache_id: ${info.cacheId}`,
            `video: ${info.metadata.title}`,
            `author: ${info.metadata.author}`,
            `language: ${info.language}`,
            `duration: ${info.totalDurationSeconds}s (${Math.ceil(info.totalDurationSeconds / 60)} min)`,
            `lines: ${info.totalLines}`,
            `characters: ${info.totalCharacters}`,
            ``,
            `Use get_transcript_chunk with this cache_id to retrieve time-range slices.`,
          ].join('\n');

          return {
            content: [{ type: "text" as const, text: response }],
          };
        } catch (error) {
          if (error instanceof McpError) throw error;
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to cache transcript: ${(error as Error).message}`
          );
        }
      }

      case "get_transcript_chunk": {
        const {
          cache_id,
          url,
          lang = "en",
          start_seconds,
          end_seconds,
          include_context_seconds = 0,
          include_timestamps = false,
          strip_ads = true,
          max_chars,
        } = args;

        if (start_seconds == null || end_seconds == null) {
          throw new McpError(ErrorCode.InvalidParams, 'start_seconds and end_seconds are required');
        }
        if (typeof start_seconds !== 'number' || typeof end_seconds !== 'number') {
          throw new McpError(ErrorCode.InvalidParams, 'start_seconds and end_seconds must be numbers');
        }
        if (start_seconds < 0 || end_seconds <= start_seconds) {
          throw new McpError(ErrorCode.InvalidParams, 'end_seconds must be greater than start_seconds, and start_seconds must be >= 0');
        }

        // Resolve cache_id: use provided one, or auto-cache from url
        let resolvedCacheId = cache_id;

        if (!resolvedCacheId) {
          if (!url) {
            throw new McpError(ErrorCode.InvalidParams, 'Either cache_id or url is required');
          }
          const videoId = this.extractor.extractYoutubeId(url);
          resolvedCacheId = `${videoId}:${lang}`;

          // Auto-cache if not already cached
          try {
            await this.cache.ensureCached(videoId, lang);
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to cache transcript: ${(error as Error).message}`
            );
          }
        }

        try {
          const chunk = this.cache.getChunk(resolvedCacheId, start_seconds, end_seconds, {
            includeContextSeconds: include_context_seconds,
            stripAds: strip_ads,
          });

          let text = this.formatLines(chunk.lines, include_timestamps);
          let truncated = false;

          // Hard-limit output size
          if (max_chars && max_chars > 0 && text.length > max_chars) {
            text = text.substring(0, max_chars);
            truncated = true;
          }

          const header = [
            `[chunk ${start_seconds}s–${end_seconds}s | ${chunk.chunkLines}/${chunk.totalLines} lines | has_more: ${chunk.hasMore}${truncated ? ' | TRUNCATED' : ''}]`,
          ].join('');

          return {
            content: [{ type: "text" as const, text: `${header}\n${text}` }],
          };
        } catch (error) {
          if (error instanceof McpError) throw error;
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to get chunk: ${(error as Error).message}`
          );
        }
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${name}`
        );
    }
  }

  /**
   * Starts the server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /**
   * Stops the server
   */
  async stop(): Promise<void> {
    this.cache.dispose();
    try {
      await this.server.close();
    } catch (error) {
      console.error('Error while stopping server:', error);
    }
  }
}

// Main execution
async function main() {
  const server = new TranscriptServer();
  
  try {
    await server.start();
  } catch (error) {
    console.error("Server failed to start:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});