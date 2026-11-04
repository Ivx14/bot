'use strict';
/**
 * ranks.cjs — rangos y permisos de comandos para el bot
 *
 * Rangos (de mayor a menor): owner > coowner > mod > user
 * "Admin de grupo" no es un rango guardado: se lo pasas en cada mensaje (isGroupAdmin).
 *
 * USO — en tu handler, antes de ejecutar cualquier comando:
 *
 *   const ranks = require('./ranks.cjs');       // con ESM: import ranks from './ranks.cjs'
 *
 *   const p = ranks.check(comando, {            // comando sin el punto: 'kick', 'mute'...
 *     sender,                                   // JID de quien escribe
 *     isGroup,                                  // true si el mensaje viene de un grupo
 *     isGroupAdmin,                             // true si quien escribe es admin de ESE grupo
 *   });
 *   if (!p.allowed) return reply(p.message);
 *
 *   // Dentro de tus comandos .setrole y .delrole:
 *   const r = ranks.handleSetRole({ sender, args, mentioned, quoted });  // o handleDelRole
 *   reply(r.text, { mentions: r.mentions });
 *   //   args: palabras después del comando · mentioned: JIDs mencionados
 *   //   quoted: JID de quien escribió el mensaje al que respondes
 *
 *   // Dentro de .kick / .mute / .demote, para que nadie sancione a un rango superior:
 *   if (!ranks.canActOn(sender, objetivo)) return reply('⛔ No puedes hacer eso con ese usuario.');
 *
 * El rango se consulta en CADA comando (sin caché): si le das o le quitas un rango a alguien,
 * el cambio aplica en su siguiente mensaje.
 */

const fs = require('fs');
const path = require('path');

// ───────────────────────── CONFIGURACIÓN ─────────────────────────
const CONFIG = {
  // Owner fijo. Nadie puede quitarlo ni asignar este rango con .setrole.
  // Si tu librería entrega los ids como "xxxx@lid" y no te reconoce, agrega ese id aquí también.
  owners: ['526144539035'],

  // Aquí se guardan los rangos asignados (co-owner y mod). RANKS_DB solo se usa para pruebas.
  dbPath: process.env.RANKS_DB || path.join(__dirname, 'roles.json'),

  // Qué pasa con los comandos que NO están en COMMANDS:
  // 'owner' = solo Owner/Co-owner (más seguro) · 'user' = cualquiera puede usarlos
  unlisted: 'owner',
};

// Nivel requerido por comando (sin el punto):
//   'owner' → solo Owner y Co-owner
//   'mod'   → Mod, Co-owner y Owner
//   'admin' → admin del grupo (Owner y Co-owner pasan aunque no sean admin)
//   'user'  → cualquiera
const COMMANDS = {
  // Owner / Co-owner
  setname: 'owner',
  group: 'owner',
  setrole: 'owner',
  delrole: 'owner',

  // Mod
  mute: 'mod',
  unmute: 'mod',

  // Admin de grupo (un Mod solo puede usarlos si además es admin del grupo)
  close: 'admin',
  open: 'admin',
  kick: 'admin',
  promote: 'admin',
  demote: 'admin',

  // Usuarios
  sticker: 'user',
  profile: 'user',
  sets: 'user',
  setdesc: 'user',
  setpais: 'user',
  setcumple: 'user',
  setgenero: 'user',
};

// ───────────────────────── RANGOS ─────────────────────────
const RANK = { user: 0, mod: 1, coowner: 2, owner: 3 };
const ROLE_NAMES = { user: 'Usuario', mod: 'Mod', coowner: 'Co-owner', owner: 'Owner' };
const ROLE_ALIASES = new Map([
  ['owner', 'owner'],
  ['coowner', 'coowner'],
  ['mod', 'mod'],
  ['moderador', 'mod'],
  ['user', 'user'],
  ['usuario', 'user'],
]);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// "co-owner", "Co_Owner" y "coowner" son lo mismo
function parseRole(text) {
  return ROLE_ALIASES.get(String(text ?? '').toLowerCase().replace(/[\s_-]/g, '')) || null;
}

