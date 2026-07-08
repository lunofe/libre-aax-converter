# _Libre_ .aax converter
Liberate your purchased Audible audiobooks from proprietary apps and file formats, and regain full ownership of your content – no strings attached.

| 🚫 Zero Bullshit.                                                         | 🛡️ Fully Private.                                                            | 💻 Truly yours.                                                    |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| No signup, no fees, no ads, no download or technical knowledge required. | Everything runs locally in your browser. Nothing is ever uploaded anywhere. | Free & open source. Download and run it offline, no setup needed. |

<details>
    <summary>Why & How?</summary>
    <p>When you buy an audiobook on Audible, you aren't just paying for a temporary streaming license like on most other platforms, the content actually belongs to you. However, the real issue starts when you download it. Audible forces the file into a proprietary .aax format that keeps it under their control and binds it to their ecosystem. This completely defeats the purpose of "owning" your media: if you can only play your own property through their system, true ownership becomes entirely meaningless.</p>
    <p>The technical process starts out very pragmatic and then quickly turns into "remarkably creative tinkering" or just plain "magic". To tie the audiobook to your specific account, Audible personalizes the file using a small digital key known as "activation bytes". Instead of trying to break or circumvent the encryption, this tool does something much smarter: it handles the file in the exact way Audible intents.</p>
    <p>By analyzing the unique signature embedded inside your audiobook and with the help of "pre-computed rainbow tables", created by a community of developers who also refused to put up with this proprietary nonsense, the possibilities for your activation bytes can be narrowed down drastically. Think of it like visiting a library and knowing exactly which genre section the book you want is in: you don't have to search the entire building anymore, just that one specific section. Working through that remaining section is exactly what your device puts its computing power to use for.</p>
</details>

## Quick Start (Download and run it offline, no setup needed)

1. _Assuming you're reading this on GitHub_, click the green `<> Code` button at the top
2. Select `Download ZIP`
3. Wait for the download to finish and unpack it
4. Open `index.html` - and that's all!

## Technical details

This is a static, single-page site. There is no backend, no build step, no nothing. Everything needed to run the tool ships as plain files that can be opened straight from disk.

That constraint (must work via `file://`-protocol, without a server) drives most of the "weird" choices you'll find.

Browsers heavily restrict pages loaded via the `file://`-protocol:
- `fetch()` throws on `file://` URLs, so anything that would normally be loaded with an HTTP request can't be fetched as a relative asset.
- There's no server, so there's no way to set CORS or cross-origin isolation headers that some browser APIs require.

Everything in this project is designed to route around both problems instead of requiring a local web server.

### Base64-embedded ffmpeg

`ffmpeg.wasm` normally loads its core in two extra pieces at runtime: `ffmpeg-core.js` (the Emscripten glue code) and `ffmpeg-core.wasm` (the compiled binary). Normally `createFFmpeg()` fetches these from a CDN or a relative `corePath`/`wasmPath` but both require `fetch()`, and therefore fail via `file://`.

To avoid that, the core JS and the core WASM binary are precompiled once and stored as base64 text inside plain `.js` files. Each one just assigns a giant base64 string to a `window`-global. Because these are regular `<script>` tags, the browser loads them like any other JavaScript file.

