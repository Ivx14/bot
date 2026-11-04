const { downloadContentFromMessage, normalizeMessageContent } = require('@whiskeysockets/baileys');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Concurrencia para extraer los fragmentos crudos (webpmux) en paralelo
const FRAME_CONCURRENCY = 6;

// ==========================================
// PACK Y AUTOR POR USUARIO
// ==========================================
// sticker_config.json queda así:
// {
//   "pack": "Stickers",     <- pack por defecto (para quien no haya usado .sets)
//   "author": "Ivx",        <- autor por defecto
//   "users": { "5215512345678": { "pack": "...", "author": "..." } }   <- lo de cada usuario
// }
const STICKER_CONFIG_PATH = path.join(__dirname, 'sticker_config.json');

function readStickerConfig() {
    try {
        if (fs.existsSync(STICKER_CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(STICKER_CONFIG_PATH, 'utf8'));
            if (data && typeof data === 'object' && !Array.isArray(data)) return data;
        }
    } catch (e) {}
    return {};
}

// Acepta un id o varios (número y/o LID de la misma persona) y los deja solo en dígitos
function toIdList(userIds) {
    const ids = [].concat(userIds || [])
        .map(id => String(id || '').split(':')[0].replace(/\D/g, ''))
        .filter(Boolean);
    return [...new Set(ids)];
}

// Devuelve el pack y autor de ese usuario; si no ha usado .sets, los del bot por defecto
function getStickerDefaults(userIds = null) {
    const data = readStickerConfig();
    let own = null;
    for (const id of toIdList(userIds)) {
        if (data.users && data.users[id]) { own = data.users[id]; break; }
    }
    return {
        pack: own?.pack || data.pack || data.packname || 'Sticker',
        author: own?.author || data.author || 'Bot'
    };
}

// Guarda el pack y autor de ese usuario (en todas sus identidades) sin tocar a los demás
function setStickerDefaults(userIds, pack, author) {
    const ids = toIdList(userIds);
    if (ids.length === 0) throw new Error('No se pudo identificar al usuario');

    const data = readStickerConfig();
    if (!data.users || typeof data.users !== 'object' || Array.isArray(data.users)) data.users = {};
    for (const id of ids) data.users[id] = { pack, author };

    const tmpPath = STICKER_CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, STICKER_CONFIG_PATH);
}

// ==========================================
// PACK Y AUTOR DEL STICKER (formato de WhatsApp)
// ==========================================
// WhatsApp NO lee los tags normales de exiftool (Author/Title). Lee un bloque
// EXIF propio dentro del .webp con un JSON que tiene el nombre del pack y el
// autor. Estas dos funciones arman ese bloque y lo meten en el archivo.
function buildWhatsAppExif(pack, author) {
    const json = {
        'sticker-pack-id': crypto.createHash('md5').update(`${pack}|${author}`).digest('hex'),
        'sticker-pack-name': pack,
        'sticker-pack-publisher': author,
        emojis: []
    };
    const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');

    // Cabecera TIFF mínima con una sola etiqueta (0x5741) que apunta al JSON
    const header = Buffer.from([
        0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
        0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);
    header.writeUInt32LE(jsonBuf.length, 14); // largo del JSON
    return Buffer.concat([header, jsonBuf]);
}

// Inserta (o reemplaza) el bloque EXIF dentro de un WebP, sin herramientas
// externas. Sirve para WebP estáticos (simples o extendidos) y animados.
function setWebpExif(webp, exif) {
    if (webp.length < 20 || webp.toString('ascii', 0, 4) !== 'RIFF' || webp.toString('ascii', 8, 12) !== 'WEBP') {
        throw new Error('El archivo no es un WebP válido');
    }

    // Separar el archivo en chunks
    const chunks = [];
    let pos = 12;
    while (pos + 8 <= webp.length) {
        const fourcc = webp.toString('ascii', pos, pos + 4);
        const size = webp.readUInt32LE(pos + 4);
        chunks.push({ fourcc, data: Buffer.from(webp.subarray(pos + 8, pos + 8 + size)) });
        pos += 8 + size + (size & 1); // los chunks impares llevan 1 byte de relleno
    }

    const list = chunks.filter(c => c.fourcc !== 'EXIF'); // quitar EXIF viejo si había
    const vp8x = list.find(c => c.fourcc === 'VP8X');

    if (vp8x) {
        vp8x.data[0] |= 0x08; // prender la bandera "tiene EXIF"
    } else {
        // WebP simple (VP8 / VP8L): hay que pasarlo a formato extendido (VP8X)
        const first = list[0];
        let width, height, hasAlpha = false;
        if (first && first.fourcc === 'VP8 ') {
            width = first.data.readUInt16LE(6) & 0x3fff;
            height = first.data.readUInt16LE(8) & 0x3fff;
        } else if (first && first.fourcc === 'VP8L') {
            const bits = first.data.readUInt32LE(1);
            width = (bits & 0x3fff) + 1;
            height = ((bits >>> 14) & 0x3fff) + 1;
            hasAlpha = ((bits >>> 28) & 1) === 1;
        } else {
            throw new Error('Formato WebP no reconocido');
        }
        const data = Buffer.alloc(10);
        data[0] = 0x08 | (hasAlpha ? 0x10 : 0);
        data.writeUIntLE(width - 1, 4, 3);
        data.writeUIntLE(height - 1, 7, 3);
        list.unshift({ fourcc: 'VP8X', data });
    }

    list.push({ fourcc: 'EXIF', data: exif });

    // Volver a armar el archivo
    const parts = [];
    for (const c of list) {
        const head = Buffer.alloc(8);
        head.write(c.fourcc, 0, 4, 'ascii');
        head.writeUInt32LE(c.data.length, 4);
        parts.push(head, c.data);
        if (c.data.length & 1) parts.push(Buffer.from([0]));
    }
    const body = Buffer.concat(parts);
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(4 + body.length, 4);
    riff.write('WEBP', 8, 'ascii');
    return Buffer.concat([riff, body]);
}

function runProc(cmd, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args);
        let out = '';
        let err = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.stderr.on('data', d => err += d.toString());
        proc.on('close', code => {
            if (code === 0) resolve({ out, err });
            else reject(new Error(err || out || `${cmd} salió con código ${code}`));
        });
        proc.on('error', e => reject(e));
    });
}

