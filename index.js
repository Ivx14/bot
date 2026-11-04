const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, normalizeMessageContent } = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const yts = require('yt-search');
const ranks = require('./lib/ranks.cjs');
const { normalizeId } = ranks;
const { createStickerFromMessage, getStickerDefaults, setStickerDefaults } = require('./lib/stickers');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ROLE_ORDER = { user: 0, mod: 1, coowner: 2, owner: 3 };
const cleanNumber = (raw) => (raw ? raw.toString().split(':')[0].replace(/[^0-9]/g, '') : '');
const stickerIdsOf = (candidates) => [...new Set(candidates.map(cleanNumber).filter(Boolean))];

// De varias identidades de la misma persona, usa la que tenga el rango más alto
function bestIdentity(ids) {
    return ids.reduce((best, id) => (ROLE_ORDER[ranks.getRole(id)] > ROLE_ORDER[ranks.getRole(best)] ? id : best), ids[0]);
}

// Sinónimos -> nombre oficial del comando
const ALIASES = {
    setnombre: 'setname', quitarrol: 'delrole', silenciar: 'mute', desilenciar: 'unmute',
    cerrar: 'close', abrir: 'open', echar: 'kick', daradmin: 'promote', quitaradmin: 'demote',
    s: 'sticker', setstickers: 'sets', setsticker: 'sets', perfil: 'profile',
    setcumpleanos: 'setcumple', setgender: 'setgenero', help: 'menu', ayuda: 'menu',
    setdescmenu: 'setdbot', play: 'play', cancion: 'play', musica: 'play'
};
ranks.COMMANDS.menu = 'user';
ranks.COMMANDS.setdbot = 'owner';
ranks.COMMANDS.play = 'user'; // Comando de música disponible para todos

// ---- play: helpers ----
const MAX_PLAY_SECONDS = 15 * 60; // duración máxima permitida (WhatsApp limita el tamaño de los audios)

// Palabras de "relleno" que suelen traer los títulos de YouTube
const TITLE_NOISE = 'mtv|unplugged|official|oficial|video|vídeo|videoclip|clip|audio|lyrics?|letra|visuali[sz]er|remaster(?:ed)?|hd|hq|4k|en vivo|live|directo';

// Limpia el título que encontró en YouTube: quita "(MTV Unplugged)", "[Video Oficial]", "| Lyrics", etc.
function cleanSongInfo(rawTitle, rawAuthor = '') {
    const hasNoise = (s) => new RegExp(`\\b(?:${TITLE_NOISE})\\b`, 'i').test(s);
    const onlyNoise = (s) => !s.replace(new RegExp(`\\b(?:${TITLE_NOISE})\\b`, 'gi'), '').replace(/[^\p{L}]+/gu, '');
    const tidy = (s) => s
        .replace(/[(\[{]\s*[)\]}]/g, '')
        .replace(/\s*[-–—|:]+\s*$/, '')
        .replace(/^\s*[-–—|:]+\s*/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    const original = String(rawTitle || '').replace(/\s+/g, ' ').trim();
    let t = original;

    // 1) Quita (...), [...] o {...} que traigan relleno: (MTV Unplugged), [Video Oficial], (Official Audio)...
    t = t.replace(/[(\[{][^)\]}]*[)\]}]/g, (seg) => (hasNoise(seg) ? '' : seg));
    // 2) "MTV Unplugged" suelto, sin paréntesis
    t = tidy(t.replace(/\bmtv\s*unplugged\b/gi, ''));
    // 3) Relleno al final sin separador: "Luna Official Video", "Luna HD"
    t = tidy(t.replace(/\s+(?:official\s+(?:music\s+)?(?:video|audio|lyric\s+video)|video\s+oficial|audio\s+oficial|lyric\s+video|lyrics|letra|hd|hq|4k)\s*$/i, ''));

    // 4) Separa por " - ", " – ", " — " o " | " y descarta los trozos que sean puro relleno
    let parts = t.split(/\s+[-–—|]\s+/).map((s) => s.trim()).filter(Boolean);
    parts = parts.filter((s, i) => i === 0 || !onlyNoise(s));

    // El título queda tal como lo encontró (ya limpio), p. ej. "Zoé - Luna"
    const title = tidy(parts.join(' - ')) || original;

    // Solo si el título NO trae al artista, lo toma del canal (sin "VEVO", "- Topic", etc.)
    let artist = '';
    if (parts.length < 2) {
        artist = String(rawAuthor || '')
            .replace(/\s*-\s*topic$/i, '')
            .replace(/\s*vevo$/i, '')
            .replace(/\s*(?:official|oficial)(?:\s+(?:channel|canal))?$/i, '')
            .trim();
    }

    return { title, artist };
}

