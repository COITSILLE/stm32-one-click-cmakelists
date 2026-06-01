const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { normalizeRelPath, SOURCE_FILE_EXT_PATTERN, HEADER_FILE_EXT_PATTERN, hasHeaderFileInCurrentDir, normalizeAndSortUnique, diffStringLists, formatPreviewItems } = require('./utils.js');

/**
 * Build ignore set from config or fallback to default.
 * @param {string[]} [ignoredDirectories]
 * @returns {Set<string>}
 */
function buildIgnoreSet(ignoredDirectories) {
    const dirs = (Array.isArray(ignoredDirectories) && ignoredDirectories.length > 0)
        ? ignoredDirectories
        : ['.git', '.vscode', 'build', 'dist', 'cmake_manager_gen'];
    return new Set(dirs.map(d => d.toLowerCase()));
}

/**
 * Fast file hash (MD5) using stream to avoid loading entire file into memory.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
function computeFileMd5(filePath) {
    return new Promise((resolve) => {
        try {
            const stream = fs.createReadStream(filePath);
            const hasher = crypto.createHash('md5');
            stream.on('data', (chunk) => hasher.update(chunk));
            stream.on('end', () => resolve(hasher.digest('hex')));
            stream.on('error', () => resolve(''));
        } catch {
            resolve('');
        }
    });
}

/**
 * Build a lightweight rename index for workspace source/header files.
 * Stores index in VSCode workspaceState.
 * @param {string} rootPath
 * @param {vscode.ExtensionContext} context
 * @param {vscode.OutputChannel} outputChannel
 * @param {string[]} [ignoredDirectories]
 * @returns {Promise<void>}
 */