// Compone TODOS los frames de la animación en UNA SOLA llamada a ffmpeg,
// encadenando los overlay con "split" en vez de lanzar un proceso de ffmpeg
// por cada frame (que era lo que hacía todo muy lento: 45 frames = 45
// arranques de ffmpeg en fila, uno esperando al anterior). Aquí se arma un
// único filtergraph que va acumulando cada fragmento sobre el canvas
// anterior y saca cada paso intermedio como un archivo de salida distinto.
async function composeAllFrames(canvasPath, frames, framesDir) {
    const inputs = [canvasPath];
    const filterParts = [];
    const outputMaps = []; // { label, filename }
    let currentLabel = '0:v';
    let inputIndex = 1;

    for (let k = 0; k < frames.length; k++) {
        const fr = frames[k];
        const isLast = (k === frames.length - 1);
        const idx = String(fr.n).padStart(3, '0');

        if (fr.rawWebp) {
            const fragLabel = `${inputIndex}:v`;
            inputs.push(fr.rawWebp);
            inputIndex++;

            const fmtLabel = `fmt${fr.n}`;
            filterParts.push(`[${fragLabel}]format=rgba[${fmtLabel}]`);

            const ovLabel = `ov${fr.n}`;
            filterParts.push(`[${currentLabel}][${fmtLabel}]overlay=${fr.x}:${fr.y}[${ovLabel}]`);
            currentLabel = ovLabel;
        }
        // Si el frame no tiene fragmento (extracción fallida), currentLabel se
        // deja igual: ese frame simplemente repite el canvas anterior.

        if (!isLast) {
            const outLabel = `out${fr.n}`;
            const pipeLabel = `pipe${fr.n}`;
            filterParts.push(`[${currentLabel}]split=2[${outLabel}][${pipeLabel}]`);
            outputMaps.push({ label: outLabel, filename: path.join(framesDir, `frame${idx}.png`) });
            currentLabel = pipeLabel;
        } else {
            outputMaps.push({ label: currentLabel, filename: path.join(framesDir, `frame${idx}.png`) });
        }
    }

    const filterComplex = filterParts.join(';');

    const args = ['-y'];
    for (const inp of inputs) {
        args.push('-i', inp);
    }
    args.push('-filter_complex', filterComplex);
    for (const { label, filename } of outputMaps) {
        const mapArg = label === '0:v' ? '0:v' : `[${label}]`;
        args.push('-map', mapArg, '-update', '1', '-frames:v', '1', filename);
    }

    await runProc('ffmpeg', args);
}

