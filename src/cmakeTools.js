const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { normalizeRelPath, HEADER_FILE_EXT_PATTERN, SOURCE_FILE_EXT_PATTERN, REBUILD_SCAN_IGNORED_DIR_NAMES, hasHeaderFileInCurrentDir } = require('./utils.js');

const CMAKE_TOOLS_EXTENSION_ID = 'ms-vscode.cmake-tools';
const CMAKE_TOOLS_API_VERSION = 5;

/**
 * @param {string} rootPath
 * @returns {Promise<any | null>}
 */
async function getCMakeToolsProject(rootPath) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return null;

    const cmakeToolsExt = vscode.extensions.getExtension(CMAKE_TOOLS_EXTENSION_ID);
    if (!cmakeToolsExt) return null;
    const activated = cmakeToolsExt.isActive ? cmakeToolsExt : await cmakeToolsExt.activate();
    const getApi = activated.exports?.getApi;
    if (typeof getApi !== 'function') return null;
    const api = getApi(CMAKE_TOOLS_API_VERSION);
    if (!api || typeof api.getProject !== 'function') return null;
    return api.getProject(workspaceFolder.uri);
}

/**
 * @param {any} project
 * @param {string} rootPath
 * @returns {{sources: string[], headerDirs: string[], headerFiles: string[]}}
 */
function collectManagedState(project, rootPath) {
    const sourceSet = new Set();
    const headerSet = new Set();
    const headerFileSet = new Set();
    const codeModel = project?.codeModel;

    if (!codeModel || !Array.isArray(codeModel.configurations)) {
        return { sources: [], headerDirs: [], headerFiles: [] };
    }

    for (const configuration of codeModel.configurations) {
        for (const modelProject of configuration.projects || []) {
            const projectSourceDir = path.resolve(modelProject.sourceDirectory || rootPath);
            for (const target of modelProject.targets || []) {
                for (const fileGroup of target.fileGroups || []) {
                    for (const source of fileGroup.sources || []) {
                        const absoluteSource = path.isAbsolute(source) ? path.resolve(source) : path.resolve(projectSourceDir, source);
                        const relativeSource = path.relative(rootPath, absoluteSource);
                        if (!relativeSource || relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) {
                            continue;
                        }
                        if (SOURCE_FILE_EXT_PATTERN.test(absoluteSource)) {
                            sourceSet.add(normalizeRelPath(relativeSource));
                        } else if (HEADER_FILE_EXT_PATTERN.test(absoluteSource)) {
                            headerFileSet.add(normalizeRelPath(relativeSource));
                        }
                    }
                    for (const includePath of fileGroup.includePath || []) {
                        const absoluteHeaderDir = path.isAbsolute(includePath.path)
                            ? path.resolve(includePath.path)
                            : path.resolve(projectSourceDir, includePath.path);
                        const relativeHeaderDir = path.relative(rootPath, absoluteHeaderDir);
                        if (!relativeHeaderDir || relativeHeaderDir.startsWith('..') || path.isAbsolute(relativeHeaderDir)) {
                            continue;
                        }
                        headerSet.add(normalizeRelPath(relativeHeaderDir));
                    }
                }
            }
        }
    }

    return {
        sources: Array.from(sourceSet),
        headerDirs: Array.from(headerSet),
        headerFiles: Array.from(headerFileSet)
    };
}

/**
 * @param {string[]} headerDirs
 * @param {string} rootPath
 * @returns {string[]}
 */
function collectHeaderFilesFromHeaderDirs(headerDirs, rootPath) {
    const result = new Set();

    for (const relDir of headerDirs) {
        if (!relDir) continue;

        const absDir = path.join(rootPath, relDir);
        if (!fs.existsSync(absDir)) continue;

        let stat;
        try {
            stat = fs.statSync(absDir);
        } catch {
            continue;
        }
        if (!stat.isDirectory()) continue;

        /** @type {string[]} */
        const stack = [absDir];
        while (stack.length > 0) {
            const current = stack.pop();
            if (!current) continue;

            let entries = [];
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(fullPath);
                    continue;
                }
                if (!entry.isFile() || !HEADER_FILE_EXT_PATTERN.test(entry.name)) {
                    continue;
                }

                const relFile = path.relative(rootPath, fullPath);
                if (!relFile || relFile.startsWith('..') || path.isAbsolute(relFile)) {
                    continue;
                }
                result.add(normalizeRelPath(relFile));
            }
        }
    }

    return Array.from(result);
}