// ───────────────────────── IDS (JID / número) ─────────────────────────
// Deja solo el número: quita "@s.whatsapp.net", el sufijo de dispositivo (":12"), "+", espacios, etc.
// Números de México: 521XXXXXXXXXX y 52XXXXXXXXXX se tratan como la misma persona.
function normalizeId(raw) {
  const s = String(raw ?? '').trim().replace(/^@/, '');
  if (!s) return '';
  const [left, server = ''] = s.split('@');
  let digits = left.split(/[:_]/)[0].replace(/\D/g, '');
  if (!digits) return '';
  if (server === 'lid') return `${digits}@lid`;
  if (digits.length === 13 && digits.startsWith('521')) digits = `52${digits.slice(3)}`;
  return digits;
}

// JID completo, para usarlo en "mentions"
function toJid(raw) {
  const s = String(raw ?? '').trim().replace(/^@/, '');
  if (s.includes('@')) return s.replace(/:\d+(?=@)/, '');
  return `${s.replace(/\D/g, '')}@s.whatsapp.net`;
}

// ───────────────────────── ALMACÉN ─────────────────────────
const OWNERS = new Set(CONFIG.owners.map(normalizeId).filter(Boolean));

// Del archivo solo se aceptan 'coowner' y 'mod': así nadie se vuelve Owner editando el JSON.
function sanitize(data) {
  const clean = {};
  if (!data || typeof data !== 'object') return clean;
  for (const [key, value] of Object.entries(data)) {
    // Formato viejo: { "coowner": ["52..."], "mod": ["52..."] } (el "owner" del archivo se ignora)
    if (Array.isArray(value)) {
      if (key !== 'coowner' && key !== 'mod') continue;
      for (const raw of value) {
        const id = normalizeId(raw);
        if (id && !OWNERS.has(id)) clean[id] = key;
      }
      continue;
    }
    const id = normalizeId(key);
    if (id && !OWNERS.has(id) && (value === 'coowner' || value === 'mod')) clean[id] = value;
  }
  return clean;
}

function load() {
  if (!fs.existsSync(CONFIG.dbPath)) return {};
  try {
    return sanitize(JSON.parse(fs.readFileSync(CONFIG.dbPath, 'utf8')));
  } catch (err) {
    try { fs.copyFileSync(CONFIG.dbPath, `${CONFIG.dbPath}.corrupto`); } catch (_) { /* nada */ }
    console.error(`[ranks] No pude leer ${CONFIG.dbPath}; dejé una copia en .corrupto y empiezo sin rangos.`);
    return {};
  }
}

let roles = load(); // { '52614…': 'mod', '52999…': 'coowner' }

