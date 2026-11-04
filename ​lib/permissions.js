const fs = require('fs');
const path = require('path');

// Tu número registrado como Dueña/Owner principal (México)
const primaryOwner = "526144539035";
const primaryOwner10Digits = "6144539035"; 

function cleanNumber(raw) {
    if (!raw) return '';
    return raw.toString().split(':')[0].replace(/[^0-9]/g, '');
}

function mxVariants(num) {
    const variants = new Set([num]);
    if (num.startsWith('521') && num.length === 13) {
        variants.add('52' + num.slice(3));
    } else if (num.startsWith('52') && num.length === 12) {
        variants.add('521' + num.slice(2));
    }
    return [...variants];
}

function isOwnerNumber(rawNumber) {
    if (!rawNumber) return false;
    const clean = cleanNumber(rawNumber);
    if (!clean) return false;

    const ownerVariants = mxVariants(primaryOwner);
    const senderVariants = mxVariants(clean);

    return ownerVariants.some(ov => senderVariants.includes(ov)) || clean.endsWith(primaryOwner10Digits);
}

function getUserRole(senderNumber) {
    if (!senderNumber) return 'usuario';

    if (isOwnerNumber(senderNumber)) {
        return 'owner';
    }

    const cleanSender = cleanNumber(senderNumber);
    const rolesFilePath = path.join(__dirname, 'roles.json');

    let rolesData = { owner: [], coowner: [], mod: [] };
    if (fs.existsSync(rolesFilePath)) {
        try {
            rolesData = JSON.parse(fs.readFileSync(rolesFilePath, 'utf8'));
        } catch (e) {}
    }

    if (Array.isArray(rolesData.owner) && rolesData.owner.some(n => isOwnerNumber(n))) {
        return 'owner';
    }

    if (Array.isArray(rolesData.coowner) && rolesData.coowner.some(n => cleanNumber(n) === cleanSender)) {
        return 'co-owner';
    }

    if (Array.isArray(rolesData.mod) && rolesData.mod.some(n => cleanNumber(n) === cleanSender)) {
        return 'mod';
    }

    return 'usuario';
}

function hasModOrHigher(role) {
    const r = (role || '').toLowerCase();
    return r === 'owner' || r === 'co-owner' || r === 'mod';
}

function hasOwnerOrCoOwner(role) {
    const r = (role || '').toLowerCase();
    return r === 'owner' || r === 'co-owner';
}

function isOwner(role) {
    return (role || '').toLowerCase() === 'owner';
}

module.exports = { getUserRole, hasModOrHigher, hasOwnerOrCoOwner, isOwner, cleanNumber, isOwnerNumber };
