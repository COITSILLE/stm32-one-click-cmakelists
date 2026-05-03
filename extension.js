const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cmakeEditor = require('./src/cmakeEditor.js');
const TreeViewProvider = require('./src/treeViewProvider.js');

const CMAKE_TOOLS_EXTENSION_ID = 'ms-vscode.cmake-tools';
const CMAKE_TOOLS_API_VERSION = 5;
const HEADER_FILE_EXT_PATTERN = /\.(h|hh|hpp|hxx)$/i;
const SOURCE_FILE_EXT_PATTERN = /\.(c|cpp)$/i;
const CUBEMX_CMAKELISTS_GLOB = '**/stm32cubemx/CMakeLists.txt';
const IOC_FILE_GLOB = '**/*.ioc';
const REBUILD_SCAN_IGNORED_DIR_NAMES = new Set(['.git', '.vscode', 'build', 'dist']);
const LOCK_DIR_MODE_EXACT = 'exact';
const LOCK_DIR_MODE_RECURSIVE = 'recursive';
const CUBEMX_AUTO_LOCK_GROUP = 'CubeMX Auto';
const IOC_PROMPTED_FINGERPRINT_KEY = 'stm32-cmake-build-list-manager.iocPromptedFingerprint';
const IOC_FINGERPRINT_CACHE_KEY = 'stm32-cmake-build-list-manager.iocFingerprintCache';