async function buildRenameIndex(rootPath, context, outputChannel, ignoredDirectories) {
    const ignoreSet = buildIgnoreSet(ignoredDirectories);
    /** @type {{[rel:string]:{hash:string, mtime:number, size:number}}} */
    const files = {};

    /**
     * @param {string} absDir
     * @param {string} relDir
     */
    async function walk(absDir, relDir) {
        let entries = [];
        try {
            entries = fs.readdirSync(absDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (ignoreSet.has(entryRel.toLowerCase().split('/')[0])) continue;
            const full = path.join(absDir, entry.name);
            if (entry.isDirectory()) {
                if (ignoreSet.has(entry.name.toLowerCase())) continue;
                await walk(full, entryRel);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!(SOURCE_FILE_EXT_PATTERN.test(entry.name) || HEADER_FILE_EXT_PATTERN.test(entry.name))) continue;

            let stat;
            try {
                stat = fs.statSync(full);
            } catch {
                continue;
            }

            const relPath = normalizeRelPath(entryRel);
            files[relPath] = {
                hash: '',
                mtime: Math.trunc(stat.mtimeMs),
                size: stat.size
            };
        }
    }

    await walk(rootPath, '');

    const rels = Object.keys(files);
    const concurrency = 8;
    let i = 0;
    while (i < rels.length) {
        const batch = rels.slice(i, i + concurrency);
        await Promise.all(batch.map(async (rel) => {
            const abs = path.join(rootPath, rel);
            const hash = await computeFileMd5(abs);
            files[rel].hash = hash || '';
        }));
        i += concurrency;
    }

    const index = {
        generated: Date.now(),
        files
    };

    await context.workspaceState.update('renameIndex', index);
    outputChannel.appendLine(`Built rename index (${rels.length} files)`);
    vscode.window.showInformationMessage(`Built rename index for ${rels.length} source/header files.`);
}

/**
 * Detect renames by comparing stored index to current workspace state.
 * Only reports mappings (old -> new) where file content MD5 matches.
 * @param {string} rootPath
 * @param {vscode.ExtensionContext} context
 * @param {string[]} [ignoredDirectories]
 * @returns {Promise<{oldRelPath: string, newRelPath: string}[]>}
 */
async function detectRenames(rootPath, context, ignoredDirectories) {
    const ignoreSet = buildIgnoreSet(ignoredDirectories);
    const oldIndex = context.workspaceState.get('renameIndex');
    if (!oldIndex || !oldIndex.files) {
        return [];
    }

    /** @type {{[rel:string]:{hash:string, mtime:number, size:number}}} */
    const currentFiles = {};

    /**
     * @param {string} absDir
     * @param {string} relDir
     */
    async function walkCurrent(absDir, relDir) {
        let entries = [];
        try {
            entries = fs.readdirSync(absDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (ignoreSet.has(entryRel.toLowerCase().split('/')[0])) continue;
            const full = path.join(absDir, entry.name);
            if (entry.isDirectory()) {
                if (ignoreSet.has(entry.name.toLowerCase())) continue;
                await walkCurrent(full, entryRel);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!(SOURCE_FILE_EXT_PATTERN.test(entry.name) || HEADER_FILE_EXT_PATTERN.test(entry.name))) continue;

            let stat;
            try {
                stat = fs.statSync(full);
            } catch {
                continue;
            }

            currentFiles[normalizeRelPath(entryRel)] = { hash: '', mtime: Math.trunc(stat.mtimeMs), size: stat.size };
        }
    }

    await walkCurrent(rootPath, '');

    // Hash current files
    const rels = Object.keys(currentFiles);
    const concurrency = 8;
    let i2 = 0;
    while (i2 < rels.length) {
        const batch = rels.slice(i2, i2 + concurrency);
        await Promise.all(batch.map(async (rel) => {
            const abs = path.join(rootPath, rel);
            const hash = await computeFileMd5(abs);
            currentFiles[rel].hash = hash || '';
        }));
        i2 += concurrency;
    }

    const oldSet = new Set(Object.keys(oldIndex.files));
    const curSet = new Set(Object.keys(currentFiles));
    const removed = Array.from(oldSet).filter(x => !curSet.has(x));
    const added = Array.from(curSet).filter(x => !oldSet.has(x));

    /** @type {{old:string, new:string, hash:string}[]} */
    const mappings = [];

    const hashToOld = new Map();
    for (const r of removed) {
        const rec = oldIndex.files[r];
        if (!rec || !rec.hash) continue;
        const list = hashToOld.get(rec.hash) || [];
        list.push(r);
        hashToOld.set(rec.hash, list);
    }

    for (const a of added) {
        const rec = currentFiles[a];
        if (!rec || !rec.hash) continue;
        const candidates = hashToOld.get(rec.hash) || [];
        if (candidates.length === 0) continue;
        let chosen = candidates[0];
        const baseA = path.posix.basename(a);
        for (const c of candidates) {
            if (path.posix.basename(c) === baseA) {
                chosen = c;
                break;
            }
        }
        mappings.push({ old: chosen, new: a, hash: rec.hash });
    }

    return mappings.map(m => ({ oldRelPath: m.old, newRelPath: m.new }));
}

/**
 * Preview detected renames and ask user to apply managed list changes.
 * @param {{oldRelPath: string, newRelPath: string}[]} mappings
 * @param {string} rootPath
 * @param {string} managedListsPath
 * @param {object} cmakeEditorModule
 * @param {(path: string) => {sources: string[], headerDirs: string[]}} readManagedListsFn
 * @param {vscode.OutputChannel} outputChannel
 * @param {() => Promise<void>} configureAndRefreshFn
 * @returns {Promise<void>}
 */
async function previewAndApplyMappings(mappings, rootPath, managedListsPath, cmakeEditorModule, readManagedListsFn, outputChannel, configureAndRefreshFn) {
    if (mappings.length === 0) return;

    const currentState = readManagedListsFn(managedListsPath);
    const nextSources = new Set(currentState.sources);
    const nextHeaderDirs = new Set(currentState.headerDirs);

    /**
     * @param {string} relPath
     */
    function normalizeDirRelPath(relPath) {
        const normalized = normalizeRelPath(relPath || '');
        return normalized === '.' ? '' : normalized;
    }

    for (const mapping of mappings) {
        const oldRelPath = normalizeRelPath(mapping.oldRelPath);
        const newRelPath = normalizeRelPath(mapping.newRelPath);
        if (!oldRelPath || !newRelPath || oldRelPath === newRelPath) continue;

        const newBaseName = path.posix.basename(newRelPath);
        const oldDir = normalizeDirRelPath(path.posix.dirname(oldRelPath));
        const newDir = normalizeDirRelPath(path.posix.dirname(newRelPath));
        const newIsSource = SOURCE_FILE_EXT_PATTERN.test(newBaseName);
        const oldIsHeader = HEADER_FILE_EXT_PATTERN.test(path.posix.basename(oldRelPath));
        const newIsHeader = HEADER_FILE_EXT_PATTERN.test(newBaseName);

        if (nextSources.has(oldRelPath)) {
            nextSources.delete(oldRelPath);
            if (newIsSource) nextSources.add(newRelPath);
        }

        if (oldIsHeader && oldDir && nextHeaderDirs.has(oldDir)) {
            if (!hasHeaderFileInCurrentDir(path.join(rootPath, oldDir))) {
                nextHeaderDirs.delete(oldDir);
            }
        }

        if (newIsHeader && newDir && hasHeaderFileInCurrentDir(path.join(rootPath, newDir))) {
            nextHeaderDirs.add(newDir);
        }
    }

    const finalSources = normalizeAndSortUnique(Array.from(nextSources));
    const finalHeaderDirs = normalizeAndSortUnique(Array.from(nextHeaderDirs));

    const sourceDiff = diffStringLists(currentState.sources, finalSources);
    const headerDiff = diffStringLists(currentState.headerDirs, finalHeaderDirs);
    const totalChanges = sourceDiff.added.length + sourceDiff.removed.length + headerDiff.added.length + headerDiff.removed.length;

    if (totalChanges === 0) return;

    const sourceDetail = [
        `+${sourceDiff.added.length}: ${formatPreviewItems(sourceDiff.added, 3)}`,
        `-${sourceDiff.removed.length}: ${formatPreviewItems(sourceDiff.removed, 3)}`
    ].join('\n');
    const headerDetail = [
        `+${headerDiff.added.length}: ${formatPreviewItems(headerDiff.added, 3)}`,
        `-${headerDiff.removed.length}: ${formatPreviewItems(headerDiff.removed, 3)}`
    ].join('\n');

    const action = await vscode.window.showInformationMessage(
        `Rename detected: ${mappings.length} file(s). Apply managed list changes?`,
        { detail: `Sources:\n${sourceDetail}\n\nHeaders:\n${headerDetail}` },
        'Apply',
        'Dismiss'
    );

    if (action !== 'Apply') return;

    const changed = await cmakeEditorModule.rewriteUserLists(managedListsPath, finalSources, finalHeaderDirs);
    if (changed) {
        await configureAndRefreshFn();
    }
}

module.exports = {
    computeFileMd5,
    buildRenameIndex,
    detectRenames,
    previewAndApplyMappings
};
