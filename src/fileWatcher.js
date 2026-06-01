const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const {
    normalizeRelPath,
    SOURCE_FILE_EXT_PATTERN,
    HEADER_FILE_EXT_PATTERN
} = require('./utils.js');

/**
 * Check if a directory directly contains any source (.c/.cpp) or header (.h/.hpp) files.
 * Only checks immediate children, not recursive.
 * @param {string} absDir
 * @returns {boolean}
 */
function dirHasSourceOrHeader(absDir) {
    let entries = [];
    try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
        return false;
    }
    return entries.some(e => {
        if (!e.isFile()) return false;
        return SOURCE_FILE_EXT_PATTERN.test(e.name) || HEADER_FILE_EXT_PATTERN.test(e.name);
    });
}

/**
 * Set up file system watchers for source/header file creation and deletion.
 *
 * On creation: prompts the user whether to add the file/folder to the CMake managed lists.
 * On deletion: automatically removes the entry and cleans up empty header folders.
 *
 * @param {string} rootPath - Workspace root absolute path.
 * @param {string} managedListsPath - Absolute path to ManagedLists.cmake.
 * @param {typeof import('./cmakeEditor.js')} cmakeEditor - CMake editor module.
 * @param {ReturnType<typeof import('./lockRules.js').createLockRules>} lockRules - Lock rules instance.
 * @param {() => Promise<void>} configureAndRefresh - Callback to trigger CMake reconfiguration and tree refresh.
 * @param {() => void} scheduleRefresh - Callback to schedule a tree-only refresh.
 * @param {string[]} [watchedExtensions] - File extensions to watch (without dot), default ['c','cpp','h','hpp'].
 * @returns {vscode.Disposable[]} Array of disposables to push into extension subscriptions.
 */
function setupFileWatchers(rootPath, managedListsPath, cmakeEditor, lockRules, configureAndRefresh, scheduleRefresh, watchedExtensions) {
    const exts = (Array.isArray(watchedExtensions) && watchedExtensions.length > 0)
        ? watchedExtensions.map(e => e.replace(/^\./, ''))
        : ['c', 'cpp', 'h', 'hpp'];
    const globPattern = `**/*.{${exts.join(',')}}`;
    const fileWatcher = vscode.workspace.createFileSystemWatcher(globPattern);

    // ── File Creation ──────────────────────────────────────────
    const onCreateDisposable = fileWatcher.onDidCreate(async (uri) => {
        const relPath = normalizeRelPath(path.relative(rootPath, uri.fsPath));
        if (!relPath) {
            scheduleRefresh();
            return;
        }

        const dirPath = path.posix.dirname(relPath);
        const isSource = SOURCE_FILE_EXT_PATTERN.test(relPath);
        const isHeader = HEADER_FILE_EXT_PATTERN.test(relPath);

        if (isSource) {
            const sourceLocked = lockRules.isLockedSource(relPath);
            const folderLocked = dirPath !== '.' && lockRules.isLockedFolder(dirPath);

            // If both source and folder are locked, just refresh and return
            if (sourceLocked && folderLocked) {
                scheduleRefresh();
                return;
            }

            // Root-level source file: only source can be added
            if (dirPath === '.') {
                if (!sourceLocked) {
                    const action = await vscode.window.showInformationMessage(
                        `New source file: ${relPath}`,
                        'Add Source',
                        'Skip'
                    );
                    if (action === 'Add Source') {
                        await cmakeEditor.addSourceToCMake(managedListsPath, relPath);
                        await configureAndRefresh();
                    }
                }
                scheduleRefresh();
                return;
            }

            // Build dialog options based on lock state
            /** @type {string[]} */
            const options = [];
            if (!sourceLocked && !folderLocked) {
                options.push('Add Source & Header Folder');
            }
            if (!sourceLocked) {
                options.push('Add Source Only');
            }
            options.push('Skip');

            const action = await vscode.window.showInformationMessage(
                `New source file: ${relPath}`,
                ...options
            );

            let changed = false;
            if (action === 'Add Source & Header Folder') {
                await cmakeEditor.addSourceToCMake(managedListsPath, relPath);
                await cmakeEditor.addHeaderDirToCMake(managedListsPath, dirPath);
                changed = true;
            } else if (action === 'Add Source Only') {
                await cmakeEditor.addSourceToCMake(managedListsPath, relPath);
                changed = true;
            }

            if (changed) await configureAndRefresh();
        } else if (isHeader && dirPath !== '.') {
            if (lockRules.isLockedFolder(dirPath)) {
                scheduleRefresh();
                return;
            }

            const action = await vscode.window.showInformationMessage(
                `New header file: ${relPath}`,
                'Add Header Folder',
                'Skip'
            );

            if (action === 'Add Header Folder') {
                await cmakeEditor.addHeaderDirToCMake(managedListsPath, dirPath);
                await configureAndRefresh();
            }
        }

        scheduleRefresh();
    });

    // ── File Deletion ──────────────────────────────────────────
    const onDeleteDisposable = fileWatcher.onDidDelete(async (uri) => {
        const relPath = normalizeRelPath(path.relative(rootPath, uri.fsPath));
        if (!relPath) {
            scheduleRefresh();
            return;
        }

        const dirPath = path.posix.dirname(relPath);
        const absDir = dirPath === '.' ? rootPath : path.join(rootPath, dirPath);
        const isSource = SOURCE_FILE_EXT_PATTERN.test(relPath);
        const isHeader = HEADER_FILE_EXT_PATTERN.test(relPath);

        if (isSource) {
            // Respect lock rules — never auto-remove locked sources
            if (lockRules.isLockedSource(relPath)) {
                scheduleRefresh();
                return;
            }

            const removed = await cmakeEditor.removeSourceFromCMake(managedListsPath, relPath);

            // If source was removed and the folder now has no source/header files,
            // also clean up the header directory entry
            if (removed && dirPath !== '.' && !dirHasSourceOrHeader(absDir)) {
                if (!lockRules.isLockedFolder(dirPath)) {
                    await cmakeEditor.removeHeaderDirFromCMake(managedListsPath, dirPath);
                }
            }

            if (removed) await configureAndRefresh();
        } else if (isHeader && dirPath !== '.') {
            // When a header file is deleted, check if the folder is now empty
            // of both header and source files. If so, remove the header dir.
            if (!dirHasSourceOrHeader(absDir)) {
                if (!lockRules.isLockedFolder(dirPath)) {
                    const removed = await cmakeEditor.removeHeaderDirFromCMake(managedListsPath, dirPath);
                    if (removed) await configureAndRefresh();
                }
            }
        }

        scheduleRefresh();
    });

    // ── File Change (for tree refresh) ─────────────────────────
    const onChangeDisposable = fileWatcher.onDidChange(() => scheduleRefresh());

    return [fileWatcher, onCreateDisposable, onDeleteDisposable, onChangeDisposable];
}

module.exports = { setupFileWatchers, dirHasSourceOrHeader };
