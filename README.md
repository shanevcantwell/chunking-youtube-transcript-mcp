# Chunking YouTube Transcript MCP

A Model Context Protocol server that retrieves transcripts from YouTube videos with built-in caching and chunked access for parallel agentic workflows.

> **Fork of [kimtaeyoon83/mcp-server-youtube-transcript](https://github.com/kimtaeyoon83/mcp-server-youtube-transcript)** — extends the original with transcript caching and time-range chunking to support context-limited LLMs processing long videos.

## Why Chunking?

A 2-hour YouTube transcript can be 30k+ characters — far too much context for a single LLM call, especially with smaller models. This server lets an agentic system:

1. **Cache once** — fetch the transcript a single time, even under parallel requests
2. **Slice by time range** — request only the chunk needed (e.g., minutes 10–15)
3. **Hard-limit output** — cap response size with `max_chars` so the LLM never gets overwhelmed

Parallel calls for the same video are deduplicated to a single YouTube fetch. Cached entries expire after 1 hour with a 50MB total cache limit.

## Tools

### `get_transcript`

Extract the full transcript from a YouTube video. Auto-caches for future chunk requests.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | yes | — | YouTube video URL, Shorts URL, or video ID |
| `lang` | string | no | `"en"` | Language code. Falls back to available language if not found |
| `include_timestamps` | boolean | no | `false` | Include timestamps (e.g., `[1:05] text`) |
| `strip_ads` | boolean | no | `true` | Filter out sponsored segments via chapter markers |

### `cache_transcript`

Cache a transcript and return planning metadata (duration, line count, character count) without returning the full text. Use this to plan a chunking strategy.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | yes | — | YouTube video URL, Shorts URL, or video ID |
| `lang` | string | no | `"en"` | Language code |

Returns: `cache_id`, video metadata, duration, line count, character count.

### `get_transcript_chunk`

Return a specific time-range slice from a cached transcript. Accepts either a `cache_id` or a `url` (auto-caches on first call).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `cache_id` | string | no* | — | Cache ID from `cache_transcript` or `get_transcript`. Format: `videoId:lang` |
| `url` | string | no* | — | YouTube URL or ID. Auto-caches if `cache_id` not provided |
| `lang` | string | no | `"en"` | Language code (only used with `url`) |
| `start_seconds` | number | yes | — | Start of chunk (inclusive) |
| `end_seconds` | number | yes | — | End of chunk (exclusive) |
| `include_context_seconds` | number | no | `0` | Extend range by +/-N seconds for sentence boundaries |
| `include_timestamps` | boolean | no | `false` | Include timestamps in output |
| `strip_ads` | boolean | no | `true` | Filter out sponsored segments |
| `max_chars` | number | no | — | Hard limit on output characters. Truncates with marker if exceeded |

*At least one of `cache_id` or `url` is required.

## Agentic Workflow Example

```typescript
// Step 1: Cache and get metadata for planning
const info = await callTool("cache_transcript", {
  url: "https://www.youtube.com/watch?v=VIDEO_ID"
});
// → cache_id: "VIDEO_ID:en", duration: 7200s, characters: 45000

// Step 2: Fan out parallel chunk requests
const chunk1 = await callTool("get_transcript_chunk", {
  cache_id: "VIDEO_ID:en",
  start_seconds: 0,
  end_seconds: 600,
  max_chars: 4000
});

const chunk2 = await callTool("get_transcript_chunk", {
  cache_id: "VIDEO_ID:en",
  start_seconds: 600,
  end_seconds: 1200,
  max_chars: 4000
});
// All parallel — one YouTube fetch total, hard-limited output per chunk
```

Workers can also skip `cache_transcript` and pass `url` directly to `get_transcript_chunk` — the server auto-caches and deduplicates.

## Key Features

- Transcript caching with request deduplication for parallel access
- Time-range chunking with hard context limits
- Support for multiple video URL formats (including YouTube Shorts)
- Language-specific transcript retrieval with automatic fallback
- Built-in ad/sponsorship filtering via chapter markers
- Zero external dependencies for transcript fetching

## Configuration

```json
{
  "mcpServers": {
    "youtube-transcript": {
      "command": "npx",
      "args": ["-y", "@kimtaeyoon83/mcp-server-youtube-transcript"]
    }
  }
}
```

## Development

### Prerequisites

- Node.js 18 or higher

### Setup

```bash
npm install
npm run build
```

For development with auto-rebuild:
```bash
npm run watch
```

### Debugging

Since MCP servers communicate over stdio, we recommend the MCP Inspector:

```bash
npm run inspector
```

### Running evals

```bash
OPENAI_API_KEY=your-key npx mcp-eval src/evals/evals.ts src/index.ts
```

## Error Handling

- Invalid video URLs or IDs
- Unavailable transcripts
- Language availability issues
- Network errors
- Cache expiration and eviction

## Credits

Original server by [kimtaeyoon83](https://github.com/kimtaeyoon83/mcp-server-youtube-transcript). Listed on [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers). Installable via [mcp-get](https://github.com/michaellatman/mcp-get) and [Smithery](https://smithery.ai/server/@kimtaeyoon83/mcp-server-youtube-transcript).

## License

MIT License. See the LICENSE file for details.