/**
 * @param {string} absDir
 * @param {string} relDir
 * @returns {string[]}
 */
function collectHeaderDirsWithHeaders(absDir, relDir) {
    /** @type {string[]} */
    const result = [];

    if (hasHeaderFileInCurrentDir(absDir)) {
        result.push(relDir);
    }

    let entries = [];
    try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
        return result;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subAbs = path.join(absDir, entry.name);
        const subRel = path.join(relDir, entry.name).replace(/\\/g, '/');
        result.push(...collectHeaderDirsWithHeaders(subAbs, subRel));
    }

    return result;
}

/**
 * Scan workspace for source and header directories (for rebuild).
 * @param {string} rootPath
 * @param {(relPath: string) => boolean} isLockedSourceFn
 * @param {(relPath: string) => boolean} isLockedFolderFn
 * @returns {Promise<{sources: string[], headerDirs: string[]}>}
 */
async function scanWorkspaceForRebuild(rootPath, isLockedSourceFn, isLockedFolderFn) {
    /** @type {Set<string>} */
    const sourceSet = new Set();
    /** @type {Set<string>} */
    const headerDirSet = new Set();

    /**
     * @param {string} dirName
     * @returns {boolean}
     */
    function shouldSkipScanDir(dirName) {
        return REBUILD_SCAN_IGNORED_DIR_NAMES.has(dirName.toLowerCase());
    }

    /**
     * @param {string} absDir
     * @param {string} relDir
     */
    function walk(absDir, relDir) {
        let entries = [];
        try {
            entries = fs.readdirSync(absDir, { withFileTypes: true });
        } catch {
            return;
        }

        let hasHeaderInDir = false;
        for (const entry of entries) {
            const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;

            const fullPath = path.join(absDir, entry.name);
            if (entry.isDirectory()) {
                if (shouldSkipScanDir(entry.name)) {
                    continue;
                }
                walk(fullPath, entryRel);
                continue;
            }

            if (entry.isSymbolicLink()) {
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            if (SOURCE_FILE_EXT_PATTERN.test(entry.name) && !isLockedSourceFn(entryRel)) {
                sourceSet.add(entryRel);
            }

            if (HEADER_FILE_EXT_PATTERN.test(entry.name)) {
                hasHeaderInDir = true;
            }
        }

        if (hasHeaderInDir && relDir && !isLockedFolderFn(relDir)) {
            headerDirSet.add(relDir);
        }
    }

    walk(rootPath, '');

    return {
        sources: Array.from(sourceSet),
        headerDirs: Array.from(headerDirSet)
    };
}

/**
 * @param {string} managedListsPath
 * @param {{findUserSourcesBlock: Function, findUserHeadersBlock: Function, getBlockEntries: Function}} cmakeEditorModule
 * @param {(values: string[]) => string[]} normalizeAndSortUnique
 * @returns {{sources: string[], headerDirs: string[]}}
 */
function readCurrentManagedLists(managedListsPath, cmakeEditorModule, normalizeAndSortUnique) {
    try {
        const content = fs.readFileSync(managedListsPath, 'utf8');
        const lines = content.split(/\r?\n/);
        const sourceBlock = cmakeEditorModule.findUserSourcesBlock(lines);
        const headerBlock = cmakeEditorModule.findUserHeadersBlock(lines);
        const sources = normalizeAndSortUnique(cmakeEditorModule.getBlockEntries(lines, sourceBlock));
        const headerDirs = normalizeAndSortUnique(cmakeEditorModule.getBlockEntries(lines, headerBlock));
        return { sources, headerDirs };
    } catch {
        return { sources: [], headerDirs: [] };
    }
}

module.exports = {
    CMAKE_TOOLS_EXTENSION_ID,
    CMAKE_TOOLS_API_VERSION,
    getCMakeToolsProject,
    collectManagedState,
    collectHeaderFilesFromHeaderDirs,
    collectHeaderDirsWithHeaders,
    scanWorkspaceForRebuild,
    readCurrentManagedLists
};