// Borra todos los archivos temporales de un audio (m4a, webm, .part, etc.)
function removeTempAudio(base) {
    try {
        const dir = path.dirname(base);
        const prefix = `${path.basename(base)}.`;
        for (const f of fs.readdirSync(dir)) {
            if (f.startsWith(prefix)) {
                try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
            }
        }
    } catch (_) {}
}
// ---- fin play: helpers ----

const idsOf = (x) => [x?.id, x?.phoneNumber, x?.jid, x?.lid].filter(Boolean).map(normalizeId).filter(Boolean);
const sameUser = (a, b) => a.some(i => b.includes(i));

const metaCache = new Map();
async function getMeta(sock, jid) {
    const hit = metaCache.get(jid);
    if (hit && Date.now() - hit.t < 30000) return hit.data;
    const data = await sock.groupMetadata(jid);
    metaCache.set(jid, { t: Date.now(), data });
    return data;
}

function getBotConfig() {
    const configPath = path.join(__dirname, 'lib', 'bot_config.json');
    let defaultConfig = {
        name: 'NovaBot',
        description: '🎗️ _"Tu vida es valiosa y este mundo\nes más brillante contigo en él. No\nestás solo/a, siempre hay alguien\ndispuesto a escucharte."_ 🎗️\n\n📞 *Línea de la Vida (México):*\n*800 911 2000* — gratuita, 24 horas'
    };
    if (fs.existsSync(configPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return {
                name: data.name || defaultConfig.name,
                description: data.description || defaultConfig.description
            };
        } catch (e) {
            return defaultConfig;
        }
    }
    return defaultConfig;
}