async function createStickerFromMessage(m, sock, customPack = null, customAuthor = null) {
    let tmpInput = null;
    let tmpOutput = null;
    let framesDir = null;

    try {
        let normalizedMsg = normalizeMessageContent(m.message);
        const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;

        let mediaMsg = null;
        let mediaType = '';

        if (normalizedMsg?.imageMessage) {
            mediaMsg = normalizedMsg.imageMessage;
            mediaType = 'image';
        } else if (normalizedMsg?.videoMessage) {
            mediaMsg = normalizedMsg.videoMessage;
            mediaType = 'video';
        } else if (normalizedMsg?.stickerMessage) {
            mediaMsg = normalizedMsg.stickerMessage;
            mediaType = 'sticker';
        } else if (quotedMsg) {
            const normQuoted = normalizeMessageContent(quotedMsg);
            if (normQuoted?.imageMessage) {
                mediaMsg = normQuoted.imageMessage;
                mediaType = 'image';
            } else if (normQuoted?.videoMessage) {
                mediaMsg = normQuoted.videoMessage;
                mediaType = 'video';
            } else if (normQuoted?.stickerMessage) {
                mediaMsg = normQuoted.stickerMessage;
                mediaType = 'sticker';
            }
        }

        if (!mediaMsg) return null;

        const downloadType = mediaType === 'sticker' ? 'sticker' : mediaType;
        const stream = await downloadContentFromMessage(mediaMsg, downloadType);
        let mediaBuffer = Buffer.from([]);
        for await (const chunk of stream) {
            mediaBuffer = Buffer.concat([mediaBuffer, chunk]);
        }

        if (!mediaBuffer || mediaBuffer.length === 0) {
            throw new Error("Error al procesar el sticker");
        }

        const tempDir = path.join(__dirname, '../temp_stickers');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        // Detección de animación
        let isAnimated = mediaType === 'video';
        if (mediaType === 'sticker') {
            const hexContent = mediaBuffer.toString('hex');
            const asciiContent = mediaBuffer.toString('binary');
            if (
                hexContent.includes('616e6d66') ||
                hexContent.includes('616e696d') ||
                asciiContent.includes('ANMF') ||
                asciiContent.includes('ANIM')
            ) {
                isAnimated = true;
            }
        }

        const uniqueId = Date.now();
        tmpOutput = path.join(tempDir, `out_${uniqueId}.webp`);
        framesDir = path.join(tempDir, `frames_${uniqueId}`);

        // ==========================================
        // CARRIL 1: VIDEOS Y ANIMACIONES (GIFs / Stickers Animados)
        // ==========================================
        if (isAnimated) {
            if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

            let ext = mediaType === 'video' ? 'mp4' : 'webp';
            tmpInput = path.join(tempDir, `in_${uniqueId}.${ext}`);
            fs.writeFileSync(tmpInput, mediaBuffer);

            let frameDurationsSec = [];

            if (mediaType === 'sticker') {
                let info;
                try {
                    info = await runProc('webpmux', ['-info', tmpInput]);
                } catch (e) {
                    throw new Error('Falta "webpmux" (paquete libwebp) o el sticker está corrupto: ' + e.message);
                }

                const canvasMatch = info.out.match(/Canvas size:\s*(\d+)\s*x\s*(\d+)/i);
                const canvasW = canvasMatch ? parseInt(canvasMatch[1], 10) : 512;
                const canvasH = canvasMatch ? parseInt(canvasMatch[2], 10) : 512;

                const frameRows = [];
                const rowRegex = /^\s*(\d+):\s+(\d+)\s+(\d+)\s+(yes|no)\s+(\d+)\s+(\d+)\s+(\d+)\s+(none|background)\s+(yes|no)/gim;
                let rm;
                while ((rm = rowRegex.exec(info.out)) !== null) {
                    frameRows.push({
                        n: parseInt(rm[1], 10),
                        w: parseInt(rm[2], 10),
                        h: parseInt(rm[3], 10),
                        x: parseInt(rm[5], 10),
                        y: parseInt(rm[6], 10),
                        duration: parseInt(rm[7], 10),
                        dispose: rm[8].toLowerCase(),
                        blend: rm[9].toLowerCase() === 'yes'
                    });
                }

                if (frameRows.length === 0) {
                    throw new Error('No se pudo leer la tabla de frames de "webpmux -info"');
                }

                // Límite de seguridad para no crear stickers eternos
                const maxFrames = Math.min(frameRows.length, 45);
                const frames = frameRows.slice(0, maxFrames);

                // --- Fase 1: extraer solo los fragmentos crudos (en paralelo). Ya NO se
                // decodifican a PNG aquí uno por uno: eso se hace de un jalón en la fase 2. ---
                async function extractFragment(fr) {
                    const idx = String(fr.n).padStart(3, '0');
                    const rawWebp = path.join(framesDir, `raw_${idx}.webp`);
                    try {
                        await runProc('webpmux', ['-get', 'frame', String(fr.n), tmpInput, '-o', rawWebp]);
                        fr.rawWebp = rawWebp;
                    } catch (err) {
                        fr.rawWebp = null;
                    }
                }

                let cursor = 0;
                async function extractWorker() {
                    while (cursor < frames.length) {
                        const fr = frames[cursor++];
                        await extractFragment(fr);
                    }
                }
                await Promise.all(Array.from({ length: Math.min(FRAME_CONCURRENCY, frames.length) }, extractWorker));

                // Canvas base transparente. El "format=rgba" va DENTRO de la cadena del
                // filtro lavfi "color" (con comas) — si va como "-vf" aparte, el canal
                // alfa sale opaco en vez de transparente.
                const canvasPath = path.join(framesDir, 'canvas_000.png');
                await runProc('ffmpeg', [
                    '-y', '-f', 'lavfi',
                    '-i', `color=c=black@0.0:s=${canvasW}x${canvasH}:d=1,format=rgba`,
                    '-update', '1',
                    '-frames:v', '1',
                    canvasPath
                ]);

                // --- Fase 2: una sola llamada a ffmpeg compone TODOS los frames ---
                const anyFragment = frames.some(fr => fr.rawWebp);
                if (!anyFragment) {
                    throw new Error('Ningún frame del sticker se pudo decodificar');
                }
                await composeAllFrames(canvasPath, frames, framesDir);

                for (const fr of frames) {
                    if (fr.rawWebp && fs.existsSync(fr.rawWebp)) fs.unlinkSync(fr.rawWebp);
                    const ms = fr.duration > 0 ? fr.duration : 66;
                    frameDurationsSec.push(Math.min(Math.max(ms, 20), 2000) / 1000);
                }
            } else {
                // Videos / GIFs: ffmpeg lee el contenedor directamente sin problema
                await runProc('ffmpeg', [
                    '-y',
                    '-i', tmpInput,
                    '-vf', 'fps=15,format=yuva420p,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
                    '-t', '6',
                    path.join(framesDir, 'frame%03d.png')
                ]);
                const files = fs.readdirSync(framesDir).filter(f => /^frame\d+\.png$/.test(f));
                frameDurationsSec = files.map(() => 1 / 15);
            }

            const frameFiles = fs.readdirSync(framesDir)
                .filter(f => /^frame\d+\.png$/.test(f))
                .sort();

            const concatListPath = path.join(framesDir, 'concat_list.txt');
            let listContent = '';
            frameFiles.forEach((f, i) => {
                const dur = frameDurationsSec[i] ?? (1 / 15);
                listContent += `file '${f.replace(/'/g, "'\\''")}'\nduration ${dur.toFixed(3)}\n`;
            });
            if (frameFiles.length > 0) {
                listContent += `file '${frameFiles[frameFiles.length - 1].replace(/'/g, "'\\''")}'\n`;
            }
            fs.writeFileSync(concatListPath, listContent);

            await runProc('ffmpeg', [
                '-y',
                '-f', 'concat', '-safe', '0',
                '-i', concatListPath,
                '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p',
                '-vsync', 'vfr',
                '-loop', '0',
                '-c:v', 'libwebp',
                '-q:v', '80',
                '-compression_level', '2',
                '-pix_fmt', 'yuva420p',
                '-fs', '500k',
                tmpOutput
            ]);

        }
        // ==========================================
        // CARRIL 2: IMÁGENES Y STICKERS ESTÁTICOS
        // ==========================================
        else {
            const ext = mediaType === 'sticker' ? 'webp' : 'jpg';
            tmpInput = path.join(tempDir, `in_${uniqueId}.${ext}`);
            fs.writeFileSync(tmpInput, mediaBuffer);

            await runProc('ffmpeg', [
                '-y',
                '-i', tmpInput,
                '-vf', 'format=rgba,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1',
                '-c:v', 'libwebp',
                '-q:v', '85',
                '-compression_level', '2',
                '-fs', '500k',
                tmpOutput
            ]);
        }

        if (!fs.existsSync(tmpOutput) || fs.statSync(tmpOutput).size === 0) {
            throw new Error('Sticker vacío tras conversión');
        }

        const defaults = getStickerDefaults();
        const finalPack = customPack || defaults.pack;
        const finalAuthor = customAuthor || defaults.author;

        // Marca el sticker con el pack y autor (los de .sets o los que se pasen a mano)
        console.log(`[sticker] pack="${finalPack}" autor="${finalAuthor}"`);
        const finalBuffer = setWebpExif(
            fs.readFileSync(tmpOutput),
            buildWhatsAppExif(finalPack, finalAuthor)
        );

        if (tmpInput && fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
        if (tmpOutput && fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
        if (framesDir && fs.existsSync(framesDir)) {
            fs.rmSync(framesDir, { recursive: true, force: true });
        }

        if (!finalBuffer || finalBuffer.length === 0) {
            throw new Error('Sticker vacío tras conversión');
        }

        return finalBuffer;

    } catch (e) {
        if (tmpInput && fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
        if (tmpOutput && fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
        if (framesDir && fs.existsSync(framesDir)) {
            fs.rmSync(framesDir, { recursive: true, force: true });
        }
        console.error("Detalle del fallo en sticker:", e.message);
        throw new Error("Error al procesar el sticker");
    }
}

module.exports = { createStickerFromMessage, getStickerDefaults, setStickerDefaults };
