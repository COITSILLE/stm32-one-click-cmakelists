const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cmakeEditor = require('./src/cmakeEditor.js');
const TreeViewProvider = require('./src/treeViewProvider.js');
const { normalizeRelPath, flattenArgs, normalizeAndSortUnique, diffStringLists, formatPreviewItems, SOURCE_FILE_EXT_PATTERN } = require('./src/utils.js');
const { createLockRules } = require('./src/lockRules.js');
const { getCMakeToolsProject, collectManagedState, collectHeaderFilesFromHeaderDirs, collectHeaderDirsWithHeaders, scanWorkspaceForRebuild, readCurrentManagedLists } = require('./src/cmakeTools.js');
const { buildRenameIndex, detectRenames, previewAndApplyMappings } = require('./src/renames.js');
const { setupFileWatchers } = require('./src/fileWatcher.js');

const SETTINGS_PREFIX = 'cmakeBuildListManager';

/**
 * Read all user-facing configuration values, falling back to defaults.
 * @param {vscode.Uri} workspaceFolderUri
 * @returns {{
 *   managedListsRelPath: string,
 *   targetName: string,
 *   watchedExtensions: string[],
 *   ignoredDirectories: string[]
 * }}
 */
function readConfig(workspaceFolderUri) {
    const config = vscode.workspace.getConfiguration(SETTINGS_PREFIX, workspaceFolderUri);
    return {
        managedListsRelPath: String(config.get('managedListsPath', 'cmake_manager_gen/ManagedLists.cmake') || 'cmake_manager_gen/ManagedLists.cmake'),
        targetName: String(config.get('targetName', '${CMAKE_PROJECT_NAME}.elf') || '${CMAKE_PROJECT_NAME}.elf'),
        watchedExtensions: (Array.isArray(config.get('watchedExtensions')) ? config.get('watchedExtensions') : ['c', 'cpp', 'h', 'hpp'])
            .map(String).filter(Boolean),
        ignoredDirectories: (Array.isArray(config.get('ignoredDirectories')) ? config.get('ignoredDirectories') : ['.git', '.vscode', 'build', 'dist', 'cmake_manager_gen'])
            .map(String).filter(Boolean)
    };
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
async function activate(context) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
    }

    const rootPath = workspaceFolder.uri.fsPath;
    const workspaceFolderUri = workspaceFolder.uri;
    const cmakeListsPath = path.join(rootPath, 'CMakeLists.txt');
    if (!fs.existsSync(cmakeListsPath)) {
        vscode.window.showWarningMessage('CMakeLists.txt not found in workspace root.');
        return;
    }

    const cfg = readConfig(workspaceFolderUri);
    const managedListsRelPath = cfg.managedListsRelPath;
    const managedListsPath = path.join(rootPath, managedListsRelPath);
    const managedListsDir = path.dirname(managedListsPath);
    const lockRules = createLockRules(SETTINGS_PREFIX, workspaceFolderUri, vscode);

    // ============================================================
    // Managed CMake file setup (first-start prompt)
    // ============================================================
    const HAS_PROMPTED_INCLUDE_KEY = 'cmakeBuildListManager.hasPromptedInclude';

    function isManagedFileIncluded() {
        try {
            const rootContent = fs.readFileSync(cmakeListsPath, 'utf8');
            const escaped = managedListsRelPath.replace(/\\/g, '/');
            return rootContent.includes(escaped);
        } catch {
            return false;
        }
    }

    function ensureManagedCMake() {
        if (!fs.existsSync(managedListsDir)) {
            fs.mkdirSync(managedListsDir, { recursive: true });
        }
        if (!fs.existsSync(managedListsPath)) {
            const includePath = managedListsRelPath.replace(/\\/g, '/');
            const initialContent = [
                '# =============================================================================',
                '#  User-managed CMake entries for additional sources and include paths.',
                '#',
                '#  This file is managed by the "CMake Build List Manager" VS Code extension.',
                '#  Do not edit manually while the extension is active.',
                '#',
                '#  To use this file, add the following line to your root CMakeLists.txt',
                '#  (preferably near the end, before any add_subdirectory calls):',
                '#',
                `#      include(${includePath})`,
                '#',
                '#  The extension will also prompt you to add this line automatically.',
                '# =============================================================================',
                '',
                'set(USER_SOURCES',
                '    # Add your source files here, one per line.',
                '    # Example: src/main.c',
                '    # Example: Core/Src/gpio.c',
                ')',
                '',
                'set(USER_HEADERS',
                '    # Add your include directories here, one per line.',
                '    # Example: src',
                '    # Example: Core/Inc',
                ')',
                '',
                `# The variables above are applied to the "${cfg.targetName}" target.`,
                `if(TARGET ${cfg.targetName})`,
                `    target_sources(${cfg.targetName} PRIVATE`,
                '        ${USER_SOURCES}',
                '    )',
                '',
                `    target_include_directories(${cfg.targetName} PRIVATE`,
                '        ${USER_HEADERS}',
                '    )',
                'endif()'
            ].join('\n');
            fs.writeFileSync(managedListsPath, initialContent, 'utf8');
            return true;
        }
        return false;
    }

    const managedCreated = ensureManagedCMake();

    async function promptIncludeLine() {
        const hasAlreadyPrompted = context.globalState.get(HAS_PROMPTED_INCLUDE_KEY, false);
        if (hasAlreadyPrompted || managedCreated === false) return;
        if (isManagedFileIncluded()) {
            await context.globalState.update(HAS_PROMPTED_INCLUDE_KEY, true);
            return;
        }
        const includeLine = `include(${managedListsRelPath.replace(/\\/g, '/')})`;
        const action = await vscode.window.showInformationMessage(
            `Add the following line to your root CMakeLists.txt to include the managed build list:\n\n\`${includeLine}\``,
            'Open CMakeLists.txt', 'Copy to Clipboard', 'Got it'
        );
        if (action === 'Open CMakeLists.txt') {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(cmakeListsPath));
            await vscode.window.showTextDocument(doc);
        } else if (action === 'Copy to Clipboard') {
            await vscode.env.clipboard.writeText(includeLine);
            vscode.window.showInformationMessage('Include line copied to clipboard.');
        }
        await context.globalState.update(HAS_PROMPTED_INCLUDE_KEY, true);
    }

    // ============================================================
    // Tree view & output channel
    // ============================================================
    const treeViewProvider = new TreeViewProvider(rootPath);
    const treeView = vscode.window.createTreeView('cmakeBuildView', {
        treeDataProvider: treeViewProvider,
        canSelectMany: true
    });
    const outputChannel = vscode.window.createOutputChannel('CMake Build List Manager');

    let refreshRunning = false;
    let refreshPending = false;
    /** @type {NodeJS.Timeout | null} */
    let refreshTimer = null;

    // ============================================================
    // Argument utilities (need rootPath closure)
    // ============================================================
    function toSourceRelativePath(target) {
        if (!target) return null;
        if (target instanceof vscode.Uri) {
            const rel = path.relative(rootPath, target.fsPath);
            return rel.startsWith('..') ? null : normalizeRelPath(rel);
        }
        if (typeof target === 'object' && target.kind === 'source' && typeof target.relativePath === 'string') {
            return normalizeRelPath(target.relativePath);
        }
        return null;
    }

    function toFolderRelativePath(target) {
        if (!target) return null;
        if (target instanceof vscode.Uri) {
            const rel = path.relative(rootPath, target.fsPath);
            return rel.startsWith('..') ? null : normalizeRelPath(rel);
        }
        if (typeof target === 'object' && target.kind === 'folder' && typeof target.relativePath === 'string') {
            return normalizeRelPath(target.relativePath);
        }
        return null;
    }

    function toFolderFsPath(target) {
        if (!target) return null;
        if (target instanceof vscode.Uri) return target.fsPath;
        if (typeof target === 'object' && target.kind === 'folder' && typeof target.resourcePath === 'string') {
            return target.resourcePath;
        }
        return null;
    }

    function normalizeCommandArgs(args) {
        const flat = flattenArgs(args);
        const filtered = flat.filter(Boolean);
        /** @type {Set<string>} */
        const seen = new Set();
        /** @type {any[]} */
        const deduped = [];
        for (const target of filtered) {
            let key = '';
            if (target instanceof vscode.Uri) {
                key = `uri:${normalizeRelPath(path.relative(rootPath, target.fsPath))}`;
            } else if (typeof target === 'object') {
                const kind = typeof target.kind === 'string' ? target.kind : 'obj';
                const rel = typeof target.relativePath === 'string' ? normalizeRelPath(target.relativePath) : '';
                const resource = typeof target.resourcePath === 'string' ? normalizeRelPath(path.relative(rootPath, target.resourcePath)) : '';
                key = `obj:${kind}:${rel || resource}`;
            } else {
                key = `${typeof target}:${String(target)}`;
            }
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(target);
        }
        return deduped;
    }

    function showLockBlockedWarning(title, blockedPaths) {
        if (!Array.isArray(blockedPaths) || blockedPaths.length === 0) return;
        const preview = blockedPaths.slice(0, 3).join(', ');
        const suffix = blockedPaths.length > 3 ? ` ... (+${blockedPaths.length - 3})` : '';
        vscode.window.showWarningMessage(`${title}: skipped locked path(s): ${preview}${suffix}`);
    }

    // ============================================================
    // Tree refresh & CMake integration
    // ============================================================
    async function refreshTree() {
        if (refreshRunning) { refreshPending = true; return; }
        refreshRunning = true;
        const project = await getCMakeToolsProject(rootPath);
        try {
            lockRules.getEffectiveLockRules();
            const state = collectManagedState(project, rootPath, cfg.ignoredDirectories);
            const scannedHeaderFiles = collectHeaderFilesFromHeaderDirs(state.headerDirs, rootPath, cfg.ignoredDirectories);
            const mergedHeaderFiles = Array.from(new Set([...state.headerFiles, ...scannedHeaderFiles]));
            const lockedFoldersForTree = lockRules.collectLockedFoldersForTree(
                state.sources, state.headerDirs, mergedHeaderFiles, lockRules.isLockedFolder);
            treeViewProvider.setManagedState(
                state.sources, state.headerDirs, mergedHeaderFiles,
                {
                    sources: state.sources.filter(lockRules.isLockedSource),
                    headerDirs: lockedFoldersForTree,
                    headerFiles: mergedHeaderFiles.filter(lockRules.isLockedHeaderFile)
                }
            );
            await treeViewProvider.rebuild();
            const hasCodeModel = !!project?.codeModel && Array.isArray(project.codeModel.configurations);
            treeView.message = hasCodeModel ? undefined : 'Awaiting CMake configuration';
            await vscode.commands.executeCommand('setContext', 'cmakeBuildListManager.needsConfigure', !hasCodeModel);
            await updateSelectionContext(treeView.selection);
        } finally {
            refreshRunning = false;
            if (refreshPending) { refreshPending = false; void refreshTree(); }
        }
    }

    function scheduleRefreshTree() {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => { refreshTimer = null; void refreshTree(); }, 200);
    }

    async function updateSelectionContext(selection) {
        const items = Array.from(selection || []);
        const canAdd = items.some(item => item && item.canAdd);
        const canRemove = items.some(item => item && item.canRemove);
        const hasSource = items.some(item => item && item.kind === 'source');
        const hasFolder = items.some(item => item && item.kind === 'folder');
        await Promise.all([
            vscode.commands.executeCommand('setContext', 'cmakeBuildListManager.selectionCanAdd', canAdd),
            vscode.commands.executeCommand('setContext', 'cmakeBuildListManager.selectionCanRemove', canRemove),
            vscode.commands.executeCommand('setContext', 'cmakeBuildListManager.selectionHasSource', hasSource),
            vscode.commands.executeCommand('setContext', 'cmakeBuildListManager.selectionHasFolder', hasFolder)
        ]);
    }

    async function configureAndRefresh() {
        const project = await getCMakeToolsProject(rootPath);
        if (!project || typeof project.configure !== 'function') {
            vscode.window.showWarningMessage('CMake Tools project is unavailable.');
            return;
        }
        await project.configure();
        await refreshTree();
    }

    async function showRebuildPreviewAndConfirm(currentState, nextState) {
        const sourceDiff = diffStringLists(currentState.sources, nextState.sources);
        const headerDiff = diffStringLists(currentState.headerDirs, nextState.headerDirs);
        const totalChanges = sourceDiff.added.length + sourceDiff.removed.length + headerDiff.added.length + headerDiff.removed.length;
        if (totalChanges === 0) {
            vscode.window.showInformationMessage('Managed sources and headers already match the workspace scan.');
            return false;
        }
        const summary = [
            `Managed sources: +${sourceDiff.added.length} / -${sourceDiff.removed.length}`,
            `Managed includes: +${headerDiff.added.length} / -${headerDiff.removed.length}`
        ].join('; ');
        const detail = [
            `Sources +: ${formatPreviewItems(sourceDiff.added)}`,
            `Sources -: ${formatPreviewItems(sourceDiff.removed)}`,
            `Headers +: ${formatPreviewItems(headerDiff.added)}`,
            `Headers -: ${formatPreviewItems(headerDiff.removed)}`
        ].join('\n');
        const action = await vscode.window.showInformationMessage(summary, { detail }, 'Rebuild', 'Cancel');
        return action === 'Rebuild';
    }

    // ============================================================
    // Command handlers
    // ============================================================

    const addSourceFileCmd = vscode.commands.registerCommand('cmake-build-list-manager.addSourceFile', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        const blocked = [];
        for (const target of targets) {
            const relPath = toSourceRelativePath(target);
            if (!relPath) continue;
            if (lockRules.isLockedSource(relPath)) { blocked.push(relPath); continue; }
            const updated = await cmakeEditor.addSourceToCMake(managedListsPath, relPath);
            changed = changed || updated;
        }
        showLockBlockedWarning('Add source', blocked);
        if (changed) await configureAndRefresh();
    });

    const addFolderHeaderPathCmd = vscode.commands.registerCommand('cmake-build-list-manager.addFolderHeaderPath', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        const blocked = [];
        for (const target of targets) {
            const relFolder = toFolderRelativePath(target);
            if (!relFolder) continue;
            if (lockRules.isLockedFolder(relFolder)) { blocked.push(relFolder); continue; }
            if (relFolder === '') { vscode.window.showWarningMessage('Cannot add root directory as header path.'); continue; }
            const updated = await cmakeEditor.addHeaderDirToCMake(managedListsPath, relFolder);
            changed = changed || updated;
        }
        showLockBlockedWarning('Add header path', blocked);
        if (changed) await configureAndRefresh();
    });

    const addFolderSourceAndHeaderCmd = vscode.commands.registerCommand('cmake-build-list-manager.addFolderSourceAndHeader', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        const blocked = [];
        for (const target of targets) {
            const folderFsPath = toFolderFsPath(target);
            if (!folderFsPath) continue;
            const relFolder = normalizeRelPath(path.relative(rootPath, folderFsPath));
            if (lockRules.isLockedFolder(relFolder)) { blocked.push(relFolder); continue; }
            if (relFolder === '') { vscode.window.showWarningMessage('Cannot add root folder sources recursively.'); continue; }
            const files = fs.readdirSync(folderFsPath);
            for (const file of files) {
                if (SOURCE_FILE_EXT_PATTERN.test(file)) {
                    const relSource = path.join(relFolder, file).replace(/\\/g, '/');
                    if (lockRules.isLockedSource(relSource)) { blocked.push(relSource); continue; }
                    const updated = await cmakeEditor.addSourceToCMake(managedListsPath, relSource);
                    changed = changed || updated;
                }
            }
            if (lockRules.isLockedFolder(relFolder)) { blocked.push(relFolder); continue; }
            const updated = await cmakeEditor.addHeaderDirToCMake(managedListsPath, relFolder);
            changed = changed || updated;
        }
        showLockBlockedWarning('Add folder source/header', blocked);
        if (changed) await configureAndRefresh();
    });

    const addFolderRecursiveCmd = vscode.commands.registerCommand('cmake-build-list-manager.addFolderRecursiveSourceAndHeader', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        const blocked = [];
        for (const target of targets) {
            const folderFsPath = toFolderFsPath(target);
            if (!folderFsPath) continue;
            const relFolder = normalizeRelPath(path.relative(rootPath, folderFsPath));
            if (lockRules.isLockedFolder(relFolder)) { blocked.push(relFolder); continue; }
            if (relFolder === '') { vscode.window.showWarningMessage('Cannot add root folder recursively.'); continue; }

            function walkDir(dir, baseRel) {
                let results = [];
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fullPath = path.join(dir, entry.name);
                    const relPath = path.join(baseRel, entry.name).replace(/\\/g, '/');
                    if (entry.isDirectory()) {
                        results = results.concat(walkDir(fullPath, relPath));
                    } else if (SOURCE_FILE_EXT_PATTERN.test(entry.name)) {
                        if (lockRules.isLockedSource(relPath)) { blocked.push(relPath); continue; }
                        results.push(relPath);
                    }
                }
                return results;
            }

            const sourceFiles = walkDir(folderFsPath, relFolder);
            for (const src of sourceFiles) {
                const updated = await cmakeEditor.addSourceToCMake(managedListsPath, src);
                changed = changed || updated;
            }

            const headerDirs = collectHeaderDirsWithHeaders(folderFsPath, relFolder, cfg.ignoredDirectories);
            for (const dir of headerDirs) {
                if (lockRules.isLockedFolder(dir)) { blocked.push(dir); continue; }
                const updated = await cmakeEditor.addHeaderDirToCMake(managedListsPath, dir);
                changed = changed || updated;
            }
        }
        showLockBlockedWarning('Add folder recursively', blocked);
        if (changed) await configureAndRefresh();
    });

    const removeSourceFileCmd = vscode.commands.registerCommand('cmake-build-list-manager.removeSourceFile', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        const blocked = [];
        for (const target of targets) {
            const relPath = toSourceRelativePath(target);
            if (!relPath) continue;
            if (lockRules.isLockedSource(relPath)) { blocked.push(relPath); continue; }
            const updated = await cmakeEditor.removeSourceFromCMake(managedListsPath, relPath);
            changed = changed || updated;
        }
        showLockBlockedWarning('Remove source', blocked);
        if (changed) await configureAndRefresh();
    });

    const removeHeaderPathCmd = vscode.commands.registerCommand('cmake-build-list-manager.removeHeaderPath', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        const blocked = [];
        for (const target of targets) {
            const relFolder = toFolderRelativePath(target);
            if (!relFolder) continue;
            if (lockRules.isLockedFolder(relFolder)) { blocked.push(relFolder); continue; }
            if (relFolder === '') { vscode.window.showWarningMessage('Cannot remove root directory from header paths.'); continue; }
            const updated = await cmakeEditor.removeHeaderDirFromCMake(managedListsPath, relFolder);
            changed = changed || updated;
        }
        showLockBlockedWarning('Remove header path', blocked);
        if (changed) await configureAndRefresh();
    });

    const removeFolderSourceAndHeaderCmd = vscode.commands.registerCommand('cmake-build-list-manager.removeFolderSourceAndHeader', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        const blocked = [];
        for (const target of targets) {
            const relFolder = toFolderRelativePath(target);
            if (!relFolder) continue;
            if (lockRules.isLockedFolder(relFolder)) { blocked.push(relFolder); continue; }
            if (relFolder === '') { vscode.window.showWarningMessage('Cannot remove root folder.'); continue; }
            const updated = await cmakeEditor.removeFolderSourceAndHeader(managedListsPath, relFolder, false);
            changed = changed || updated;
        }
        showLockBlockedWarning('Remove folder source/header', blocked);
        if (changed) await configureAndRefresh();
    });

    const removeFolderRecursiveCmd = vscode.commands.registerCommand('cmake-build-list-manager.removeFolderRecursiveSourceAndHeader', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        const blocked = [];
        for (const target of targets) {
            const relFolder = toFolderRelativePath(target);
            if (!relFolder) continue;
            if (lockRules.isLockedFolder(relFolder)) { blocked.push(relFolder); continue; }
            if (relFolder === '') { vscode.window.showWarningMessage('Cannot recursively remove root folder.'); continue; }
            const folderFsPath = path.join(rootPath, relFolder);
            const headerDirsToRemove = fs.existsSync(folderFsPath) ? collectHeaderDirsWithHeaders(folderFsPath, relFolder, cfg.ignoredDirectories) : [];
            const updated = await cmakeEditor.removeFolderSourceAndHeader(managedListsPath, relFolder, true, headerDirsToRemove);
            changed = changed || updated;
        }
        showLockBlockedWarning('Remove folder recursively', blocked);
        if (changed) await configureAndRefresh();
    });

    const rebuildUserListsCmd = vscode.commands.registerCommand('cmake-build-list-manager.rebuildUserListsFromWorkspace', async () => {
        // Re-create the managed file if it was deleted (e.g. entire cmake_manager_gen folder removed)
        ensureManagedCMake();

        const scanned = await scanWorkspaceForRebuild(rootPath, lockRules.isLockedSource, lockRules.isLockedFolder, cfg.ignoredDirectories);
        const nextState = { sources: normalizeAndSortUnique(scanned.sources), headerDirs: normalizeAndSortUnique(scanned.headerDirs) };
        let currentState;
        try {
            currentState = readCurrentManagedLists(managedListsPath, cmakeEditor, normalizeAndSortUnique);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to read managed lists: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const confirmed = await showRebuildPreviewAndConfirm(currentState, nextState);
        if (!confirmed) return;
        const changed = await cmakeEditor.rebuildUserListsFromWorkspace(managedListsPath, scanned.sources, scanned.headerDirs);
        if (changed) await configureAndRefresh();
    });

    const clearUserListsCmd = vscode.commands.registerCommand('cmake-build-list-manager.clearUserLists', async () => {
        const proceed = await vscode.window.showWarningMessage('Clear all managed sources and include paths?', 'Clear', 'Cancel');
        if (proceed === 'Clear') {
            const success = await cmakeEditor.clearUserLists(managedListsPath);
            if (success) await configureAndRefresh();
        }
    });

    const lockPathCmd = vscode.commands.registerCommand('cmake-build-list-manager.lockPath', async (targetUri) => {
        /** @type {vscode.Uri | undefined} */
        const uri = targetUri instanceof vscode.Uri ? targetUri : undefined;
        if (!uri) return;

        const absPath = uri.fsPath;
        let relPath = normalizeRelPath(path.relative(rootPath, absPath));
        if (!relPath || relPath.startsWith('..')) return;

        let isDir = false;
        try {
            isDir = fs.statSync(absPath).isDirectory();
        } catch {
            return;
        }

        // Check if already locked (before showing QuickPick for folders)
        const config = vscode.workspace.getConfiguration(SETTINGS_PREFIX, workspaceFolderUri);
        /** @type {any[]} */
        const currentLockDirs = config.get('lockDirs', []);
        const entries = Array.isArray(currentLockDirs) ? currentLockDirs : [];

        const alreadyLocked = entries.some(entry => {
            if (typeof entry === 'string') return normalizeRelPath(entry) === relPath;
            if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
                return normalizeRelPath(entry.path) === relPath;
            }
            return false;
        });

        if (alreadyLocked) {
            vscode.window.showInformationMessage(`Path already locked: ${relPath}`);
            return;
        }

        // For folders, let the user choose exact or recursive mode
        /** @type {'exact' | 'recursive'} */
        let lockMode = 'exact';
        if (isDir) {
            const choice = await vscode.window.showQuickPick(
                [
                    { label: '$(lock) Lock folder (exact)', description: 'Only this folder', detail: 'Locks files directly in this folder and the folder itself as a header path.', mode: 'exact' },
                    { label: '$(lock) Lock folder (recursive)', description: 'This folder and all subfolders', detail: 'Locks this folder and its entire subtree recursively.', mode: 'recursive' }
                ],
                { placeHolder: `Choose lock mode for: ${relPath}/` }
            );
            if (!choice) return; // user cancelled
            lockMode = /** @type {'exact' | 'recursive'} */ (choice.mode);
        }

        // Add new lock entry
        const newEntry = { path: relPath, mode: lockMode };
        entries.push(newEntry);

        const kindLabel = isDir ? 'folder' : 'file';
        const modeLabel = isDir ? ` (${lockMode})` : '';
        await config.update('lockDirs', entries, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`Locked${modeLabel} ${kindLabel}: ${relPath}`);
        scheduleRefreshTree();
    });

    const buildRenameIndexCmd = vscode.commands.registerCommand('cmake-build-list-manager.buildRenameIndex', async () => {
        await buildRenameIndex(rootPath, context, outputChannel, cfg.ignoredDirectories);
    });

    const detectRenamesCmd = vscode.commands.registerCommand('cmake-build-list-manager.detectRenames', async () => {
        const oldIndex = context.workspaceState.get('renameIndex');
        if (!oldIndex) {
            const doBuild = await vscode.window.showInformationMessage('No rename index found. Build index now?', 'Build', 'Cancel');
            if (doBuild === 'Build') await buildRenameIndex(rootPath, context, outputChannel, cfg.ignoredDirectories);
            else return;
        }
        const mappings = await detectRenames(rootPath, context, cfg.ignoredDirectories);
        if (mappings.length === 0) {
            vscode.window.showInformationMessage('No content-hash rename matches detected.');
            return;
        }
        outputChannel.clear();
        outputChannel.appendLine('=== Rename Detection ===');
        for (const m of mappings) outputChannel.appendLine(`${m.oldRelPath}  ->  ${m.newRelPath}`);
        outputChannel.show(true);
        const readManagedFn = (mp) => readCurrentManagedLists(mp, cmakeEditor, normalizeAndSortUnique);
        await previewAndApplyMappings(mappings, rootPath, managedListsPath, cmakeEditor, readManagedFn, outputChannel, configureAndRefresh);
    });

    // ============================================================
    // Event subscriptions
    // ============================================================
    context.subscriptions.push(vscode.workspace.onDidRenameFiles(async (e) => {
        // ── Fast path: folder rename → prefix-replace managed entries (no index needed) ──
        for (const file of e.files) {
            const oldRel = normalizeRelPath(path.relative(rootPath, file.oldUri.fsPath));
            const newRel = normalizeRelPath(path.relative(rootPath, file.newUri.fsPath));
            if (!oldRel || !newRel || oldRel === newRel) continue;

            const current = readCurrentManagedLists(managedListsPath, cmakeEditor, normalizeAndSortUnique);
            const oldPrefix = oldRel + '/';
            let matched = false;

            const updatedSources = current.sources.map(s => {
                if (s === oldRel) { matched = true; return newRel; }
                if (s.startsWith(oldPrefix)) { matched = true; return newRel + '/' + s.slice(oldPrefix.length); }
                return s;
            });
            const updatedHeaders = current.headerDirs.map(h => {
                if (h === oldRel) { matched = true; return newRel; }
                if (h.startsWith(oldPrefix)) { matched = true; return newRel + '/' + h.slice(oldPrefix.length); }
                return h;
            });

            if (matched) {
                await cmakeEditor.rewriteUserLists(managedListsPath, updatedSources, updatedHeaders);
                await configureAndRefresh();
                return; // one folder rename per operation
            }
        }

        // ── Fallback: MD5 content-hash rename detection (handles individual file renames) ──
        const watchedExtPattern = new RegExp(`\\.(${cfg.watchedExtensions.map(ext => ext.replace(/^\\./, '')).join('|')})$`, 'i');
        const hasRelevantFile = e.files.some(file => watchedExtPattern.test(file.oldUri.fsPath) || watchedExtPattern.test(file.newUri.fsPath));
        if (!hasRelevantFile) return;

        const mappings = await detectRenames(rootPath, context, cfg.ignoredDirectories);
        if (mappings.length === 0) return;
        const readManagedFn = (mp) => readCurrentManagedLists(mp, cmakeEditor, normalizeAndSortUnique);
        await previewAndApplyMappings(mappings, rootPath, managedListsPath, cmakeEditor, readManagedFn, outputChannel, configureAndRefresh);
    }));

    treeView.onDidChangeSelection(e => { void updateSelectionContext(e.selection); });

    const project = await getCMakeToolsProject(rootPath);
    if (project && typeof project.onCodeModelChanged === 'function') {
        context.subscriptions.push(project.onCodeModelChanged(() => { void refreshTree(); }));
    }

    // File creation/deletion watchers (extensions from config)
    const fileWatcherDisposables = setupFileWatchers(
        rootPath, managedListsPath, cmakeEditor, lockRules, configureAndRefresh, scheduleRefreshTree, cfg.watchedExtensions, cfg.ignoredDirectories
    );
    context.subscriptions.push(...fileWatcherDisposables);

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(`${SETTINGS_PREFIX}.lockDirs`) || e.affectsConfiguration(`${SETTINGS_PREFIX}.excludeDirs`)) {
            scheduleRefreshTree();
        }
    }));

    await refreshTree();

    context.subscriptions.push(
        outputChannel, treeView,
        addSourceFileCmd, addFolderHeaderPathCmd, addFolderSourceAndHeaderCmd, addFolderRecursiveCmd,
        removeSourceFileCmd, removeHeaderPathCmd, removeFolderSourceAndHeaderCmd, removeFolderRecursiveCmd,
        rebuildUserListsCmd, buildRenameIndexCmd, detectRenamesCmd, clearUserListsCmd, lockPathCmd
    );

    void promptIncludeLine();
}

function deactivate() { }

module.exports = { activate, deactivate };
