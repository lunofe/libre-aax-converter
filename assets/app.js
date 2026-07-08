(function () {
    const FIXED_KEY = [
        0x77, 0x21, 0x4d, 0x4b, 0x19, 0x6a, 0x87, 0xcd,
        0x52, 0x00, 0x45, 0xfd, 0x20, 0xa5, 0x1d, 0x67,
    ];

    const FFMPEG_CORE_JS = "data:application/javascript;base64," + window.__FFMPEG_CORE_JS_B64;
    const FFMPEG_CORE_WASM = "data:application/wasm;base64," + window.__FFMPEG_CORE_WASM_B64;

    const fileInput = document.getElementById("aaxFile");
    let lastChecksum = "";
    const activationBytesInput = document.getElementById("activationBytes");
    const verifyBtn = document.getElementById("verifyBtn");
    const resolveBtn = document.getElementById("resolveBtn");
    const activationStatus = document.getElementById("activationStatus");
    const formatSelect = document.getElementById("outputFormat");
    const convertBtn = document.getElementById("convertBtn");
    const convertStatus = document.getElementById("convertStatus");

    let selectedFile = null;
    let ffmpegInstance = null;
    let fileLoaded = false;
    let activationVerified = false;

    function updateGating() {
        activationBytesInput.disabled = !fileLoaded;
        verifyBtn.disabled = !fileLoaded;
        resolveBtn.disabled = !fileLoaded;

        const canConvert = fileLoaded && activationVerified;
        formatSelect.disabled = !canConvert;
        convertBtn.disabled = !canConvert;
    }

    function bytesToHex(bytes) {
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }

    function bytesEqual(a, b) {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i += 1) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    function hexToBytes(hex) {
        if (hex.length % 2 !== 0) {
            throw new Error("Hex input must have an even length.");
        }
        const out = [];
        for (let i = 0; i < hex.length; i += 2) {
            out.push(parseInt(hex.slice(i, i + 2), 16));
        }
        return out;
    }

    async function sha1Bytes(data) {
        const input = new Uint8Array(data);
        const digest = await crypto.subtle.digest("SHA-1", input);
        return Array.from(new Uint8Array(digest));
    }

    async function hashAudible(plainBytes) {
        const intermediateKey = await sha1Bytes(FIXED_KEY.concat(plainBytes));
        const intermediateIv = await sha1Bytes(
            FIXED_KEY.concat(intermediateKey).concat(plainBytes)
        );
        return sha1Bytes(intermediateKey.slice(0, 16).concat(intermediateIv.slice(0, 16)));
    }

    async function calculateChecksum(activationBytesHex) {
        const activationBytes = hexToBytes(activationBytesHex.toLowerCase());
        if (activationBytes.length !== 4) {
            throw new Error("Activation bytes must be exactly 8 hex characters.");
        }
        const hash = await hashAudible(activationBytes);
        return bytesToHex(hash);
    }

    async function extractChecksum(file) {
        const part = file.slice(653, 653 + 20);
        const buf = await part.arrayBuffer();
        return bytesToHex(new Uint8Array(buf));
    }

    function indexToPlainBytes(index) {
        return [
            (index >>> 24) & 0xff,
            (index >>> 16) & 0xff,
            (index >>> 8) & 0xff,
            index & 0xff,
        ];
    }

    function hashToIndex(hashBytes, tableIndex, pos) {
        let hashPrefix = 0n;
        for (let i = 0; i < 8; i += 1) {
            hashPrefix |= BigInt(hashBytes[i]) << BigInt(8 * i);
        }
        return Number((hashPrefix + BigInt(65536 * tableIndex) + BigInt(pos)) & 0xffffffffn);
    }

    function parseRtMeta(fileName) {
        const match = fileName.match(/^([^_]+)_([^_]+)_(\d+)_(\d+)x(\d+)_\d+\.rt$/i);
        if (!match) {
            throw new Error("Unsupported table filename: " + fileName);
        }

        const hashRoutine = match[1].toLowerCase();
        const charsetDef = match[2].toLowerCase();
        const tableIndex = Number(match[3]);
        const chainLen = Number(match[4]);
        const chainCount = Number(match[5]);

        if (hashRoutine !== "audible") {
            throw new Error("Only audible tables are supported.");
        }
        if (charsetDef !== "byte#4-4") {
            throw new Error("Only byte#4-4 tables are supported.");
        }

        return { tableIndex, chainLen, chainCount };
    }

    function base64ToUint8(b64) {
        const bin = atob(b64);
        const len = bin.length;
        const out = new Uint8Array(len);
        for (let i = 0; i < len; i += 1) {
            out[i] = bin.charCodeAt(i);
        }
        return out;
    }

    function loadScriptOnce(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = src;
            script.onload = () => resolve(script);
            script.onerror = () => reject(new Error("Failed to load " + src));
            document.head.appendChild(script);
        });
    }

    function binarySearchRangeByEndIndex(table, targetEndIndex) {
        let low = 0;
        let high = table.recordCount - 1;
        let found = -1;

        while (low <= high) {
            const mid = (low + high) >>> 1;
            const value = table.getEnd(mid);
            if (value === targetEndIndex) {
                found = mid;
                break;
            }
            if (value < targetEndIndex) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        if (found === -1) {
            return null;
        }

        let from = found;
        let to = found;
        while (from > 0 && table.getEnd(from - 1) === targetEndIndex) {
            from -= 1;
        }
        while (to < table.recordCount - 1 && table.getEnd(to + 1) === targetEndIndex) {
            to += 1;
        }

        return { from, to };
    }

    async function walkFromHashToEndIndex(targetHash, startPos, chainLen, tableIndex) {
        let index = hashToIndex(targetHash, tableIndex, startPos);
        for (let pos = startPos + 1; pos <= chainLen - 2; pos += 1) {
            const plain = indexToPlainBytes(index);
            const hash = await hashAudible(plain);
            index = hashToIndex(hash, tableIndex, pos);
        }
        return index;
    }

    async function checkAlarm(startIndex, guessedPos, targetHash, tableIndex) {
        let index = startIndex;

        for (let pos = 0; pos < guessedPos; pos += 1) {
            const plain = indexToPlainBytes(index);
            const hash = await hashAudible(plain);
            index = hashToIndex(hash, tableIndex, pos);
        }

        const candidatePlain = indexToPlainBytes(index);
        const candidateHash = await hashAudible(candidatePlain);
        if (bytesEqual(candidateHash, targetHash)) {
            return candidatePlain;
        }
        return null;
    }

    async function searchTable(table, targetHash) {
        let lastYield = Date.now();

        for (let guessedPos = table.chainLen - 2; guessedPos >= 0; guessedPos -= 1) {
            const endIndex = await walkFromHashToEndIndex(
                targetHash,
                guessedPos,
                table.chainLen,
                table.tableIndex
            );

            const range = binarySearchRangeByEndIndex(table, endIndex);
            if (range) {
                for (let i = range.from; i <= range.to; i += 1) {
                    const startIndex = table.getStart(i);
                    const plain = await checkAlarm(startIndex, guessedPos, targetHash, table.tableIndex);
                    if (plain) {
                        return bytesToHex(plain);
                    }
                }
            }

            if (Date.now() - lastYield > 100) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                lastYield = Date.now();
            }
        }

        return null;
    }

    async function resolveFromPackagedTables(checksumHex) {
        const manifest = window.__AAX_TABLE_MANIFEST;
        if (!manifest || !manifest.length) {
            throw new Error(
                "Packaged tables not found."
            );
        }

        const targetHash = new Uint8Array(hexToBytes(checksumHex));
        const entries = manifest.map((entry) => ({ entry, meta: parseRtMeta(entry.name) }));

        for (const { entry, meta } of entries) {
            const script = await loadScriptOnce(entry.file);
            const registry = window.__AAX_TABLES || {};
            const b64 = registry[entry.name];
            if (!b64) {
                throw new Error("Table data missing after load: " + entry.name);
            }

            const bytes = base64ToUint8(b64);
            const view = new DataView(bytes.buffer);
            const table = {
                name: entry.name,
                tableIndex: meta.tableIndex,
                chainLen: meta.chainLen,
                recordCount: Math.floor(bytes.length / 8),
                getStart: (i) => view.getUint32(i * 8, true),
                getEnd: (i) => view.getUint32(i * 8 + 4, true),
            };

            const activation = await searchTable(table, targetHash);

            delete registry[entry.name];
            if (script && script.parentNode) {
                script.parentNode.removeChild(script);
            }

            if (activation) {
                return activation;
            }
        }

        return null;
    }

    function getCodecArgs(format) {
        if (format === "m4b") {
            return ["-c", "copy"];
        }
        if (format === "mp3") {
            return ["-c:a", "libmp3lame"];
        }
        if (format === "flac") {
            return ["-c:a", "flac"];
        }
        throw new Error("Unsupported format: " + format);
    }

    function buildOutputName(inputName, format) {
        const dot = inputName.lastIndexOf(".");
        const base = dot > 0 ? inputName.slice(0, dot) : inputName;
        return (base || "output") + "." + format;
    }

    function downloadBytes(data, fileName, mimeType) {
        const blob = new Blob([data.buffer], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    async function getFfmpeg() {
        if (ffmpegInstance) {
            return ffmpegInstance;
        }

        if (!window.FFmpeg || !window.FFmpeg.createFFmpeg || !window.FFmpeg.fetchFile) {
            throw new Error("FFmpeg wasm loader is missing.");
        }

        const createFFmpeg = window.FFmpeg.createFFmpeg;
        ffmpegInstance = createFFmpeg({
            log: true,
            mainName: "main",
            corePath: FFMPEG_CORE_JS,
            wasmPath: FFMPEG_CORE_WASM,
        });

        try {
            await ffmpegInstance.load();
        } catch (err) {
            throw new Error(
                "Failed to load the embedded ffmpeg core. Original error: " + err.message
            );
        }

        return ffmpegInstance;
    }

    fileInput.addEventListener("change", async function () {
        const file = fileInput.files && fileInput.files[0];
        activationBytesInput.value = "";
        activationStatus.textContent = "";
        convertStatus.textContent = "";
        activationVerified = false;

        if (!file) {
            selectedFile = null;
            fileLoaded = false;
            lastChecksum = "...";
            updateGating();
            return;
        }

        selectedFile = file;

        try {
            lastChecksum = await extractChecksum(file);
            fileLoaded = true;
        } catch (err) {
            lastChecksum = "⚠️ error: " + err.message;
            fileLoaded = false;
        }
        updateGating();
    });

    activationBytesInput.addEventListener("input", function () {
        activationVerified = false;
        activationStatus.textContent = "";
        updateGating();
    });

    verifyBtn.addEventListener("click", async function () {
        const checksum = (lastChecksum || "").trim().toLowerCase();
        const activation = activationBytesInput.value.trim().toLowerCase();

        if (!/^[0-9a-f]{8}$/i.test(activation)) {
            activationStatus.textContent = "⚠️ Activation bytes must be exactly 8 hex characters.";
            return;
        }

        try {
            const derived = await calculateChecksum(activation);
            if (derived === checksum) {
                activationStatus.textContent = "✅ Valid!";
                activationVerified = true;
            } else {
                activationStatus.textContent = "⛔ Doesn't match the file.";
                activationVerified = false;
            }
        } catch (err) {
            activationStatus.textContent = "⚠️ Verification failed: " + err.message;
            activationVerified = false;
        }
        updateGating();
    });

    resolveBtn.addEventListener("click", async function () {
        const checksum = (lastChecksum || "").trim().toLowerCase();
        activationStatus.textContent = "";
        activationVerified = false;

        resolveBtn.disabled = true;
        resolveBtn.setAttribute("aria-busy", "true");

        try {
            const activation = await resolveFromPackagedTables(checksum);
            if (!activation) {
                activationStatus.textContent = "⚠️ Activation bytes were not found in the packaged tables.";
                return;
            }
            activationBytesInput.value = activation;
            activationStatus.textContent = "✅ Valid! (found automatically)";
            activationVerified = true;
        } catch (err) {
            activationStatus.textContent = "⚠️ Local resolve failed: " + err.message;
        } finally {
            resolveBtn.removeAttribute("aria-busy");
            updateGating();
        }
    });

    convertBtn.addEventListener("click", async function () {
        const file = selectedFile;
        const activation = activationBytesInput.value.trim();
        const format = formatSelect.value;
        convertStatus.textContent = "";

        convertBtn.disabled = true;
        convertBtn.setAttribute("aria-busy", "true");

        try {
            const ffmpeg = await getFfmpeg();
            const fetchFile = window.FFmpeg.fetchFile;
            const outputName = buildOutputName(file.name, format);
            const codecArgs = getCodecArgs(format);

            ffmpeg.FS("writeFile", file.name, await fetchFile(file));

            await ffmpeg.run(
                "-y",
                "-activation_bytes",
                activation,
                "-i",
                file.name,
                ...codecArgs,
                outputName
            );

            const output = ffmpeg.FS("readFile", outputName);
            const mime = format === "mp3" ? "audio/mpeg" : "audio/" + format;
            downloadBytes(output, outputName, mime);

            try {
                ffmpeg.FS("unlink", file.name);
            } catch (_e) { }
            try {
                ffmpeg.FS("unlink", outputName);
            } catch (_e) { }
        } catch (err) {
            convertStatus.textContent = "⚠️ Conversion failed: " + err.message;
        } finally {
            convertBtn.removeAttribute("aria-busy");
            updateGating();
        }
    });

    updateGating();
})();
