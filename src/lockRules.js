const path = require('path');
const { normalizeRelPath } = require('./utils.js');

const LOCK_DIR_MODE_EXACT = 'exact';
const LOCK_DIR_MODE_RECURSIVE = 'recursive';

/**
 * @param {'exact'|'recursive'|string|undefined} mode
 * @returns {'exact'|'recursive'}
 */
function normalizeLockMode(mode) {
    return mode === LOCK_DIR_MODE_EXACT ? LOCK_DIR_MODE_EXACT : LOCK_DIR_MODE_RECURSIVE;
}

/**
 * @param {any} entry
 * @returns {{path: string, mode: 'exact'|'recursive', group: string} | null}
 */
function normalizeLockRuleEntry(entry) {
    if (typeof entry === 'string') {
        const normalizedPath = normalizeRelPath(entry);
        if (!normalizedPath) return null;
        return {
            path: normalizedPath,
            mode: LOCK_DIR_MODE_RECURSIVE,
            group: 'User'
        };
    }

    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
        return null;
    }

    const normalizedPath = normalizeRelPath(entry.path);
    if (!normalizedPath) return null;

    return {
        path: normalizedPath,
        mode: normalizeLockMode(entry.mode),
        group: typeof entry.group === 'string' && entry.group.trim() ? entry.group.trim() : 'User'
    };
}

/**
 * @param {string} relPath
 * @param {{path: string, mode: 'exact'|'recursive'}} rule
 * @returns {boolean}
 */
function matchesLockRuleForFile(relPath, rule) {
    const normalized = normalizeRelPath(relPath || '');
    if (!normalized) return false;
    if (rule.mode === LOCK_DIR_MODE_RECURSIVE) {
        return normalized === rule.path || normalized.startsWith(`${rule.path}/`);
    }
    // exact mode: match the file path itself or its parent directory
    const parentDir = normalizeRelPath(path.posix.dirname(normalized));
    const normalizedParent = parentDir === '.' ? '' : parentDir;
    return normalized === rule.path || normalizedParent === rule.path;
}

/**
 * @param {string} relPath
 * @param {{path: string, mode: 'exact'|'recursive'}} rule
 * @returns {boolean}
 */
function matchesLockRuleForFolder(relPath, rule) {
    const normalized = normalizeRelPath(relPath || '');
    if (!normalized) return false;
    if (rule.mode === LOCK_DIR_MODE_RECURSIVE) {
        return normalized === rule.path || normalized.startsWith(`${rule.path}/`);
    }
    return normalized === rule.path;
}

/**
 * @param {string[]} sources
 * @param {string[]} headerDirs
 * @param {string[]} headerFiles
 * @param {(relPath: string) => boolean} isLockedFolderFn
 * @returns {string[]}
 */
function collectLockedFoldersForTree(sources, headerDirs, headerFiles, isLockedFolderFn) {
    /** @type {Set<string>} */
    const folderSet = new Set();

    /**
     * @param {string} folder
     */
    function addFolderAndAncestors(folder) {
        let current = normalizeRelPath(folder || '');
        while (current && current !== '.') {
            folderSet.add(current);
            const parent = normalizeRelPath(path.posix.dirname(current));
            if (!parent || parent === '.' || parent === current) {
                break;
            }
            current = parent;
        }
    }

    for (const source of sources || []) {
        const folder = normalizeRelPath(path.posix.dirname(source));
        if (folder && folder !== '.') {
            addFolderAndAncestors(folder);
        }
    }

    for (const headerFile of headerFiles || []) {
        const folder = normalizeRelPath(path.posix.dirname(headerFile));
        if (folder && folder !== '.') {
            addFolderAndAncestors(folder);
        }
    }

    for (const headerDir of headerDirs || []) {
        const folder = normalizeRelPath(headerDir);
        if (folder && folder !== '.') {
            addFolderAndAncestors(folder);
        }
    }

    return Array.from(folderSet).filter(isLockedFolderFn);
}

/**
 * Create a lock rules manager bound to a specific workspace folder.
 * @param {string} settingsPrefix - config key prefix (e.g. "cmakeBuildListManager")
 * @param {import('vscode').Uri} workspaceFolderUri
 * @param {import('vscode')} vscodeModule - vscode module reference
 * @returns {object}
 */
function createLockRules(settingsPrefix, workspaceFolderUri, vscodeModule) {
    /** @type {{path: string, mode: 'exact'|'recursive', group: string}[]} */
    let lockDirRules = [];

    /**
     * @returns {any[]}
     */
    function getRawLockDirEntries() {
        const config = vscodeModule.workspace.getConfiguration(settingsPrefix, workspaceFolderUri);
        /** @type {any[]} */
        const rawLock = config.get('lockDirs', []);
        /** @type {any[]} */
        const rawLegacyExclude = config.get('excludeDirs', []);
        const lockEntries = Array.isArray(rawLock) ? rawLock : [];
        const legacyEntries = Array.isArray(rawLegacyExclude) ? rawLegacyExclude : [];
        return [...lockEntries, ...legacyEntries];
    }

    /**
     * @returns {{path: string, mode: 'exact'|'recursive', group: string}[]}
     */
    function getEffectiveLockRules() {
        const rawEntries = getRawLockDirEntries();
        /** @type {{path: string, mode: 'exact'|'recursive', group: string}[]} */
        const rules = [];
        for (const rawEntry of rawEntries) {
            const normalized = normalizeLockRuleEntry(rawEntry);
            if (normalized) {
                rules.push(normalized);
            }
        }
        lockDirRules = rules;
        return rules;
    }

    /**
     * @param {string} relPath
     * @returns {boolean}
     */
    function isLockedSource(relPath) {
        return lockDirRules.some(rule => matchesLockRuleForFile(relPath, rule));
    }

    /**
     * @param {string} relPath
     * @returns {boolean}
     */
    function isLockedHeaderFile(relPath) {
        return lockDirRules.some(rule => matchesLockRuleForFile(relPath, rule));
    }

    /**
     * @param {string} relPath
     * @returns {boolean}
     */
    function isLockedFolder(relPath) {
        return lockDirRules.some(rule => matchesLockRuleForFolder(relPath, rule));
    }

    return {
        getEffectiveLockRules,
        isLockedSource,
        isLockedHeaderFile,
        isLockedFolder,
        collectLockedFoldersForTree
    };
}

module.exports = {
    LOCK_DIR_MODE_EXACT,
    LOCK_DIR_MODE_RECURSIVE,
    normalizeLockMode,
    normalizeLockRuleEntry,
    matchesLockRuleForFile,
    matchesLockRuleForFolder,
    collectLockedFoldersForTree,
    createLockRules
};