/**
 * @param {vscode.ExtensionContext} context
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
        vscode.window.showWarningMessage('CMakeLists.txt not found in root.');
        return;
    }

    const treeViewProvider = new TreeViewProvider(rootPath);
    const treeView = vscode.window.createTreeView('stm32BuildView', {
        treeDataProvider: treeViewProvider,
        canSelectMany: true
    });
    const outputChannel = vscode.window.createOutputChannel('STM32 CMake Build List Manager');
    let refreshRunning = false;
    let refreshPending = false;
    /** @type {NodeJS.Timeout | null} */
    let refreshTimer = null;
    /** @type {NodeJS.Timeout | null} */
    let cubemxPromptTimer = null;
    let cubemxPromptRunning = false;
    /** @type {{sources: Set<string>, headerDirs: Set<string>, headerFiles: Set<string>, cubemxDirs: Set<string>, autoLockDirs: Set<string>}} */
    let cubeMxOwned = {
        sources: new Set(),
        headerDirs: new Set(),
        headerFiles: new Set(),
        cubemxDirs: new Set(),
        autoLockDirs: new Set()
    };
    /** @type {{path: string, mode: 'exact'|'recursive', group: string}[]} */
    let lockDirRules = [];

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
     * @returns {Promise<vscode.Uri[]>}
     */
    async function findIocFiles() {
        const files = await vscode.workspace.findFiles(IOC_FILE_GLOB, '**/{.git,node_modules,build,dist}/**');
        return files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    }

    /**
     * @param {vscode.Uri[]} iocFiles
     * @returns {string}
     */
    function buildIocQuickFingerprint(iocFiles) {
        if (!iocFiles || iocFiles.length === 0) {
            return 'none';
        }

        /** @type {string[]} */
        const parts = [];
        for (const uri of iocFiles) {
            const rel = normalizeRelPath(path.relative(rootPath, uri.fsPath));
            let stat;
            try {
                stat = fs.statSync(uri.fsPath);
            } catch {
                continue;
            }
            parts.push(`${rel}|${stat.size}|${Math.trunc(stat.mtimeMs)}`);
        }

        if (parts.length === 0) {
            return 'none';
        }

        return `quick:${sha1(parts.join('\n'))}`;
    }

    /**
     * @param {vscode.Uri[]} iocFiles
     * @returns {string}
     */
    function buildIocContentFingerprint(iocFiles) {
        if (!iocFiles || iocFiles.length === 0) {
            return 'none';
        }

        /** @type {Buffer[]} */
        const chunks = [];
        for (const uri of iocFiles) {
            const rel = normalizeRelPath(path.relative(rootPath, uri.fsPath));
            let data;
            try {
                data = fs.readFileSync(uri.fsPath);
            } catch {
                continue;
            }
            chunks.push(Buffer.from(`${rel}\0`, 'utf8'));
            chunks.push(data);
            chunks.push(Buffer.from('\0', 'utf8'));
        }

        if (chunks.length === 0) {
            return 'none';
        }

        return `content:${sha1Buffers(chunks)}`;
    }

    /**
     * @returns {Promise<string>}
     */
    async function getCurrentIocFingerprint() {
        const iocFiles = await findIocFiles();
        if (iocFiles.length === 0) {
            return 'none';
        }

        const quick = buildIocQuickFingerprint(iocFiles);
        const cached = context.workspaceState.get(IOC_FINGERPRINT_CACHE_KEY);
        if (cached && typeof cached === 'object' && cached.quick === quick && typeof cached.content === 'string') {
            return cached.content;
        }

        const content = buildIocContentFingerprint(iocFiles);
        await context.workspaceState.update(IOC_FINGERPRINT_CACHE_KEY, {
            quick,
            content
        });
        return content;
    }

    /**
     * @param {string} relPath
     * @returns {string}
     */
    function normalizeRelPath(relPath) {
        return relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
    }

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
     * @returns {any[]}
     */
    function getRawLockDirEntries() {
        const config = vscode.workspace.getConfiguration('stm32-cmake-build-list-manager', workspaceFolderUri);
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
        return rules;
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
        const parentDir = normalizeRelPath(path.posix.dirname(normalized));
        const normalizedParent = parentDir === '.' ? '' : parentDir;
        return normalizedParent === rule.path;
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

    /**
     * @param {string[]} sources
     * @param {string[]} headerDirs
     * @param {string[]} headerFiles
     * @returns {string[]}
     */
    function collectLockedFoldersForTree(sources, headerDirs, headerFiles) {
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

        return Array.from(folderSet).filter(isLockedFolder);
    }

    /**
     * @param {string} token
     * @returns {boolean}
     */
    function looksLikePathToken(token) {
        if (!token) return false;
        if (token.includes(')') || token.includes('(')) return false;
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) return false;
        if (token.includes('${')) {
            return token.includes('/') || token.includes('\\');
        }
        return token.includes('/') || token.includes('\\') || token.startsWith('.');
    }

    /**
     * @param {string} token
     * @param {string} cubemxDir
     * @returns {string}
     */
    function resolveCubeMxTokenPath(token, cubemxDir) {
        /** @type {Record<string, string>} */
        const replacements = {
            CMAKE_CURRENT_SOURCE_DIR: cubemxDir,
            CMAKE_CURRENT_LIST_DIR: cubemxDir,
            CMAKE_SOURCE_DIR: rootPath,
            PROJECT_SOURCE_DIR: rootPath
        };

        let resolved = token;
        resolved = resolved.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, varName) => {
            const replacement = replacements[varName];
            return replacement ? replacement.replace(/\\/g, '/') : full;
        });
        return resolved;
    }

    /**
     * @param {string} content
     * @returns {string[]}
     */
    function extractPathTokensFromCMake(content) {
        /** @type {string[]} */
        const tokens = [];
        const lines = content.split(/\r?\n/);

        for (const line of lines) {
            const noComment = line.split('#')[0].trim();
            if (!noComment) continue;

            const matches = noComment.match(/"([^"]+)"|'([^']+)'|([^\s()]+)/g) || [];
            for (const rawToken of matches) {
                const token = rawToken.replace(/^['"]|['"]$/g, '').trim();
                if (!looksLikePathToken(token)) continue;
                tokens.push(token);
            }
        }

        return tokens;
    }

    /**
     * @returns {Promise<{sources: Set<string>, headerDirs: Set<string>, headerFiles: Set<string>, cubemxDirs: Set<string>, autoLockDirs: Set<string>}>}
     */
    async function loadCubeMxOwnedState() {
        /** @type {{sources: Set<string>, headerDirs: Set<string>, headerFiles: Set<string>, cubemxDirs: Set<string>, autoLockDirs: Set<string>}} */
        const next = {
            sources: new Set(),
            headerDirs: new Set(),
            headerFiles: new Set(),
            cubemxDirs: new Set(),
            autoLockDirs: new Set()
        };

        const files = await vscode.workspace.findFiles(CUBEMX_CMAKELISTS_GLOB, '**/{.git,build}/**');
        if (files.length === 0) {
            return next;
        }

        for (const cubemxCmakeUri of files) {
            const cubemxCmakePath = cubemxCmakeUri.fsPath;
            const cubemxDir = path.dirname(cubemxCmakePath);
            const relCubeMxDir = normalizeRelPath(path.relative(rootPath, cubemxDir));
            if (relCubeMxDir && !relCubeMxDir.startsWith('..') && !path.isAbsolute(relCubeMxDir)) {
                next.cubemxDirs.add(relCubeMxDir);
            }

            let content = '';
            try {
                content = fs.readFileSync(cubemxCmakePath, 'utf8');
            } catch {
                continue;
            }

            const tokens = extractPathTokensFromCMake(content);
            for (const token of tokens) {
                const resolvedToken = resolveCubeMxTokenPath(token, cubemxDir);
                if (resolvedToken.includes('${')) {
                    continue;
                }

                const absPath = path.isAbsolute(resolvedToken)
                    ? path.resolve(resolvedToken)
                    : path.resolve(cubemxDir, resolvedToken);
                const relPath = path.relative(rootPath, absPath);
                if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
                    continue;
                }

                const normalizedRel = normalizeRelPath(relPath);
                const normalizedParent = normalizeRelPath(path.posix.dirname(normalizedRel));

                let stat;
                try {
                    stat = fs.statSync(absPath);
                } catch {
                    stat = null;
                }

                if (stat && stat.isDirectory()) {
                    next.autoLockDirs.add(normalizedRel);
                } else if (normalizedParent && normalizedParent !== '.') {
                    next.autoLockDirs.add(normalizedParent);
                }

                if (SOURCE_FILE_EXT_PATTERN.test(normalizedRel)) {
                    next.sources.add(normalizedRel);
                    continue;
                }
                if (HEADER_FILE_EXT_PATTERN.test(normalizedRel)) {
                    next.headerFiles.add(normalizedRel);
                    continue;
                }
                if (stat && stat.isDirectory()) {
                    next.headerDirs.add(normalizedRel);
                }
            }
        }

        return next;
    }

    /**
     * @param {Set<string>} discoveredCubeMxDirs
     * @returns {Promise<{changed: boolean, addedPaths: string[]}>}
     */
    async function syncCubeMxDefaultsIntoLockDirs(discoveredCubeMxDirs) {
        if (!discoveredCubeMxDirs || discoveredCubeMxDirs.size === 0) {
            return { changed: false, addedPaths: [] };
        }

        const config = vscode.workspace.getConfiguration('stm32-cmake-build-list-manager', workspaceFolderUri);
        const rawEntries = getRawLockDirEntries();
        let changed = false;

        const nextEntries = rawEntries.map(entry => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return entry;
            }

            const group = typeof entry.group === 'string' ? entry.group : '';
            const isCubeMxAuto = group === CUBEMX_AUTO_LOCK_GROUP;
            if (!isCubeMxAuto) {
                return entry;
            }

            if (entry.mode === LOCK_DIR_MODE_EXACT) {
                return entry;
            }

            changed = true;
            return {
                ...entry,
                mode: LOCK_DIR_MODE_EXACT
            };
        });

        const existingKeys = new Set();
        for (const raw of nextEntries) {
            const normalized = normalizeLockRuleEntry(raw);
            if (!normalized) continue;
            existingKeys.add(`${normalized.path}::${normalized.mode}`);
        }

        /** @type {string[]} */
        const addedPaths = [];
        for (const relDir of discoveredCubeMxDirs) {
            const key = `${relDir}::${LOCK_DIR_MODE_EXACT}`;
            if (existingKeys.has(key)) {
                continue;
            }

            nextEntries.push({
                path: relDir,
                mode: LOCK_DIR_MODE_EXACT,
                group: CUBEMX_AUTO_LOCK_GROUP
            });
            existingKeys.add(key);
            changed = true;
            addedPaths.push(relDir);
        }

        if (changed) {
            await config.update('lockDirs', nextEntries, vscode.ConfigurationTarget.Workspace);
        }

        return { changed, addedPaths };
    }

    /**
     * @returns {Promise<void>}
     */
    async function openWorkspaceSettingsAndRevealLockDirs() {
        const settingsDir = path.join(rootPath, '.vscode');
        const settingsPath = path.join(settingsDir, 'settings.json');
        const settingsUri = vscode.Uri.file(settingsPath);

        if (!fs.existsSync(settingsDir)) {
            fs.mkdirSync(settingsDir, { recursive: true });
        }
        if (!fs.existsSync(settingsPath)) {
            fs.writeFileSync(settingsPath, '{\n}\n', 'utf8');
        }

        const doc = await vscode.workspace.openTextDocument(settingsUri);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        const key = '"stm32-cmake-build-list-manager.lockDirs"';
        const offset = doc.getText().indexOf(key);
        if (offset >= 0) {
            const pos = doc.positionAt(offset);
            const range = new vscode.Range(pos, pos);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
    }

    /**
     * @param {{trigger: string, openSettings: boolean, showNoChangeMessage: boolean}} options
     * @returns {Promise<boolean>}
     */
    async function runCubeMxLockSync(options) {
        const state = await loadCubeMxOwnedState();
        if (state.autoLockDirs.size === 0) {
            if (options.showNoChangeMessage) {
                vscode.window.showInformationMessage('No CubeMX path entries were parsed from CMakeLists.txt. Nothing to update in lockDirs.');
            }
            return false;
        }

        const syncResult = await syncCubeMxDefaultsIntoLockDirs(state.autoLockDirs);
        lockDirRules = getEffectiveLockRules();
        await refreshTree();

        if (syncResult.changed) {
            const preview = syncResult.addedPaths.slice(0, 4).join(', ');
            const suffix = syncResult.addedPaths.length > 4 ? ` ... (+${syncResult.addedPaths.length - 4})` : '';
            vscode.window.showInformationMessage(`Updated lockDirs with CubeMX paths: ${preview}${suffix}`);
        } else if (options.showNoChangeMessage) {
            vscode.window.showInformationMessage('CubeMX paths are already present in lockDirs.');
        }

        if (options.openSettings) {
            await openWorkspaceSettingsAndRevealLockDirs();
        }

        return syncResult.changed;
    }

    /**
     * @param {string} reason
     * @returns {Promise<void>}
     */
    async function promptForCubeMxLockSync(reason) {
        if (cubemxPromptRunning) {
            return;
        }
        cubemxPromptRunning = true;
        try {
            const currentFingerprint = await getCurrentIocFingerprint();
            if (currentFingerprint === 'none') {
                return;
            }

            const promptedFingerprint = context.workspaceState.get(IOC_PROMPTED_FINGERPRINT_KEY, '');
            if (promptedFingerprint === currentFingerprint) {
                return;
            }

            const action = await vscode.window.showInformationMessage(
                `Detected ${reason}. Update CubeMX lockDirs entries now?`,
                'Update Now',
                'Later'
            );

            if (action === 'Update Now') {
                await runCubeMxLockSync({
                    trigger: reason,
                    openSettings: true,
                    showNoChangeMessage: true
                });
            }

            await context.workspaceState.update(IOC_PROMPTED_FINGERPRINT_KEY, currentFingerprint);
        } finally {
            cubemxPromptRunning = false;
        }
    }

    /**
     * @param {string} reason
     */
    function schedulePromptForCubeMxLockSync(reason) {
        if (cubemxPromptTimer) {
            clearTimeout(cubemxPromptTimer);
        }
        cubemxPromptTimer = setTimeout(() => {
            cubemxPromptTimer = null;
            void promptForCubeMxLockSync(reason);
        }, 500);
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
     * @param {any} target
     * @returns {string | null}
     */
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

    /**
     * @param {any} target
     * @returns {string | null}
     */
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

    /**
     * @param {any} target
     * @returns {string | null}
     */
    function toFolderFsPath(target) {
        if (!target) return null;
        if (target instanceof vscode.Uri) {
            return target.fsPath;
        }
        if (typeof target === 'object' && target.kind === 'folder' && typeof target.resourcePath === 'string') {
            return target.resourcePath;
        }
        return null;
    }

    /**
     * @param {any} project
     * @returns {{sources: string[], headerDirs: string[], headerFiles: string[]}}
     */
    function collectManagedState(project) {
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
                            if (/\.(c|cpp)$/i.test(absoluteSource)) {
                                sourceSet.add(normalizeRelPath(relativeSource));
                            } else if (/\.(h|hh|hpp|hxx)$/i.test(absoluteSource)) {
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
     * @returns {string[]}
     */
    function collectHeaderFilesFromHeaderDirs(headerDirs) {
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
     * @returns {boolean}
     */
    function hasHeaderFileInCurrentDir(absDir) {
        let entries = [];
        try {
            entries = fs.readdirSync(absDir, { withFileTypes: true });
        } catch {
            return false;
        }
        return entries.some(entry => entry.isFile() && HEADER_FILE_EXT_PATTERN.test(entry.name));
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
     * @returns {Promise<any | null>}
     */
    async function getCMakeToolsProject() {
        const cmakeToolsExt = vscode.extensions.getExtension(CMAKE_TOOLS_EXTENSION_ID);
        if (!cmakeToolsExt) return null;
        const activated = cmakeToolsExt.isActive ? cmakeToolsExt : await cmakeToolsExt.activate();
        const getApi = activated.exports?.getApi;
        if (typeof getApi !== 'function') return null;
        const api = getApi(CMAKE_TOOLS_API_VERSION);
        if (!api || typeof api.getProject !== 'function') return null;
        const workspaceUri = workspaceFolder?.uri;
        if (!workspaceUri) return null;
        return api.getProject(workspaceUri);
    }

    async function refreshTree() {
        if (refreshRunning) {
            refreshPending = true;
            return;
        }

        refreshRunning = true;
        const project = await getCMakeToolsProject();
        try {
            cubeMxOwned = await loadCubeMxOwnedState();
            lockDirRules = getEffectiveLockRules();
            const state = collectManagedState(project);
            const displaySources = Array.from(new Set([...state.sources, ...cubeMxOwned.sources]));
            const displayHeaderDirs = Array.from(new Set([...state.headerDirs, ...cubeMxOwned.headerDirs]));
            const scannedHeaderFiles = collectHeaderFilesFromHeaderDirs(displayHeaderDirs);
            const mergedHeaderFiles = Array.from(new Set([
                ...state.headerFiles,
                ...cubeMxOwned.headerFiles,
                ...scannedHeaderFiles
            ]));
            const lockedFoldersForTree = collectLockedFoldersForTree(
                displaySources,
                displayHeaderDirs,
                mergedHeaderFiles
            );
            treeViewProvider.setManagedState(
                displaySources,
                displayHeaderDirs,
                mergedHeaderFiles,
                {
                    sources: displaySources.filter(isLockedSource),
                    headerDirs: lockedFoldersForTree,
                    headerFiles: mergedHeaderFiles.filter(isLockedHeaderFile)
                }
            );
            await treeViewProvider.rebuild();
            const hasCodeModel = !!project?.codeModel && Array.isArray(project.codeModel.configurations);
            const needsConfigure = !hasCodeModel;
            treeView.message = needsConfigure
                ? 'Awaiting CMake configuration'
                : undefined;
            await vscode.commands.executeCommand('setContext', 'stm32OneClick.needsConfigure', needsConfigure);
            await updateSelectionContext(treeView.selection);
        } finally {
            refreshRunning = false;
            if (refreshPending) {
                refreshPending = false;
                void refreshTree();
            }
        }
    }

    function scheduleRefreshTree() {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            void refreshTree();
        }, 200);
    }

    /**
     * @param {readonly any[]} selection
     */
    async function updateSelectionContext(selection) {
        const items = Array.from(selection || []);
        const canAdd = items.some(item => item && item.canAdd);
        const canRemove = items.some(item => item && item.canRemove);
        const hasSource = items.some(item => item && item.kind === 'source');
        const hasFolder = items.some(item => item && item.kind === 'folder');
        await Promise.all([
            vscode.commands.executeCommand('setContext', 'stm32OneClick.selectionCanAdd', canAdd),
            vscode.commands.executeCommand('setContext', 'stm32OneClick.selectionCanRemove', canRemove),
            vscode.commands.executeCommand('setContext', 'stm32OneClick.selectionHasSource', hasSource),
            vscode.commands.executeCommand('setContext', 'stm32OneClick.selectionHasFolder', hasFolder)
        ]);
    }

    async function configureAndRefresh() {
        const project = await getCMakeToolsProject();
        if (!project || typeof project.configure !== 'function') {
            vscode.window.showWarningMessage('CMake Tools project is unavailable.');
            return;
        }
        await project.configure();
        await refreshTree();
    }

    /**
     * @returns {Promise<{sources: string[], headerDirs: string[]}>}
     */
    async function scanWorkspaceForRebuild() {
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

                if (SOURCE_FILE_EXT_PATTERN.test(entry.name) && !isLockedSource(entryRel)) {
                    sourceSet.add(entryRel);
                }

                if (HEADER_FILE_EXT_PATTERN.test(entry.name)) {
                    hasHeaderInDir = true;
                }
            }

            if (hasHeaderInDir && relDir && !isLockedFolder(relDir)) {
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
     * @returns {{sources: string[], headerDirs: string[]}}
     */
    function readCurrentUserListsFromCMake() {
        const content = fs.readFileSync(cmakeListsPath, 'utf8');
        const lines = content.split(/\r?\n/);
        const sourceBlock = cmakeEditor.findUserSourcesBlock(lines);
        const headerBlock = cmakeEditor.findUserHeadersBlock(lines);
        const sources = normalizeAndSortUnique(cmakeEditor.getBlockEntries(lines, sourceBlock));
        const headerDirs = normalizeAndSortUnique(cmakeEditor.getBlockEntries(lines, headerBlock));
        return { sources, headerDirs };
    }

    /**
     * @param {string[]} values
     * @param {number} maxItems
     * @returns {string}
     */
    function formatPreviewItems(values, maxItems = 5) {
        if (!values || values.length === 0) {
            return '(none)';
        }
        const head = values.slice(0, maxItems).join(', ');
        if (values.length <= maxItems) {
            return head;
        }
        return `${head}, ... (+${values.length - maxItems})`;
    }

    /**
     * @param {{sources: string[], headerDirs: string[]}} currentState
     * @param {{sources: string[], headerDirs: string[]}} nextState
     * @returns {Promise<boolean>}
     */
    async function showRebuildPreviewAndConfirm(currentState, nextState) {
        const sourceDiff = diffStringLists(currentState.sources, nextState.sources);
        const headerDiff = diffStringLists(currentState.headerDirs, nextState.headerDirs);
        const totalChanges = sourceDiff.added.length + sourceDiff.removed.length + headerDiff.added.length + headerDiff.removed.length;

        if (totalChanges === 0) {
            vscode.window.showInformationMessage('Rebuild preview: Current USER_SOURCES/USER_HEADERS are consistent with workspace scan results.');
            return false;
        }

        outputChannel.clear();
        outputChannel.appendLine('=== Rebuild Preview ===');
        outputChannel.appendLine(`USER_SOURCES  +${sourceDiff.added.length} / -${sourceDiff.removed.length}`);
        outputChannel.appendLine(`USER_HEADERS  +${headerDiff.added.length} / -${headerDiff.removed.length}`);
        outputChannel.appendLine('');
        outputChannel.appendLine(`Add sources: ${sourceDiff.added.length ? sourceDiff.added.join(', ') : '(none)'}`);
        outputChannel.appendLine(`Remove sources: ${sourceDiff.removed.length ? sourceDiff.removed.join(', ') : '(none)'}`);
        outputChannel.appendLine(`Add header dirs: ${headerDiff.added.length ? headerDiff.added.join(', ') : '(none)'}`);
        outputChannel.appendLine(`Remove header dirs: ${headerDiff.removed.length ? headerDiff.removed.join(', ') : '(none)'}`);

        const summary = [
            `Will update USER_SOURCES: +${sourceDiff.added.length} / -${sourceDiff.removed.length}`,
            `Will update USER_HEADERS: +${headerDiff.added.length} / -${headerDiff.removed.length}`
        ].join(';');
        const detail = [
            `Sources +: ${formatPreviewItems(sourceDiff.added)}`,
            `Sources -: ${formatPreviewItems(sourceDiff.removed)}`,
            `Headers +: ${formatPreviewItems(headerDiff.added)}`,
            `Headers -: ${formatPreviewItems(headerDiff.removed)}`
        ].join('\n');

        const action = await vscode.window.showInformationMessage(
            summary,
            {
                detail
            },
            'Continue Rebuild',
            'View Detailed Preview'
        );

        if (action === 'View Detailed Preview') {
            outputChannel.show(true);
            const secondAction = await vscode.window.showInformationMessage(
                'Continue rebuild with the above changes?',
                'Continue',
                'Cancel'
            );
            return secondAction === 'Continue';
        }

        return action === 'Continue Rebuild';
    }

    /**
     * @param {string} value
     * @returns {string | null}
     */
    function toWorkspaceRelativeInputPath(value) {
        if (typeof value !== 'string') return null;

        const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
        if (!trimmed) return null;

        if (path.isAbsolute(trimmed)) {
            const rel = path.relative(rootPath, trimmed);
            if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
                return null;
            }
            return normalizeRelPath(rel);
        }

        const normalized = normalizeRelPath(trimmed);
        if (!normalized || normalized === '.' || normalized.startsWith('../')) {
            return null;
        }

        return normalized;
    }

    /**
     * @param {string} relPath
     * @returns {string}
     */
    function normalizeDirRelPath(relPath) {
        const normalized = normalizeRelPath(relPath || '');
        return normalized === '.' ? '' : normalized;
    }

    /**
     * @param {string} text
     * @returns {{mappings: {oldRelPath: string, newRelPath: string}[], invalidSegments: string[]}}
     */
    function parseRenameMappingsText(text) {
        const segments = String(text || '')
            .split(/[;\n]+/)
            .map(segment => segment.trim())
            .filter(Boolean);

        /** @type {{oldRelPath: string, newRelPath: string}[]} */
        const mappings = [];
        /** @type {string[]} */
        const invalidSegments = [];

        for (const segment of segments) {
            const match = segment.match(/^(.*?)\s*(?:=>|->)\s*(.*?)$/);
            if (!match) {
                invalidSegments.push(segment);
                continue;
            }

            const oldRelPath = toWorkspaceRelativeInputPath(match[1]);
            const newRelPath = toWorkspaceRelativeInputPath(match[2]);
            if (!oldRelPath || !newRelPath) {
                invalidSegments.push(segment);
                continue;
            }

            mappings.push({ oldRelPath, newRelPath });
        }

        return { mappings, invalidSegments };
    }

    /**
     * @param {{oldRelPath: string, newRelPath: string}[]} renameMappings
     * @param {{sources: string[], headerDirs: string[]}} currentState
        * @returns {{sources: string[], headerDirs: string[], sourceDiff: {added: string[], removed: string[]}, headerDiff: {added: string[], removed: string[]}}}
     */
    function buildRenameNextState(renameMappings, currentState) {
        const currentSources = new Set(currentState.sources);
        const currentHeaderDirs = new Set(currentState.headerDirs);
        const nextSources = new Set(currentState.sources);
        const nextHeaderDirs = new Set(currentState.headerDirs);

        for (const mapping of renameMappings) {
            const oldRelPath = normalizeRelPath(mapping.oldRelPath);
            const newRelPath = normalizeRelPath(mapping.newRelPath);
            if (!oldRelPath || !newRelPath || oldRelPath === newRelPath) {
                continue;
            }

            const oldBaseName = path.posix.basename(oldRelPath);
            const newBaseName = path.posix.basename(newRelPath);
            const oldDir = normalizeDirRelPath(path.posix.dirname(oldRelPath));
            const newDir = normalizeDirRelPath(path.posix.dirname(newRelPath));
            const newIsSource = SOURCE_FILE_EXT_PATTERN.test(newBaseName);
            const oldIsHeader = HEADER_FILE_EXT_PATTERN.test(oldBaseName);
            const newIsHeader = HEADER_FILE_EXT_PATTERN.test(newBaseName);
            const sourceWasTracked = currentSources.has(oldRelPath);
            const headerWasTracked = oldDir ? currentHeaderDirs.has(oldDir) : false;

            if (sourceWasTracked) {
                nextSources.delete(oldRelPath);
                if (newIsSource) {
                    nextSources.add(newRelPath);
                }
            } else if (oldIsHeader && headerWasTracked && newIsSource) {
                if (!nextSources.has(newRelPath)) {
                    nextSources.add(newRelPath);
                }
            }

            if (oldIsHeader && headerWasTracked) {
                if (!hasHeaderFileInCurrentDir(path.join(rootPath, oldDir))) {
                    nextHeaderDirs.delete(oldDir);
                }
            }

            if (newIsHeader) {
                const newDirAbs = path.join(rootPath, newDir);
                if (newDir && hasHeaderFileInCurrentDir(newDirAbs) && !nextHeaderDirs.has(newDir)) {
                    nextHeaderDirs.add(newDir);
                }
            }
        }

        const nextState = {
            sources: normalizeAndSortUnique(Array.from(nextSources)),
            headerDirs: normalizeAndSortUnique(Array.from(nextHeaderDirs))
        };

        return {
            ...nextState,
            sourceDiff: diffStringLists(currentState.sources, nextState.sources),
            headerDiff: diffStringLists(currentState.headerDirs, nextState.headerDirs)
        };
    }

    /**
     * @param {{oldRelPath: string, newRelPath: string}[]} renameMappings
     * @param {{showNoChangeMessage?: boolean}} [options]
     * @returns {Promise<boolean>}
     */
    async function showRenamePreviewAndConfirm(renameMappings, options = {}) {
        const currentState = readCurrentUserListsFromCMake();
        const nextState = buildRenameNextState(renameMappings, currentState);
        const totalChanges = nextState.sourceDiff.added.length + nextState.sourceDiff.removed.length + nextState.headerDiff.added.length + nextState.headerDiff.removed.length;

        if (totalChanges === 0) {
            if (options.showNoChangeMessage) {
                vscode.window.showInformationMessage('Rename preview: no tracked USER_SOURCES/USER_HEADERS entries match these mappings.');
            }
            return false;
        }

        outputChannel.clear();
        outputChannel.appendLine('=== Rename Preview ===');
        outputChannel.appendLine('Mappings:');
        for (const mapping of renameMappings) {
            outputChannel.appendLine(`- ${mapping.oldRelPath} -> ${mapping.newRelPath}`);
        }
        outputChannel.appendLine('');
        outputChannel.appendLine(`USER_SOURCES  +${nextState.sourceDiff.added.length} / -${nextState.sourceDiff.removed.length}`);
        outputChannel.appendLine(`USER_HEADERS  +${nextState.headerDiff.added.length} / -${nextState.headerDiff.removed.length}`);
        outputChannel.appendLine('');
        outputChannel.appendLine(`Add sources: ${nextState.sourceDiff.added.length ? nextState.sourceDiff.added.join(', ') : '(none)'}`);
        outputChannel.appendLine(`Remove sources: ${nextState.sourceDiff.removed.length ? nextState.sourceDiff.removed.join(', ') : '(none)'}`);
        outputChannel.appendLine(`Add header dirs: ${nextState.headerDiff.added.length ? nextState.headerDiff.added.join(', ') : '(none)'}`);
        outputChannel.appendLine(`Remove header dirs: ${nextState.headerDiff.removed.length ? nextState.headerDiff.removed.join(', ') : '(none)'}`);

        const summary = [
            `Will update USER_SOURCES: +${nextState.sourceDiff.added.length} / -${nextState.sourceDiff.removed.length}`,
            `Will update USER_HEADERS: +${nextState.headerDiff.added.length} / -${nextState.headerDiff.removed.length}`
        ].join('; ');
        const detail = [
            `Mappings: ${renameMappings.length}`,
            `Sources +: ${formatPreviewItems(nextState.sourceDiff.added)}`,
            `Sources -: ${formatPreviewItems(nextState.sourceDiff.removed)}`,
            `Headers +: ${formatPreviewItems(nextState.headerDiff.added)}`,
            `Headers -: ${formatPreviewItems(nextState.headerDiff.removed)}`
        ].join('\n');

        const action = await vscode.window.showInformationMessage(
            summary,
            {
                detail
            },
            'Apply Rename Changes',
            'View Detailed Preview'
        );

        if (action === 'View Detailed Preview') {
            outputChannel.show(true);
            const secondAction = await vscode.window.showInformationMessage(
                'Apply the rename-driven CMake updates shown above?',
                'Apply',
                'Cancel'
            );
            return secondAction === 'Apply';
        }

        return action === 'Apply Rename Changes';
    }

    /**
     * @param {{oldRelPath: string, newRelPath: string}[]} renameMappings
     * @returns {Promise<boolean>}
     */
    async function applyRenameMappings(renameMappings) {
        const currentState = readCurrentUserListsFromCMake();
        const nextState = buildRenameNextState(renameMappings, currentState);
        if (nextState.sourceDiff.added.length === 0 && nextState.sourceDiff.removed.length === 0 && nextState.headerDiff.added.length === 0 && nextState.headerDiff.removed.length === 0) {
            return false;
        }

        return cmakeEditor.rewriteUserLists(cmakeListsPath, nextState.sources, nextState.headerDirs);
    }

    /**
     * @param {{oldRelPath: string, newRelPath: string}[]} renameMappings
     * @param {{showNoChangeMessage?: boolean}} [options]
     * @returns {Promise<boolean>}
     */
    async function processRenameMappings(renameMappings, options = {}) {
        if (!Array.isArray(renameMappings) || renameMappings.length === 0) {
            return false;
        }

        const confirmed = await showRenamePreviewAndConfirm(renameMappings, options);
        if (!confirmed) {
            return false;
        }

        const changed = await applyRenameMappings(renameMappings);
        if (changed) {
            await configureAndRefresh();
        }
        return changed;
    }

    /**
     * @param {any[]} args
     * @returns {any[]}
     */
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
                const rel = typeof target.relativePath === 'string'
                    ? normalizeRelPath(target.relativePath)
                    : '';
                const resource = typeof target.resourcePath === 'string'
                    ? normalizeRelPath(path.relative(rootPath, target.resourcePath))
                    : '';
                key = `obj:${kind}:${rel || resource}`;
            } else {
                key = `${typeof target}:${String(target)}`;
            }

            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            deduped.push(target);
        }

        return deduped;
    }

    /**
     * @param {string} title
     * @param {string[]} blockedPaths
     */
    function showLockBlockedWarning(title, blockedPaths) {
        if (!Array.isArray(blockedPaths) || blockedPaths.length === 0) {
            return;
        }
        const preview = blockedPaths.slice(0, 3).join(', ');
        const suffix = blockedPaths.length > 3 ? ` ... (+${blockedPaths.length - 3})` : '';
        vscode.window.showWarningMessage(`${title}: skipped locked path(s): ${preview}${suffix}`);
    }

    const addSourceFileCmd = vscode.commands.registerCommand('stm32-cmake-build-list-manager.addSourceFile', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        /** @type {string[]} */
        const blocked = [];
        for (const target of targets) {
            const relPath = toSourceRelativePath(target);
            if (!relPath) continue;
            if (isLockedSource(relPath)) {
                blocked.push(relPath);
                continue;
            }
            const updated = await cmakeEditor.addSourceToCMake(cmakeListsPath, relPath);
            changed = changed || updated;
        }
        showLockBlockedWarning('Add source', blocked);
        if (changed) {
            await configureAndRefresh();
        }
    });

    const addFolderHeaderPathCmd = vscode.commands.registerCommand('stm32-cmake-build-list-manager.addFolderHeaderPath', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        /** @type {string[]} */
        const blocked = [];
        for (const target of targets) {
            const relFolder = toFolderRelativePath(target);
            if (!relFolder) continue;
            if (isLockedFolder(relFolder)) {
                blocked.push(relFolder);
                continue;
            }
            if (relFolder === '') {
                vscode.window.showWarningMessage('Cannot add root directory as header path.');
                continue;
            }
            const updated = await cmakeEditor.addHeaderDirToCMake(cmakeListsPath, relFolder);
            changed = changed || updated;
        }
        showLockBlockedWarning('Add header path', blocked);
        if (changed) {
            await configureAndRefresh();
        }
    });

    const addFolderSourceAndHeaderCmd = vscode.commands.registerCommand('stm32-cmake-build-list-manager.addFolderSourceAndHeader', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        /** @type {string[]} */
        const blocked = [];
        for (const target of targets) {
            const folderFsPath = toFolderFsPath(target);
            if (!folderFsPath) continue;
            const relFolder = normalizeRelPath(path.relative(rootPath, folderFsPath));
            if (isLockedFolder(relFolder)) {
                blocked.push(relFolder);
                continue;
            }
            if (relFolder === '') {
                vscode.window.showWarningMessage('Cannot add root folder sources recursively.');
                continue;
            }
            const files = fs.readdirSync(folderFsPath);
            for (const file of files) {
                if (SOURCE_FILE_EXT_PATTERN.test(file)) {
                    const relSource = path.join(relFolder, file).replace(/\\/g, '/');
                    if (isLockedSource(relSource)) {
                        blocked.push(relSource);
                        continue;
                    }
                    const updated = await cmakeEditor.addSourceToCMake(cmakeListsPath, relSource);
                    changed = changed || updated;
                }
            }
            if (isLockedFolder(relFolder)) {
                blocked.push(relFolder);
                continue;
            }
            const updated = await cmakeEditor.addHeaderDirToCMake(cmakeListsPath, relFolder);
            changed = changed || updated;
        }
        showLockBlockedWarning('Add folder source/header', blocked);
        if (changed) {
            await configureAndRefresh();
        }
    });

    const addFolderRecursiveCmd = vscode.commands.registerCommand('stm32-cmake-build-list-manager.addFolderRecursiveSourceAndHeader', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        /** @type {string[]} */
        const blocked = [];
        for (const target of targets) {
            const folderFsPath = toFolderFsPath(target);
            if (!folderFsPath) continue;
            const relFolder = normalizeRelPath(path.relative(rootPath, folderFsPath));
            if (isLockedFolder(relFolder)) {
                blocked.push(relFolder);
                continue;
            }
            if (relFolder === '') {
                vscode.window.showWarningMessage('Cannot add root folder recursively.');
                continue;
            }

            /**
             * @param {string} dir
             * @param {string} baseRel
             * @returns {string[]}
             */
            function walkDir(dir, baseRel) {
                /** @type {string[]} */
                let results = [];
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fullPath = path.join(dir, entry.name);
                    const relPath = path.join(baseRel, entry.name).replace(/\\/g, '/');
                    if (entry.isDirectory()) {
                        results = results.concat(walkDir(fullPath, relPath));
                    } else if (SOURCE_FILE_EXT_PATTERN.test(entry.name)) {
                        if (isLockedSource(relPath)) {
                            blocked.push(relPath);
                            continue;
                        }
                        results.push(relPath);
                    }
                }
                return results;
            }

            const sourceFiles = walkDir(folderFsPath, relFolder);
            for (const src of sourceFiles) {
                const updated = await cmakeEditor.addSourceToCMake(cmakeListsPath, src);
                changed = changed || updated;
            }

            const headerDirs = collectHeaderDirsWithHeaders(folderFsPath, relFolder);
            for (const dir of headerDirs) {
                if (isLockedFolder(dir)) {
                    blocked.push(dir);
                    continue;
                }
                const updated = await cmakeEditor.addHeaderDirToCMake(cmakeListsPath, dir);
                changed = changed || updated;
            }
        }
        showLockBlockedWarning('Add folder recursively', blocked);
        if (changed) {
            await configureAndRefresh();
        }
    });

    const removeSourceFileCmd = vscode.commands.registerCommand('stm32-cmake-build-list-manager.removeSourceFile', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        /** @type {string[]} */
        const blocked = [];
        for (const target of targets) {
            const relPath = toSourceRelativePath(target);
            if (!relPath) continue;
            if (isLockedSource(relPath)) {
                blocked.push(relPath);
                continue;
            }
            const updated = await cmakeEditor.removeSourceFromCMake(cmakeListsPath, relPath);
            changed = changed || updated;
        }
        showLockBlockedWarning('Remove source', blocked);
        if (changed) {
            await configureAndRefresh();
        }
    });

    const removeHeaderPathCmd = vscode.commands.registerCommand('stm32-cmake-build-list-manager.removeHeaderPath', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        /** @type {string[]} */
        const blocked = [];
        for (const target of targets) {
            const relFolder = toFolderRelativePath(target);
            if (!relFolder) continue;
            if (isLockedFolder(relFolder)) {
                blocked.push(relFolder);
                continue;
            }
            if (relFolder === '') {
                vscode.window.showWarningMessage('Cannot remove root directory from header paths.');
                continue;
            }
            const updated = await cmakeEditor.removeHeaderDirFromCMake(cmakeListsPath, relFolder);
            changed = changed || updated;
        }
        showLockBlockedWarning('Remove header path', blocked);
        if (changed) {
            await configureAndRefresh();
        }
    });

    const removeFolderSourceAndHeaderCmd = vscode.commands.registerCommand('stm32-cmake-build-list-manager.removeFolderSourceAndHeader', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        /** @type {string[]} */
        const blocked = [];
        for (const target of targets) {
            const relFolder = toFolderRelativePath(target);
            if (!relFolder) continue;
            if (isLockedFolder(relFolder)) {
                blocked.push(relFolder);
                continue;
            }
            if (relFolder === '') {
                vscode.window.showWarningMessage('Cannot remove root folder.');
                continue;
            }
            const updated = await cmakeEditor.removeFolderSourceAndHeader(cmakeListsPath, relFolder, false);
            changed = changed || updated;
        }
        showLockBlockedWarning('Remove folder source/header', blocked);
        if (changed) {
            await configureAndRefresh();
        }
    });

    const removeFolderRecursiveCmd = vscode.commands.registerCommand('stm32-cmake-build-list-manager.removeFolderRecursiveSourceAndHeader', async (...args) => {
        const targets = normalizeCommandArgs(args);
        let changed = false;
        /** @type {string[]} */
        const blocked = [];
        for (const target of targets) {
            const relFolder = toFolderRelativePath(target);
            if (!relFolder) continue;
            if (isLockedFolder(relFolder)) {
                blocked.push(relFolder);
                continue;
            }
            if (relFolder === '') {
                vscode.window.showWarningMessage('Cannot recursively remove root folder.');
                continue;
            }
            const folderFsPath = path.join(rootPath, relFolder);
            const headerDirsToRemove = fs.existsSync(folderFsPath)
                ? collectHeaderDirsWithHeaders(folderFsPath, relFolder)
                : [];
            const updated = await cmakeEditor.removeFolderSourceAndHeader(cmakeListsPath, relFolder, true, headerDirsToRemove);
            changed = changed || updated;
        }
        showLockBlockedWarning('Remove folder recursively', blocked);
        if (changed) {
            await configureAndRefresh();
        }
    });

    const rebuildUserListsCmd = vscode.commands.registerCommand('stm32-cmake-build-list-manager.rebuildUserListsFromWorkspace', async () => {
        const scanned = await scanWorkspaceForRebuild();
        const nextState = {
            sources: normalizeAndSortUnique(scanned.sources),
            headerDirs: normalizeAndSortUnique(scanned.headerDirs)
        };

        let currentState;
        try {
            currentState = readCurrentUserListsFromCMake();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to read CMakeLists.txt, cannot preview rebuild differences: ${message}`);
            return;
        }

        const confirmed = await showRebuildPreviewAndConfirm(currentState, nextState);
        if (!confirmed) {
            return;
        }

        const changed = await cmakeEditor.rebuildUserListsFromWorkspace(cmakeListsPath, scanned.sources, scanned.headerDirs);
        if (changed) {
            await configureAndRefresh();
        }
    });

    const previewRenameMappingsCmd = vscode.commands.registerCommand('stm32-cmake-build-list-manager.previewRenameMappings', async () => {
        const input = await vscode.window.showInputBox({
            title: 'Preview Rename Mappings',
            prompt: 'Paste one or more mappings as old -> new, separated by semicolons.',
            placeHolder: 'src/old.c -> src/new.c; Core/Inc/old.h -> Core/Include/new.h',
            ignoreFocusOut: true
        });

        if (!input) {
            return;
        }

        const parsed = parseRenameMappingsText(input);
        if (parsed.invalidSegments.length > 0) {
            vscode.window.showErrorMessage(`Invalid rename mapping input: ${parsed.invalidSegments[0]}`);
            return;
        }

        if (parsed.mappings.length === 0) {
            vscode.window.showWarningMessage('No rename mappings were provided.');
            return;
        }

        await processRenameMappings(parsed.mappings, { showNoChangeMessage: true });
    });

    const syncCubeMxLockDirsCmd = vscode.commands.registerCommand('stm32-cmake-build-list-manager.syncCubeMxLockDirs', async () => {
        await runCubeMxLockSync({
            trigger: 'manual command',
            openSettings: true,
            showNoChangeMessage: true
        });
    });

    const clearUserListsCmd = vscode.commands.registerCommand('stm32-cmake-build-list-manager.clearUserLists', async () => {
        const proceed = await vscode.window.showWarningMessage(
            'Clear all USER_SOURCES and USER_HEADERS?',
            'Clear',
            'Cancel'
        );
        if (proceed === 'Clear') {
            const success = await cmakeEditor.clearUserLists(cmakeListsPath);
            if (success) {
                await configureAndRefresh();
            }
        }
    });

    context.subscriptions.push(vscode.workspace.onDidRenameFiles(event => {
        const renameMappings = [];
        for (const file of event.files || []) {
            const oldRelPath = toWorkspaceRelativeInputPath(file.oldUri?.fsPath || '');
            const newRelPath = toWorkspaceRelativeInputPath(file.newUri?.fsPath || '');
            if (!oldRelPath || !newRelPath) {
                continue;
            }
            renameMappings.push({ oldRelPath, newRelPath });
        }

        if (renameMappings.length === 0) {
            return;
        }

        void processRenameMappings(renameMappings, { showNoChangeMessage: false });
    }));

    treeView.onDidChangeSelection(e => {
        void updateSelectionContext(e.selection);
    });

    const project = await getCMakeToolsProject();
    if (project && typeof project.onCodeModelChanged === 'function') {
        context.subscriptions.push(project.onCodeModelChanged(() => { void refreshTree(); }));
    }

    const headerWatcher = vscode.workspace.createFileSystemWatcher('**/*.{h,hh,hpp,hxx}');
    context.subscriptions.push(
        headerWatcher,
        headerWatcher.onDidCreate(() => { scheduleRefreshTree(); }),
        headerWatcher.onDidChange(() => { scheduleRefreshTree(); }),
        headerWatcher.onDidDelete(() => { scheduleRefreshTree(); })
    );

    const cubeMxCmakeWatcher = vscode.workspace.createFileSystemWatcher(CUBEMX_CMAKELISTS_GLOB);
    context.subscriptions.push(
        cubeMxCmakeWatcher,
        cubeMxCmakeWatcher.onDidCreate(() => { scheduleRefreshTree(); }),
        cubeMxCmakeWatcher.onDidChange(() => { scheduleRefreshTree(); }),
        cubeMxCmakeWatcher.onDidDelete(() => { scheduleRefreshTree(); })
    );

    const iocWatcher = vscode.workspace.createFileSystemWatcher(IOC_FILE_GLOB);
    context.subscriptions.push(
        iocWatcher,
        iocWatcher.onDidCreate(() => { schedulePromptForCubeMxLockSync('.ioc file create'); }),
        iocWatcher.onDidChange(() => { schedulePromptForCubeMxLockSync('.ioc file change'); }),
        iocWatcher.onDidDelete(() => { schedulePromptForCubeMxLockSync('.ioc file delete'); })
    );

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('stm32-cmake-build-list-manager.lockDirs') || e.affectsConfiguration('stm32-cmake-build-list-manager.excludeDirs')) {
            scheduleRefreshTree();
        }
    }));

    await refreshTree();
    schedulePromptForCubeMxLockSync('extension activation');

    context.subscriptions.push(
        outputChannel,
        treeView,
        addSourceFileCmd,
        addFolderHeaderPathCmd,
        addFolderSourceAndHeaderCmd,
        addFolderRecursiveCmd,
        removeSourceFileCmd,
        removeHeaderPathCmd,
        removeFolderSourceAndHeaderCmd,
        removeFolderRecursiveCmd,
        rebuildUserListsCmd,
        previewRenameMappingsCmd,
        syncCubeMxLockDirsCmd,
        clearUserListsCmd
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
