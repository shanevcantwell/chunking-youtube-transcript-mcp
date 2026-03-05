## Working Model: Co-Architects

This is a pair programming relationship, without expectations of a code vending machine. The value is in the conversation that precedes implementation.

**What good looks like:**
- Understanding *why* before proposing *how*
- Exploring tradeoffs out loud: "Option A gives us X but costs Y"
- Asking "what problem are we actually solving?" when requirements seem underspecified
- Reading existing code to understand patterns before writing new code
- Treating the codebase as a long-term asset we're stewarding together

**The goal is working software that remains maintainable** - not code that appears to work, not impressive-looking output, not maximum tokens of plausible implementation. Every line of code is measured investment of the user's time; make that investment count.

When in doubt: discuss the approach first. The user's time is better spent on architectural clarity than debugging hastily-generated code.

## Project: Chunking YouTube Transcript MCP

Fork of [kimtaeyoon83/mcp-server-youtube-transcript](https://github.com/kimtaeyoon83/mcp-server-youtube-transcript) extended with caching and chunked transcript access for parallel agentic workflows.

### Architecture

- **MCP server** over stdio using `@modelcontextprotocol/sdk`
- **Zero external deps** for transcript fetching — raw HTTPS to YouTube's internal API
- Uses Android client (v19.29.37) to bypass poToken enforcement
- Protobuf-encoded API requests for transcript retrieval

### Key Files

- `src/index.ts` — MCP server, tool definitions, request handlers
- `src/youtube-fetcher.ts` — YouTube API interaction (page scraping, transcript API)
- `src/transcript-cache.ts` — In-memory cache with request deduplication, TTL, size eviction

### Three MCP Tools

1. **get_transcript** — Full transcript (legacy). Auto-caches for future chunk requests.
2. **cache_transcript** — Cache transcript, return planning metadata (duration, lines, chars). No transcript text in response.
3. **get_transcript_chunk** — Time-range slice from cache. Accepts `cache_id` or `url` (auto-caches). Hard-limits output via `max_chars`.

### Cache Design Decisions

- **Deterministic cache keys**: `videoId:lang` — workers don't need to coordinate
- **Request deduplication**: parallel calls for same video share one in-flight fetch
- **TTL**: 1 hour default, cleanup timer every 5 minutes
- **Size limit**: 50MB total, oldest-first eviction
- **This server is just the interface** — the agentic system that fans out chunk requests is a separate concern

### Build

- TypeScript targeting ES2022, Node16 modules
- `npm run build` (tsc + chmod)
- `package.json` has a `prepare` script that runs build — use `--ignore-scripts` when installing deps before source is available (e.g., Docker multi-stage)
- Docker: multi-stage build, `node:18-alpine`