`app.js` then turns those strings into `data:` URIs at runtime. `data:` URIs *are* something `fetch()` (and `ffmpeg.wasm`'s internal loader) can happily load anywhere, including from a `file://` page. This trades a bit of file size (base64 is ~33% larger than raw binary) for guaranteed portability.

### Single-threaded ffmpeg

`ffmpeg.wasm` ships two flavors of core: a multi-threaded one (uses Web Workers + `SharedArrayBuffer` for parallel encoding) and a single-threaded one. The multi-threaded build only works in a cross-origin isolated context, which requires the page to be served over HTTP(S) with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` response headers. Those headers are a server-side concept, a page opened directly from disk can never satisfy them, and `SharedArrayBuffer` is simply unavailable there.

So this project deliberately bundles the single-threaded ffmpeg-core build. It's slower (everything runs on the main JS thread, which is also why long conversions can freeze the tab), but it has no dependency on cross-origin isolation, workers, or special headers. It runs identically whether the page is opened via `file://`, or `http(s)://`.

### Discovering activation bytes

Audible derives the AES key/IV used to decrypt an `.aax` file from a 4-byte secret called "activation bytes", checked against a checksum stored in the file itself (a SHA-1 digest sitting at byte offset 653 in the container). The check performed in `app.js` mirrors exactly what the official decoder (and ffmpeg's own `aax` demuxer) does.

`FIXED_KEY` is a constant 16-byte value baked into every Audible client (not a secret, it's the same for every file/account). The only unknown is `activationBytes`, a 4-byte (32-bit) value, meaning there are only 2^32 (~4.3 billion) possible values.

Rainbow tables solve this by doing almost all of the expensive work once, in advance, and packaging the result so that looking up any given checksum afterwards is fast. The core idea:
1. **Chain generation (done ahead of time, not in the browser):** Start from a plaintext (candidate activation bytes), hash it with the Audible KDF above, then feed the hash through a reduction function that maps it back into a new plausible activation-bytes value. Repeating hash, reduce thousands of times produces a "chain". Only the _first_ value (start) and the _last_ value (end) of each chain are kept, everything in between is thrown away.
2. **The table** is just a big sorted list of `(start, end)` pairs for many chains, covering a large chunk of the keyspace at a fraction of the storage cost of a full lookup table (since each chain represents `chainLen` values but only stores 8 bytes).
3. **Lookup (done in the browser):** Given the target checksum from the `.aax` file, assume it could be the hash produced at each position in a chain, walk it forward with the reduction/hash steps to the presumed _end_ of the chain, and binary-search for that end value among all stored chain ends. A match means the target hash was _probably_ generated somewhere in that chain, so the algorithm regenerates the whole chain from its stored _start_ value and checks whether the real activation bytes turn up along the way. This is repeated for every possible position in the chain (long chains are the "generation" tradeoff: more coverage per byte stored, but more possible positions, and thus more work, to check per lookup).

This project ships 10 tables, using chains of length 10,000 and roughly 790,000 chains per table, originally generated with "RainbowCrack". About 7.9 billion chain steps of coverage across the ~4.3 billion possible activation-byte values, spread over multiple tables to keep the lookup success rate high despite chain collisions/merges (a known limitation of the rainbow table technique).

Each table is stored as raw binary, an array of `(startIndex, endIndex)` `uint32` pairs (8 bytes/chain), then base64-encoded into a `.js` file that assigns it to a `window`-global, again purely to dodge the `file://`/`fetch()`/CORS problems described above. Tables are loaded and searched one at a time, and each script tag is removed after use to free memory.

Because a single lookup can involve millions of SHA-1 hash operations, `searchTable()` periodically yields to the event loop (`setTimeout(0)`) based on elapsed time so the tab doesn't fully lock up and the busy-spinner animation keeps running, but the browser tab can still be sluggish for the time a full search takes.

### Format conversion

Once activation bytes are known, `app.js` hands the file to `ffmpeg.wasm` with `-activation_bytes <bytes>`, which lets ffmpeg's built-in `aax` demuxer decrypt the audio while remuxing/re-encoding it:
- **.m4b** uses `-c copy` (stream copy, no re-encoding) = fast, since it just repackages the already-AAC-encoded, decrypted audio into an M4B container with chapters intact.
- **.mp3** and **.flac** re-encode the audio (`libmp3lame` / `flac`), which is far slower in a WASM/single-threaded environment and loses chapter metadata.

All of this demuxing, decrypting, and encoding happens inside the WASM sandbox in the browser tab, the decrypted audio is written to an in-memory virtual filesystem (Emscripten's `FS`) and only ever leaves as a `Blob` download via `URL.createObjectURL`.
