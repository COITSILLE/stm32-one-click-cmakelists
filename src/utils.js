const path = require('path');
const crypto = require('crypto');

const HEADER_FILE_EXT_PATTERN = /\.(h|hh|hpp|hxx)$/i;
const SOURCE_FILE_EXT_PATTERN = /\.(c|cpp|cc|cxx)$/i;
const REBUILD_SCAN_IGNORED_DIR_NAMES = new Set(['.git', '.vscode', 'build', 'dist', 'cmake_manager_gen']);

/**
 * @param {string} value
 * @returns {string}
 */
function sha1(value) {
    return crypto.createHash('sha1').update(value).digest('hex');
}

/**
 * @param {Buffer[]} chunks
 * @returns {string}
 */
function sha1Buffers(chunks) {
    const hasher = crypto.createHash('sha1');
    for (const chunk of chunks) {
        hasher.update(chunk);
    }
    return hasher.digest('hex');
}

/**
 * @param {string} relPath
 * @returns {string}
 */
function normalizeRelPath(relPath) {
    return relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

/**
 * @param {any} value
 * @returns {any[]}
 */
function flattenArgs(value) {
    if (!Array.isArray(value)) return [value];
    if (value.length === 1 && Array.isArray(value[0])) return value[0];
    if (value.length >= 2 && Array.isArray(value[1])) return [value[0], ...value[1]];
    return value;
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function normalizeAndSortUnique(values) {
    return Array.from(new Set((Array.isArray(values) ? values : [])
        .map(normalizeRelPath)
        .filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string[]} current
 * @param {string[]} next
 * @returns {{added: string[], removed: string[]}}
 */
function diffStringLists(current, next) {
    const currentSet = new Set(current);
    const nextSet = new Set(next);
    const added = next.filter(item => !currentSet.has(item));
    const removed = current.filter(item => !nextSet.has(item));
    return { added, removed };
}

/**
 * @param {string[]} values
 * @param {number} maxItems
 * @returns {string}
 */
function formatPreviewItems(values, maxItems = 4) {
    if (!values || values.length === 0) return '(none)';
    const preview = values.slice(0, maxItems).join(', ');
    const suffix = values.length > maxItems ? ` ... (+${values.length - maxItems})` : '';
    return preview + suffix;
}

/**
 * @param {string} absDir
 * @returns {boolean}
 */
function hasHeaderFileInCurrentDir(absDir) {
    const fs = require('fs');
    let entries = [];
    try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
        return false;
    }
    return entries.some(entry => entry.isFile() && HEADER_FILE_EXT_PATTERN.test(entry.name));
}

module.exports = {
    HEADER_FILE_EXT_PATTERN,
    SOURCE_FILE_EXT_PATTERN,
    REBUILD_SCAN_IGNORED_DIR_NAMES,
    sha1,
    sha1Buffers,
    normalizeRelPath,
    flattenArgs,
    normalizeAndSortUnique,
    diffStringLists,
    formatPreviewItems,
    hasHeaderFileInCurrentDir
};