function parseBirthDate(inputStr) {
    const months = {
        "enero": "01", "febrero": "02", "marzo": "03", "abril": "04",
        "mayo": "05", "junio": "06", "julio": "07", "agosto": "08",
        "septiembre": "09", "setiembre": "09", "octubre": "10",
        "noviembre": "11", "diciembre": "12"
    };

    const cleanInput = inputStr.toLowerCase().trim();
    if (/^\d{1,2}\/\d{1,2}$/.test(cleanInput)) return cleanInput;

    const words = cleanInput.split(/\s+/);
    let day = "", monthNum = "";

    for (let word of words) {
        if (!day && !isNaN(word)) day = word.padStart(2, '0');
        else if (months[word]) monthNum = months[word];
    }

    if (day && monthNum) return `${day}/${monthNum}`;
    return inputStr;
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('sesion');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = await new Promise(resolve => {
            rl.question('\nPor favor ingresa tu número de WhatsApp del bot con código de país y lada: ', resolve);
        });

        setTimeout(async () => {
            let code = await sock.requestPairingCode(phoneNumber.trim());
            console.log(`\n> TU CÓDIGO DE EMPAREJAMIENTO ES: ${code}\n`);
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Reconectando...', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('\n¡Bot conectado exitosamente a WhatsApp!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        const normalizedFull = normalizeMessageContent(m.message);
        let body = '';

        if (normalizedFull?.conversation) body = normalizedFull.conversation;
        else if (normalizedFull?.extendedTextMessage) body = normalizedFull.extendedTextMessage.text;
        else if (normalizedFull?.imageMessage) body = normalizedFull.imageMessage.caption || '';
        else if (normalizedFull?.videoMessage) body = normalizedFull.videoMessage.caption || '';

        const sender = m.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        
        const senderCandidates = (isGroup
            ? [m.key.participantPn, m.key.participantAlt, m.key.participant]
            : [m.key.remoteJidAlt, m.key.senderPn, sender]
        ).filter(Boolean);
        if (isGroup && body.startsWith('.')) {
            try {
                const meta = await getMeta(sock, sender);
                const mine = senderCandidates.map(normalizeId).filter(Boolean);
                const me = meta.participants.find(p => sameUser(idsOf(p), mine));
                if (me) senderCandidates.push(...[me.phoneNumber, me.jid, me.id].filter(Boolean));
            } catch (e) {}
        }
        const senderJid = bestIdentity(senderCandidates);
        const rawSenderNumber = senderJid;
        const cleanSender = cleanNumber(senderJid);
        const role = ranks.getRole(senderJid);

        const configFilePath = path.join(__dirname, 'lib', 'config.json');
        let configData = {};
        if (fs.existsSync(configFilePath)) {
            try { configData = JSON.parse(fs.readFileSync(configFilePath, 'utf8')); } catch (e) { configData = {}; }
        }

        const muteFilePath = path.join(__dirname, 'lib', 'muted.json');
        let mutedData = {};
        if (fs.existsSync(muteFilePath)) {
            try { mutedData = JSON.parse(fs.readFileSync(muteFilePath, 'utf8')); } catch (e) { mutedData = {}; }
        }

        const isBotMutedInGroup = isGroup && mutedData[sender] === true;

        if (body.startsWith('.')) {
            const args = body.slice(1).trim().split(/ +/);
            const rawCommand = args.shift().toLowerCase();
            const command = ALIASES[rawCommand] || rawCommand;

            if (!Object.prototype.hasOwnProperty.call(ranks.COMMANDS, command)) return;

            console.log(`[cmd] .${command} | ids=${senderCandidates.map(normalizeId).join(',')} | rango=${role}`);
            const reply = (text, extra = {}) => sock.sendMessage(sender, { text, ...extra }, { quoted: m });
            const level = ranks.COMMANDS[command];
            const isOwnerOrCo = role === 'owner' || role === 'coowner';
            const isModPlus = isOwnerOrCo || role === 'mod';

            if (configData.allowedGroup && sender !== configData.allowedGroup && !isOwnerOrCo) return;
            if (isBotMutedInGroup && !isModPlus) return;

            let participants = [];
            let isGroupAdmin = false;
            let botIsAdmin = false;
            if (isGroup && level === 'admin') {
                try {
                    participants = (await getMeta(sock, sender)).participants;
                } catch (e) {
                    return await reply(`❌ Error al obtener la información del grupo.`);
                }
                const mine = senderCandidates.map(normalizeId).filter(Boolean);
                const me = participants.find(p => sameUser(idsOf(p), mine));
                isGroupAdmin = !!me && (me.admin === 'admin' || me.admin === 'superadmin');

                const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean).map(normalizeId);
                const bot = participants.find(p => sameUser(idsOf(p), botIds));
                botIsAdmin = !!bot && (bot.admin === 'admin' || bot.admin === 'superadmin');
            }

            const perm = ranks.check(command, { sender: senderJid, isGroup, isGroupAdmin });
            if (!perm.allowed) return await reply(perm.message);

            const ctx = m.message?.extendedTextMessage?.contextInfo;
            const mentioned = ctx?.mentionedJid || [];
            const quoted = ctx?.participant || null;

            const findTarget = () => {
                let raw = mentioned[0] || quoted || null;
                if (!raw) {
                    const num = args.map(a => a.replace(/[^0-9]/g, '')).find(a => a.length >= 7);
                    if (num) raw = num + '@s.whatsapp.net';
                }
                if (!raw) return null;
                const part = participants.find(p => sameUser(idsOf(p), [normalizeId(raw)]));
                return { raw, participant: part || null, id: part?.id || raw, roleJid: part?.phoneNumber || part?.jid || raw };
            };

            // ===== OWNER / CO-OWNER =====
            if (command === 'setname') {
                const newName = args.join(' ');
                if (!newName) return await reply(`⚠️ Debes escribir el nuevo nombre para el bot.\nEjemplo: \`.setname MiBotcito\``);
                const botConfig = getBotConfig();
                botConfig.name = newName;
                fs.writeFileSync(path.join(__dirname, 'lib', 'bot_config.json'), JSON.stringify(botConfig, null, 2));
                return await reply(`✅ ¡Nombre del bot actualizado con éxito a: *${newName}*! ✨`);
            }

            if (command === 'setdbot') {
                const newDesc = args.join(' ');
                if (!newDesc) return await reply(`⚠️ Debes escribir el nuevo contenido para la sección superior del menú.\nEjemplo: \`.setdbot Tu texto aquí 💖\``);
                const botConfig = getBotConfig();
                botConfig.description = newDesc;
                fs.writeFileSync(path.join(__dirname, 'lib', 'bot_config.json'), JSON.stringify(botConfig, null, 2));
                return await reply(`✅ ¡La sección superior del menú se ha actualizado por completo! ✨`);
            }

            if (command === 'group') {
                if (!isGroup) return await reply(`⚠️ Solo se puede usar dentro de un grupo.`);
                const option = args[0]?.toLowerCase();

                if (['disable', 'off', 'desactivar'].includes(option)) {
                    if (!configData.allowedGroup) return await reply(`ℹ️ El bot no tiene ningún grupo fijado actualmente.`);
                    if (configData.allowedGroup !== sender) return await reply(`⚠️ Este grupo no es el que está actualmente fijado.`);
                    configData.allowedGroup = null;
                    fs.writeFileSync(configFilePath, JSON.stringify(configData, null, 2));
                    return await reply(`🔓 *Grupo desvinculado con éxito.*`);
                }

                if (['enable', 'on', 'set', 'activar'].includes(option)) {
                    if (configData.allowedGroup && configData.allowedGroup !== sender) return await reply(`❌ El bot ya se encuentra fijado en otro grupo.`);
                    configData.allowedGroup = sender;
                    fs.writeFileSync(configFilePath, JSON.stringify(configData, null, 2));
                    return await reply(`✅ *¡Bot fijado exitosamente en este grupo!*`);
                }

                const statusText = configData.allowedGroup === sender ? `📌 *Estado:* Activo en este grupo.` : `📌 *Estado:* Libre o en otro grupo.`;
                return await reply(`${statusText}\n\n⚙️ *Uso:* \`.group enable\` / \`.group disable\``);
            }

            if (command === 'setrole' || command === 'delrole') {
                if (isGroup && participants.length === 0) {
                    try { participants = (await getMeta(sock, sender)).participants; } catch (e) {}
                }
                const t = findTarget();
                const r = command === 'setrole'
                    ? ranks.handleSetRole({ sender: senderJid, args, mentioned: t ? [t.roleJid] : [], quoted: null })
                    : ranks.handleDelRole({ sender: senderJid, args, mentioned: t ? [t.roleJid] : [], quoted: null });
                
                if (r.ok && t?.participant) {
                    const roleArg = args.map(a => a).find(a => ['coowner','co-owner','mod','user','usuario','moderador'].includes(a.toLowerCase().replace(/[\s_]/g, '')));
                    for (const alt of [t.participant.id, t.participant.phoneNumber, t.participant.jid].filter(Boolean)) {
                        if (normalizeId(alt) === normalizeId(t.roleJid)) continue;
                        if (command === 'setrole') ranks.handleSetRole({ sender: senderJid, args: [roleArg], mentioned: [alt] });
                        else ranks.handleDelRole({ sender: senderJid, args: [], mentioned: [alt] });
                    }
                }
                return await reply(r.text, { mentions: r.mentions });
            }

            // ===== MOD =====
            if (command === 'mute' || command === 'unmute') {
                if (!isGroup) return await reply(`⚠️ Solo en grupos.`);
                mutedData[sender] = (command === 'mute');
                fs.writeFileSync(muteFilePath, JSON.stringify(mutedData, null, 2));
                return await reply(mutedData[sender] ? `🔇 *BOT SILENCIADO*` : `🔊 *BOT REACTIVADO*`);
            }

            // ===== ADMIN DE GRUPO =====
            if (level === 'admin') {
                if (!botIsAdmin) return await reply(`❌ El bot necesita ser *Administrador* del grupo para ejecutar esta acción.`);

                if (command === 'close' || command === 'open') {
                    try {
                        await sock.groupSettingUpdate(sender, command === 'close' ? 'announcement' : 'not_announcement');
                        return await reply(command === 'close' ? `🔒 *GRUPO CERRADO*` : `🔓 *GRUPO ABIERTO*`);
                    } catch (err) {
                        return await reply(`❌ No se pudo ${command === 'close' ? 'cerrar' : 'abrir'} el grupo.`);
                    }
                }

                const t = findTarget();
                if (!t) return await reply(`⚠️ Debes mencionar o responder al usuario.`);
                if (!t.participant) return await reply(`❌ No se encontró al usuario en este grupo.`);

                const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean).map(normalizeId);
                if (sameUser(idsOf(t.participant), botIds) || botIds.includes(normalizeId(t.id))) {
                    return await reply(`❌ ¡No puedes hacerle eso al bot! 🤖✨`);
                }

                if (!ranks.canActOn(senderJid, t.roleJid)) return await reply(`⛔ No puedes hacer eso con ese usuario.`);

                const action = { kick: 'remove', promote: 'promote', demote: 'demote' }[command];
                const okMsg = { kick: `✅ Usuario expulsado exitosamente.`, promote: `✅ ¡Usuario promovido a Administrador!`, demote: `✅ Permisos de administrador retirados.` }[command];
                try {
                    await sock.groupParticipantsUpdate(sender, [t.id], action);
                    return await reply(okMsg);
                } catch (e) {
                    return await reply(`❌ No se pudo completar la acción.`);
                }
            }

            // ==========================================
            // 4. COMANDOS PARA TODOS (USUARIOS NORMALES)
            // ==========================================
            if (command === 'sets') {
                const userIds = stickerIdsOf(senderCandidates);
                const textArgs = args.join(' ');
                if (!textArgs.includes('|')) {
                    const mine = getStickerDefaults(userIds);
                    return await sock.sendMessage(sender, { text: `📌 *Tus stickers salen con:*\n✍️ Autor: *${mine.author}*\n📦 Pack: *${mine.pack}*\n\nPara cambiarlo: \`.sets Autor | Pack\`` }, { quoted: m });
                }

                const parts = textArgs.split('|');
                const newAuthor = parts[0]?.trim() || 'Bot';
                const newPack = parts[1]?.trim() || 'Sticker';

                try {
                    setStickerDefaults(userIds, newPack, newAuthor);
                } catch (e) {
                    return await sock.sendMessage(sender, { text: `❌ No pude guardar tu configuración.` }, { quoted: m });
                }

                return await sock.sendMessage(sender, { text: `✅ ¡Configuración guardada!\n✍️ Autor: *${newAuthor}*\n📦 Pack: *${newPack}*\n\nAhora todos tus stickers saldrán con esto.` }, { quoted: m });
            }

            if (command === 'sticker') {
                try {
                    let customAuthor = null;
                    let customPack = null;
                    const fullArgsText = args.join(' ');
                    if (fullArgsText.includes('|')) {
                        const parts = fullArgsText.split('|');
                        if (parts[0]) customAuthor = parts[0].trim();
                        if (parts[1]) customPack = parts[1].trim();
                    }

                    const defaults = getStickerDefaults(stickerIdsOf(senderCandidates));
                    const finalPack = customPack || defaults.pack;
                    const finalAuthor = customAuthor || defaults.author;

                    const stickerBuffer = await createStickerFromMessage(m, sock, finalPack, finalAuthor);
                    if (!stickerBuffer) return;

                    await sock.sendMessage(sender, { sticker: stickerBuffer, mimetype: 'image/webp' }, { quoted: m });
                    return;
                } catch (e) {
                    return await sock.sendMessage(sender, { text: e.message || "Error al procesar el sticker" }, { quoted: m });
                }
            }

            if (command === 'play') {
                const query = args.join(' ');
                if (!query) {
                    return await sock.sendMessage(sender, { text: `⚠️ ¿Qué canción quieres buscar?\nEjemplo: \`.play luna zoe\`` }, { quoted: m });
                }

                try {
                    const searchResult = await yts(query);
                    if (!searchResult || !searchResult.videos.length) {
                        return await sock.sendMessage(sender, { text: `❌ No encontré ningún resultado para: *${query}*` }, { quoted: m });
                    }

                    const video = searchResult.videos[0];
                    const { title, artist } = cleanSongInfo(video.title, video.author?.name);
                    const duration = video.timestamp;

                    if (video.seconds > MAX_PLAY_SECONDS) {
                        return await sock.sendMessage(sender, {
                            text: `⚠️ *${title}* dura ${duration} y el máximo permitido es ${MAX_PLAY_SECONDS / 60} min.`
                        }, { quoted: m });
                    }

                    await sock.sendMessage(sender, {
                        text: [
                            `🎶 *¡Canción encontrada!*`,
                            ``,
                            `📌 *Título:* ${title}`,
                            artist ? `🎤 *Artista:* ${artist}` : null,
                            `⏱️ *Duración:* ${duration}`,
                            ``,
                            `⏳ Enviando audio...`
                        ].filter((line) => line !== null).join('\n')
                    }, { quoted: m });

                    // m4a (AAC) es el formato que WhatsApp reproduce sin problemas como audio
                    const outputBase = path.join(__dirname, `audio_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
                    const audioPath = `${outputBase}.m4a`;
                    const ytArgs = [
                        '-f', 'bestaudio[ext=m4a]/bestaudio',
                        '-x', '--audio-format', 'm4a',
                        '--no-playlist', '--restrict-filenames',
                        '-o', `${outputBase}.%(ext)s`,
                        video.url
                    ];

                    execFile('yt-dlp', ytArgs, { timeout: 3 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }, async (error) => {
                        try {
                            if (error || !fs.existsSync(audioPath)) {
                                console.error("Error de yt-dlp:", error?.message || 'no se generó el archivo');
                                return await sock.sendMessage(sender, { text: `❌ Ocurrió un error al descargar el audio.` }, { quoted: m });
                            }

                            await sock.sendMessage(sender, {
                                audio: fs.readFileSync(audioPath),
                                mimetype: 'audio/mp4',
                                ptt: false,
                                seconds: video.seconds
                            }, { quoted: m });
                        } catch (sendErr) {
                            console.error("Error al enviar el audio:", sendErr);
                            await sock.sendMessage(sender, { text: `❌ Ocurrió un error al enviar el audio.` }, { quoted: m }).catch(() => {});
                        } finally {
                            removeTempAudio(outputBase);
                        }
                    });

                } catch (e) {
                    console.error("Error en comando play:", e);
                    return await sock.sendMessage(sender, { text: `❌ Ocurrió un error al procesar tu solicitud.` }, { quoted: m });
                }
            }

            if (command === 'menu') {
                let pushName = m.pushName || "Usuario";
                let botConfig = getBotConfig();

                const formattedDescription = botConfig.description
                    .split('\n')
                    .map(line => `┃ ${line}`)
                    .join('\n');

                const menuText =
                    `╭━━━〔 🌸 ¡Hola! Soy *${botConfig.name}* 🌸 〕━━━╮\n` +
                    `┃\n` +
                    `${formattedDescription}\n` +
                    `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +

                    `(◕ω◕) ¡Qué bueno verte, *${pushName}*!\n` +
                    `👑 Tu rango: *${ranks.ROLE_NAMES[role].toUpperCase()}*\n\n` +

                    `╭━━━〔 👥 *USUARIOS NORMALES* 👥 〕━━━╮\n` +
                    `┃ • \`.s\` / \`.sticker\` ➔ Crea sticker ✨\n` +
                    `┃ • \`.play [canción]\` ➔ Descarga música 🎵\n` +
                    `┃ • \`.sets\` ➔ Fija autor y pack 📌\n` +
                    `┃ • \`.profile\` ➔ Ver tu perfil (o de otro) 👤\n` +
                    `┃ • \`.setdesc\` ➔ Cambiar biografía 💬\n` +
                    `┃ • \`.setpais\` ➔ Configurar país 🌍\n` +
                    `┃ • \`.setcumple\` ➔ Guardar cumpleaños 🎂\n` +
                    `┃ • \`.setgenero\` ➔ Elegir género 🍥\n` +
                    `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +

                    `╭━━━〔 🛡️ *ADMINISTRACIÓN DE GRUPOS* 🛡️ 〕━━━╮\n` +
                    `┃ • \`.close\` / \`.cerrar\` ➔ Cierra el grupo 🔒\n` +
                    `┃ • \`.open\` / \`.abrir\` ➔ Abre el grupo 🔓\n` +
                    `┃ • \`.kick\` ➔ Expulsa a un usuario (ง︡'-'︠)ง\n` +
                    `┃ • \`.promote\` ➔ Da admin a usuario ⭐\n` +
                    `┃ • \`.demote\` ➔ Quita admin a usuario 🔻\n` +
                    `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +

                    `╭━━━〔 ⚡ *MODERACIÓN* ⚡ 〕━━━╮\n` +
                    `┃ • \`.mute\` ➔ Silencia respuestas del bot 🔇\n` +
                    `┃ • \`.unmute\` ➔ Reactiva al bot 🔊\n` +
                    `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +

                    `╭━━━〔 ⚙️ *SISTEMA (OWNER)* ⚙️ 〕━━━╮\n` +
                    `┃ • \`.setname [nombre]\` ➔ Cambiar nombre 🏷️\n` +
                    `┃ • \`.setdbot [texto]\` ➔ Cambiar bloque superior 💬\n` +
                    `┃ • \`.group enable/disable\` ➔ Fijar bot 📌\n` +
                    `┃ • \`.setrole\` ➔ Asignar rangos 👑\n` +
                    `┃ • \`.delrole\` ➔ Quitar rangos ❌\n` +
                    `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                    `> (つ✧ω✧)つ _¡Disfruta usando el bot!_`;

                let menuPicUrl;
                try { menuPicUrl = await sock.profilePictureUrl(sock.user.id, 'image'); } catch { menuPicUrl = 'https://i.ibb.co/1Z23xhx/default-avatar.png'; }

                return await sock.sendMessage(sender, { image: { url: menuPicUrl }, caption: menuText }, { quoted: m });
            }

            if (command === 'profile') {
                let targetNumber = rawSenderNumber;
                let targetClean = cleanSender;

                const contextInfo = m.message.extendedTextMessage?.contextInfo;
                if (contextInfo?.participant) {
                    targetNumber = contextInfo.participant;
                    targetClean = cleanNumber(targetNumber);
                } else if (contextInfo?.mentionedJid?.[0]) {
                    targetNumber = contextInfo.mentionedJid[0];
                    targetClean = cleanNumber(targetNumber);
                } else if (args[0]) {
                    targetClean = args[0].replace(/[^0-9]/g, '');
                    targetNumber = targetClean + '@s.whatsapp.net';
                }

                const targetRole = ranks.getRole(targetNumber);
                const usersFilePath = path.join(__dirname, 'lib', 'users.json');
                let usersData = fs.existsSync(usersFilePath) ? JSON.parse(fs.readFileSync(usersFilePath, 'utf8')) : {};
                const profile = usersData[targetClean] || { cumpleanos: "0/0", descripcion: "¡Hola!", pais: "No especificado", genero: "No definido" };

                let pic;
                try { pic = await sock.profilePictureUrl(targetNumber, 'image'); } catch { pic = 'https://i.ibb.co/1Z23xhx/default-avatar.png'; }

                const text = `🌸 *PERFIL*\n\n👤 Usuario: @${targetClean}\n👑 Rango: ${ranks.ROLE_NAMES[targetRole].toUpperCase()}\n💬 Bio: _${profile.descripcion}_\n🎂 Cumpleaños: ${profile.cumpleanos}\n🌍 País: ${profile.pais}\n🍥 Género: ${profile.genero}`;

                return await sock.sendMessage(sender, { image: { url: pic }, caption: text, mentions: [targetNumber] }, { quoted: m });
            }

            if (command === 'setdesc') {
                const newDesc = args.join(' ');
                if (!newDesc) return await sock.sendMessage(sender, { text: `⚠️ Uso: \`.setdesc [biografía]\`` }, { quoted: m });
                const usersFilePath = path.join(__dirname, 'lib', 'users.json');
                let usersData = fs.existsSync(usersFilePath) ? JSON.parse(fs.readFileSync(usersFilePath, 'utf8')) : {};
                if (!usersData[cleanSender]) usersData[cleanSender] = { cumpleanos: "0/0", pais: "No especificado", genero: "No definido" };
                usersData[cleanSender].descripcion = newDesc;
                fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2));
                return await sock.sendMessage(sender, { text: `✅ ¡Descripción actualizada!` }, { quoted: m });
            }

            if (command === 'setpais') {
                const newPais = args.join(' ');
                if (!newPais) return await sock.sendMessage(sender, { text: `⚠️ Uso: \`.setpais [país]\`` }, { quoted: m });
                const usersFilePath = path.join(__dirname, 'lib', 'users.json');
                let usersData = fs.existsSync(usersFilePath) ? JSON.parse(fs.readFileSync(usersFilePath, 'utf8')) : {};
                if (!usersData[cleanSender]) usersData[cleanSender] = { cumpleanos: "0/0", descripcion: "¡Hola!", genero: "No definido" };
                usersData[cleanSender].pais = newPais;
                fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2));
                return await sock.sendMessage(sender, { text: `✅ ¡País actualizado!` }, { quoted: m });
            }

            if (command === 'setcumple') {
                const rawCumple = args.join(' ');
                if (!rawCumple) return await sock.sendMessage(sender, { text: `⚠️ Uso: \`.setcumple [fecha]\`` }, { quoted: m });
                const formattedDate = parseBirthDate(rawCumple);
                const usersFilePath = path.join(__dirname, 'lib', 'users.json');
                let usersData = fs.existsSync(usersFilePath) ? JSON.parse(fs.readFileSync(usersFilePath, 'utf8')) : {};
                if (!usersData[cleanSender]) usersData[cleanSender] = { descripcion: "¡Hola!", pais: "No especificado", genero: "No definido" };
                usersData[cleanSender].cumpleanos = formattedDate;
                fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2));
                return await sock.sendMessage(sender, { text: `✅ ¡Cumpleaños guardado como ${formattedDate}!` }, { quoted: m });
            }

            if (command === 'setgenero') {
                const inputGen = args[0]?.toLowerCase();
                let selectedGender = "";
                if (inputGen === 'mujer') selectedGender = "Mujer 🌸";
                else if (inputGen === 'hombre') selectedGender = "Hombre 🦇";
                else if (inputGen === 'nodefinido' || inputGen === 'no') selectedGender = "No definido 🍥";
                if (!selectedGender) return await sock.sendMessage(sender, { text: `⚠️ Opciones: Mujer, Hombre, No definido` }, { quoted: m });

                const usersFilePath = path.join(__dirname, 'lib', 'users.json');
                let usersData = fs.existsSync(usersFilePath) ? JSON.parse(fs.readFileSync(usersFilePath, 'utf8')) : {};
                if (!usersData[cleanSender]) usersData[cleanSender] = { cumpleanos: "0/0", descripcion: "¡Hola!", pais: "No especificado" };
                usersData[cleanSender].genero = selectedGender;
                fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2));
                return await sock.sendMessage(sender, { text: `✅ ¡Género actualizado a ${selectedGender}!` }, { quoted: m });
            }
        }
    });
}

startBot();
