const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

/**
 * @param {string} input
 * @returns {string}
 */
function normalizeRelPath(input) {
    return input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

/**
 * @param {string} cmakePath
 * @returns {string}
 */
function readCMake(cmakePath) {
    return fs.readFileSync(cmakePath, 'utf8');
}

/**
 * @param {string} cmakePath
 * @param {string} content
 */
function writeCMake(cmakePath, content) {
    fs.writeFileSync(cmakePath, content, 'utf8');
}

/**
 * @param {string[]} lines
 * @param {string} variableName
 * @returns {{start: number, end: number, indent: string}|null}
 */
function findSetBlock(lines, variableName) {
    const openPattern = new RegExp(`^\\s*set\\s*\\(\\s*${variableName}\\b`);

    for (let i = 0; i < lines.length; i++) {
        if (!openPattern.test(lines[i])) continue;

        let parenCount = 0;
        let end = -1;
        for (let j = i; j < lines.length; j++) {
            const line = lines[j];
            for (const ch of line) {
                if (ch === '(') parenCount++;
                if (ch === ')') parenCount--;
            }
            if (parenCount === 0) {
                end = j;
                break;
            }
        }

        if (end !== -1) {
            const indentMatch = lines[i].match(/^(\s*)/);
            return {
                start: i,
                end,
                indent: indentMatch ? indentMatch[1] : ''
            };
        }
    }

    return null;
}

/**
 * @param {string[]} lines
 * @returns {{start: number, end: number, indent: string}|null}
 */
function findUserSourcesBlock(lines) {
    return findSetBlock(lines, 'USER_SOURCES');
}

/**
 * @param {string[]} lines
 * @returns {{start: number, end: number, indent: string}|null}
 */
function findUserHeadersBlock(lines) {
    return findSetBlock(lines, 'USER_HEADERS');
}

/**
 * @param {string} line
 * @returns {string|null}
 */
function parseListEntry(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === ')' || /^set\s*\(/.test(trimmed)) {
        return null;
    }

    const noComment = trimmed.split('#')[0].trim();
    if (!noComment) return null;

    const dequoted = noComment.replace(/^['"]|['"]$/g, '').trim();
    if (!dequoted || dequoted.includes('${') || dequoted.includes('(') || dequoted.includes(')')) {
        return null;
    }

    return normalizeRelPath(dequoted);
}

/**
 * @param {string[]} lines
 * @param {{start: number, end: number, indent: string}|null} block
 * @returns {string[]}
 */
function getBlockEntries(lines, block) {
    if (!block) return [];
    /** @type {string[]} */
    const entries = [];
    for (let i = block.start + 1; i < block.end; i++) {
        const parsed = parseListEntry(lines[i]);
        if (parsed) entries.push(parsed);
    }
    return entries;
}

/**
 * @param {string[]} lines
 * @param {string} variableName
 * @param {string} commentText
 * @param {string} entry
 * @returns {boolean}
 */
function createSetBlock(lines, variableName, commentText, entry) {
    const indent = '';
    const insertIndex = lines.length;
    lines.splice(insertIndex, 0,
        `${indent}# ${commentText}`,
        `${indent}set(${variableName}`,
        `${indent}    ${entry}`,
        `${indent})`
    );
    return true;
}

/**
 * @param {string[]} lines
 * @param {string} variableName
 * @param {string} commentText
 * @param {string[]} entries
 * @returns {boolean}
 */
function createSetBlockWithEntries(lines, variableName, commentText, entries) {
    const indent = '';
    const insertIndex = lines.length;
    const blockLines = [
        `${indent}# ${commentText}`,
        `${indent}set(${variableName}`
    ];

    for (const entry of entries) {
        blockLines.push(`${indent}    ${entry}`);
    }
    blockLines.push(`${indent})`);

    lines.splice(insertIndex, 0, ...blockLines);
    return true;
}

/**
 * @param {string[]} lines
 * @param {{start: number, end: number, indent: string}|null} block
 * @param {string[]} entries
 * @returns {string[]}
 */
function rewriteBlockEntries(lines, block, entries) {
    if (!block) return lines;

    const next = lines.slice(0, block.start + 1);
    for (const entry of entries) {
        next.push(`${block.indent}    ${entry}`);
    }
    next.push(...lines.slice(block.end));
    return next;
}

/**
 * @param {string} cmakePath
 * @param {string} sourceRelPath
 * @returns {Promise<boolean>}
 */
async function addSourceToCMake(cmakePath, sourceRelPath) {
    const normalized = normalizeRelPath(sourceRelPath);
    let lines = readCMake(cmakePath).split(/\r?\n/);
    let modified = false;

    let block = findUserSourcesBlock(lines);
    if (!block) {
        if (!createSetBlock(lines, 'USER_SOURCES', 'User added sources', normalized)) {
            return false;
        }
        modified = true;
        block = findUserSourcesBlock(lines);
    } else {
        const existing = new Set(getBlockEntries(lines, block));
        if (existing.has(normalized)) {
            vscode.window.showWarningMessage(`Source file already added: ${normalized}`);
            return false;
        }
        lines.splice(block.end, 0, `${block.indent}    ${normalized}`);
        modified = true;
    }

    if (modified) {
        writeCMake(cmakePath, lines.join('\n'));
        vscode.window.showInformationMessage(`Added source: ${normalized}`);
        return true;
    }

    return false;
}

/**
 * @param {string} cmakePath
 * @param {string} headerDirRel
 * @returns {Promise<boolean>}
 */
async function addHeaderDirToCMake(cmakePath, headerDirRel) {
    const normalized = normalizeRelPath(headerDirRel);
    let lines = readCMake(cmakePath).split(/\r?\n/);
    let modified = false;

    let block = findUserHeadersBlock(lines);
    if (!block) {
        if (!createSetBlock(lines, 'USER_HEADERS', 'User added header directories', normalized)) {
            return false;
        }
        modified = true;
        block = findUserHeadersBlock(lines);
    } else {
        const existing = new Set(getBlockEntries(lines, block));
        if (existing.has(normalized)) {
            vscode.window.showWarningMessage(`Header directory already added: ${normalized}`);
            return false;
        }
        lines.splice(block.end, 0, `${block.indent}    ${normalized}`);
        modified = true;
    }

    if (modified) {
        writeCMake(cmakePath, lines.join('\n'));
        vscode.window.showInformationMessage(`Added header directory: ${normalized}`);
        return true;
    }

    return false;
}

/**
 * @param {string[]} lines
 * @param {{start: number, end: number, indent: string}|null} block
 * @param {(entry: string) => boolean} shouldRemove
 * @returns {{removed: number, lines: string[]}}
 */
function removeEntriesFromBlock(lines, block, shouldRemove) {
    if (!block) {
        return { removed: 0, lines };
    }

    const nextLines = [];
    let removed = 0;

    for (let i = 0; i < lines.length; i++) {
        if (i <= block.start || i >= block.end) {
            nextLines.push(lines[i]);
            continue;
        }

        const entry = parseListEntry(lines[i]);
        if (entry && shouldRemove(entry)) {
            removed++;
            continue;
        }

        nextLines.push(lines[i]);
    }

    return { removed, lines: nextLines };
}

/**
 * @param {string} cmakePath
 * @param {string} sourceRelPath
 * @returns {Promise<boolean>}
 */
async function removeSourceFromCMake(cmakePath, sourceRelPath) {
    const normalized = normalizeRelPath(sourceRelPath);
    const lines = readCMake(cmakePath).split(/\r?\n/);
    const block = findUserSourcesBlock(lines);

    const result = removeEntriesFromBlock(lines, block, entry => entry === normalized);
    if (result.removed === 0) {
        vscode.window.showWarningMessage(`Source file not found in USER_SOURCES: ${normalized}`);
        return false;
    }

    writeCMake(cmakePath, result.lines.join('\n'));
    vscode.window.showInformationMessage(`Removed source: ${normalized}`);
    return true;
}

/**
 * @param {string} cmakePath
 * @param {string} headerDirRel
 * @returns {Promise<boolean>}
 */
async function removeHeaderDirFromCMake(cmakePath, headerDirRel) {
    const normalized = normalizeRelPath(headerDirRel);
    const lines = readCMake(cmakePath).split(/\r?\n/);
    const block = findUserHeadersBlock(lines);

    const result = removeEntriesFromBlock(lines, block, entry => entry === normalized);
    if (result.removed === 0) {
        vscode.window.showWarningMessage(`Header directory not found in USER_HEADERS: ${normalized}`);
        return false;
    }

    writeCMake(cmakePath, result.lines.join('\n'));
    vscode.window.showInformationMessage(`Removed header directory: ${normalized}`);
    return true;
}

/**
 * @param {string} entry
 * @param {string} folder
 * @param {boolean} recursive
 * @returns {boolean}
 */
function isSourceInFolder(entry, folder, recursive) {
    if (recursive) {
        return entry.startsWith(`${folder}/`);
    }
    return path.posix.dirname(entry) === folder;
}

/**
 * @param {string} entry
 * @param {string} folder
 * @param {boolean} recursive
 * @param {Set<string>|null} explicitHeaderDirs
 * @returns {boolean}
 */
function isHeaderInFolder(entry, folder, recursive, explicitHeaderDirs) {
    if (explicitHeaderDirs && explicitHeaderDirs.size > 0) {
        return explicitHeaderDirs.has(entry);
    }
    if (recursive) {
        return entry === folder || entry.startsWith(`${folder}/`);
    }
    return entry === folder;
}

/**
 * @param {string} cmakePath
 * @param {string} folderRel
 * @param {boolean} recursive
 * @param {string[]} [headerDirsToRemove]
 * @returns {Promise<boolean>}
 */
async function removeFolderSourceAndHeader(cmakePath, folderRel, recursive, headerDirsToRemove) {
    const folder = normalizeRelPath(folderRel);
    if (!folder) {
        vscode.window.showWarningMessage('Cannot remove root folder.');
        return false;
    }

    const explicitHeaderDirs = Array.isArray(headerDirsToRemove)
        ? new Set(headerDirsToRemove.map(normalizeRelPath))
        : null;

    const originalLines = readCMake(cmakePath).split(/\r?\n/);

    const sourceBlock = findUserSourcesBlock(originalLines);
    const sourceResult = removeEntriesFromBlock(
        originalLines,
        sourceBlock,
        entry => isSourceInFolder(entry, folder, recursive)
    );

    const headerBlock = findUserHeadersBlock(sourceResult.lines);
    const headerResult = removeEntriesFromBlock(
        sourceResult.lines,
        headerBlock,
        entry => isHeaderInFolder(entry, folder, recursive, explicitHeaderDirs)
    );

    const removedSources = sourceResult.removed;
    const removedHeaders = headerResult.removed;

    if (removedSources === 0 && removedHeaders === 0) {
        vscode.window.showWarningMessage(`No matching source/header entries found under: ${folder}`);
        return false;
    }

    writeCMake(cmakePath, headerResult.lines.join('\n'));
    const scopeText = recursive ? 'recursively' : 'in current folder';
    vscode.window.showInformationMessage(
        `Removed ${removedSources} source(s) and ${removedHeaders} header dir(s) ${scopeText}: ${folder}`
    );
    return true;
}

/**
 * @param {string} cmakePath
 * @param {string[]} sources
 * @param {string[]} headerDirs
 * @returns {Promise<boolean>}
 */
async function rebuildUserListsFromWorkspace(cmakePath, sources, headerDirs) {
    const normalizedSources = Array.from(new Set((Array.isArray(sources) ? sources : [])
        .map(normalizeRelPath)
        .filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const normalizedHeaderDirs = Array.from(new Set((Array.isArray(headerDirs) ? headerDirs : [])
        .map(normalizeRelPath)
        .filter(Boolean))).sort((a, b) => a.localeCompare(b));

    const originalContent = readCMake(cmakePath);
    let lines = originalContent.split(/\r?\n/);

    let sourcesBlock = findUserSourcesBlock(lines);
    if (!sourcesBlock) {
        if (!createSetBlockWithEntries(lines, 'USER_SOURCES', 'User added sources', normalizedSources)) {
            return false;
        }
        sourcesBlock = findUserSourcesBlock(lines);
    } else {
        lines = rewriteBlockEntries(lines, sourcesBlock, normalizedSources);
    }

    let headersBlock = findUserHeadersBlock(lines);
    if (!headersBlock) {
        if (!createSetBlockWithEntries(lines, 'USER_HEADERS', 'User added header directories', normalizedHeaderDirs)) {
            return false;
        }
        headersBlock = findUserHeadersBlock(lines);
    } else {
        lines = rewriteBlockEntries(lines, headersBlock, normalizedHeaderDirs);
    }

    const nextContent = lines.join('\n');
    if (nextContent === originalContent) {
        return false;
    }

    writeCMake(cmakePath, nextContent);
    return true;
}

/**
 * @param {string} cmakePath
 * @returns {Promise<boolean>}
 */
async function clearUserLists(cmakePath) {
    let content = '';
    try {
        content = readCMake(cmakePath);
    } catch {
        content = '';
    }

    let lines = content.split(/\r?\n/);

    const sourcesBlock = findUserSourcesBlock(lines);
    if (sourcesBlock) {
        lines = rewriteBlockEntries(lines, sourcesBlock, []);
    }

    const headersBlock = findUserHeadersBlock(lines);
    if (headersBlock) {
        lines = rewriteBlockEntries(lines, headersBlock, []);
    }

    const nextContent = lines.join('\n');
    if (nextContent === content) {
        return false;
    }

    writeCMake(cmakePath, nextContent);
    return true;
}

/**
 * @param {string} cmakePath
 * @param {string[]} sources
 * @param {string[]} headerDirs
 * @returns {Promise<boolean>}
 */
async function rewriteUserLists(cmakePath, sources, headerDirs) {
    const normalizedSources = Array.from(new Set((Array.isArray(sources) ? sources : [])
        .map(normalizeRelPath)
        .filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const normalizedHeaderDirs = Array.from(new Set((Array.isArray(headerDirs) ? headerDirs : [])
        .map(normalizeRelPath)
        .filter(Boolean))).sort((a, b) => a.localeCompare(b));

    const originalContent = readCMake(cmakePath);
    let lines = originalContent.split(/\r?\n/);

    let sourcesBlock = findUserSourcesBlock(lines);
    if (!sourcesBlock) {
        if (!createSetBlockWithEntries(lines, 'USER_SOURCES', 'User added sources', normalizedSources)) {
            return false;
        }
        sourcesBlock = findUserSourcesBlock(lines);
    } else {
        lines = rewriteBlockEntries(lines, sourcesBlock, normalizedSources);
    }

    let headersBlock = findUserHeadersBlock(lines);
    if (!headersBlock) {
        if (!createSetBlockWithEntries(lines, 'USER_HEADERS', 'User added header directories', normalizedHeaderDirs)) {
            return false;
        }
        headersBlock = findUserHeadersBlock(lines);
    } else {
        lines = rewriteBlockEntries(lines, headersBlock, normalizedHeaderDirs);
    }

    const nextContent = lines.join('\n');
    if (nextContent === originalContent) {
        return false;
    }

    writeCMake(cmakePath, nextContent);
    return true;
}

module.exports = {
    normalizeRelPath,
    readCMake,
    writeCMake,
    findSetBlock,
    findUserSourcesBlock,
    findUserHeadersBlock,
    parseListEntry,
    getBlockEntries,
    createSetBlock,
    createSetBlockWithEntries,
    rewriteBlockEntries,
    addSourceToCMake,
    addHeaderDirToCMake,
    removeEntriesFromBlock,
    removeSourceFromCMake,
    removeHeaderDirFromCMake,
    isSourceInFolder,
    isHeaderInFolder,
    removeFolderSourceAndHeader,
    rebuildUserListsFromWorkspace,
    clearUserLists,
    rewriteUserLists
};