// Escribe a un archivo temporal y lo renombra: si el bot se cae a media escritura, el JSON no queda roto.
function commit(next) {
  fs.mkdirSync(path.dirname(CONFIG.dbPath), { recursive: true });
  const tmp = `${CONFIG.dbPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, CONFIG.dbPath);
  roles = next;
}

// ───────────────────────── CONSULTAS ─────────────────────────
function getRole(jid) {
  const id = normalizeId(jid);
  if (!id) return 'user';
  if (OWNERS.has(id)) return 'owner';
  return hasOwn(roles, id) ? roles[id] : 'user';
}

const rankOf = (jid) => RANK[getRole(jid)];

// ───────────────────────── PERMISOS ─────────────────────────
function check(command, { sender, isGroup = false, isGroupAdmin = false } = {}) {
  const cmd = String(command ?? '').trim().toLowerCase().replace(/^\./, '');
  const level = hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : CONFIG.unlisted;
  const role = getRole(sender);
  const rank = RANK[role];
  const allow = { allowed: true, role, message: '' };
  const deny = (message) => ({ allowed: false, role, message });

  if (level === 'admin' && !isGroup) return deny('Este comando solo funciona en grupos.');
  if (rank >= RANK.coowner) return allow; // Owner y Co-owner: sin restricciones
  if (level === 'user') return allow;
  if (level === 'mod') {
    return rank >= RANK.mod ? allow : deny('⛔ Este comando es solo para Mods, Co-owners y el Owner.');
  }
  if (level === 'admin') {
    // El rango Mod NO da permiso de admin: tiene que ser admin del grupo.
    return isGroupAdmin ? allow : deny('⛔ Necesitas ser admin del grupo para usar este comando.');
  }
  return deny('⛔ Este comando es solo para el Owner y los Co-owners.');
}

// ¿Puede `actor` aplicarle una acción (.kick, .mute, .demote…) a `target`?
//  - A un usuario normal: sí (el permiso del comando ya lo filtró `check`).
//  - Al Owner: nadie, salvo él mismo (así puede darse admin con .promote).
//  - Owner y Co-owner: pueden con Mods y Co-owners.
//  - Mod: solo con rangos menores al suyo.
function canActOn(actor, target) {
  const a = rankOf(actor);
  const t = rankOf(target);
  if (t === RANK.user) return true;
  if (t === RANK.owner) return normalizeId(actor) === normalizeId(target);
  if (a >= RANK.coowner) return true;
  return a > t;
}

// ───────────────────────── GESTIÓN DE RANGOS (.setrole / .delrole) ─────────────────────────
function setRole(actor, target, roleName) {
  const fail = (text) => ({ ok: false, text, mentions: [] });

  // Se vuelve a validar aquí aunque `check` ya lo haya filtrado.
  if (rankOf(actor) < RANK.coowner) return fail('⛔ Solo el Owner y los Co-owners pueden gestionar rangos.');

  const role = parseRole(roleName);
  if (!role) return fail('Rango inválido. Usa: coowner, mod o user.');
  if (role === 'owner') return fail('⛔ El rango Owner no se puede asignar.');

  const id = normalizeId(target);
  if (!id) return fail('No pude identificar al usuario.');
  if (OWNERS.has(id)) return fail('⛔ El rango del Owner no se puede modificar.');

  const before = getRole(id);
  const jid = toJid(target);
  const who = `@${jid.split('@')[0]}`;
  const done = (text) => ({ ok: true, text, mentions: [jid] });

  if (before === role) return done(`ℹ️ ${who} ya es ${ROLE_NAMES[role]}.`);

  const next = { ...roles };
  if (role === 'user') delete next[id];
  else next[id] = role;
  commit(next);

  return role === 'user'
    ? done(`✅ ${who} volvió a ser Usuario y ya no puede usar los comandos de ${ROLE_NAMES[before]}.`)
    : done(`✅ ${who} ahora es ${ROLE_NAMES[role]}.`);
}

const delRole = (actor, target) => setRole(actor, target, 'user');

// El objetivo puede venir como mención, respondiendo a su mensaje, o escribiendo su número (sin espacios).
function pickTarget({ args = [], mentioned = [], quoted = null }) {
  if (mentioned && mentioned.length) return mentioned[0];
  if (quoted) return quoted;
  return args.map(String).find((a) => /^@?\+?\d{7,}$/.test(a.trim())) || null;
}

// .setrole @usuario <coowner|mod|user>   ·   o respondiendo a su mensaje: .setrole mod
function handleSetRole({ sender, args = [], mentioned = [], quoted = null } = {}) {
  const target = pickTarget({ args, mentioned, quoted });
  const role = args.map((a) => parseRole(a)).find(Boolean);
  if (!target || !role) {
    return {
      ok: false,
      text: 'Uso: .setrole @usuario <coowner|mod|user>\nO responde a su mensaje con: .setrole mod',
      mentions: [],
    };
  }
  return setRole(sender, target, role);
}

// .delrole @usuario   ·   o respondiendo a su mensaje: .delrole
function handleDelRole({ sender, args = [], mentioned = [], quoted = null } = {}) {
  const target = pickTarget({ args, mentioned, quoted });
  if (!target) {
    return { ok: false, text: 'Uso: .delrole @usuario\nO responde a su mensaje con: .delrole', mentions: [] };
  }
  return delRole(sender, target);
}

module.exports = {
  ROLE_NAMES,
  check,
  canActOn,
  getRole,
  setRole,
  delRole,
  handleSetRole,
  handleDelRole,
  normalizeId,
  COMMANDS, // puedes agregar comandos aquí: ranks.COMMANDS.menu = 'user'
};
