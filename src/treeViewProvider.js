const vscode = require('vscode');
const path = require('path');

class SourceNode extends vscode.TreeItem {
    /**
     * @param {string} rootPath
     * @param {string} relativePath
    * @param {boolean} isLocked
     */
    constructor(rootPath, relativePath, isLocked) {
        super(path.basename(relativePath), vscode.TreeItemCollapsibleState.None);
        this.kind = 'source';
        this.relativePath = relativePath;
        this.resourcePath = path.join(rootPath, relativePath);
        this.resourceUri = vscode.Uri.file(this.resourcePath);
        this.canAdd = false;
        this.canRemove = !isLocked;
        this.contextValue = isLocked ? 'stm32BuildLockedSource' : 'stm32BuildSource';
        this.tooltip = this.resourcePath;
        this.description = isLocked ? `${relativePath} (Locked by settings)` : relativePath;
        this.iconPath = isLocked
            ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'))
            : new vscode.ThemeIcon('check');
        if (!isLocked) {
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [this.resourceUri, { preview: true }]
            };
        }
    }
}

class HeaderNode extends vscode.TreeItem {
    /**
     * @param {string} rootPath
     * @param {string} relativePath
    * @param {boolean} isLocked
     */
    constructor(rootPath, relativePath, isLocked) {
        super(path.basename(relativePath), vscode.TreeItemCollapsibleState.None);
        this.kind = 'header';
        this.relativePath = relativePath;
        this.resourcePath = path.join(rootPath, relativePath);
        this.resourceUri = vscode.Uri.file(this.resourcePath);
        this.canAdd = false;
        this.canRemove = false;
        this.contextValue = isLocked ? 'stm32BuildLockedHeader' : 'stm32BuildHeader';
        this.tooltip = this.resourcePath;
        this.description = isLocked ? `${relativePath} (Locked by settings)` : relativePath;
        this.iconPath = isLocked
            ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'))
            : new vscode.ThemeIcon('file-code');
        if (!isLocked) {
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [this.resourceUri, { preview: true }]
            };
        }
    }
}

class FolderNode extends vscode.TreeItem {
    /**
     * @param {string} rootPath
     * @param {string} relativePath
     * @param {TreeNodeData} nodeData
     */
    constructor(rootPath, relativePath, nodeData) {
        super(
            relativePath ? path.basename(relativePath) : path.basename(rootPath),
            nodeDataHasChildren(nodeData) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );

        this.kind = 'folder';
        this.relativePath = relativePath;
        this.resourcePath = path.join(rootPath, relativePath);
        this.nodeData = nodeData;
        this.canAdd = !nodeData.isLocked;
        this.canRemove = !nodeData.isLocked;
        this.contextValue = nodeData.isLocked ? 'stm32BuildLockedFolder' : 'stm32BuildFolder';
        this.tooltip = this.resourcePath;
        this.description = nodeData.isLocked ? `${relativePath} (Locked by settings)` : relativePath;
        this.iconPath = nodeData.isLocked
            ? new vscode.ThemeIcon('folder', new vscode.ThemeColor('disabledForeground'))
            : new vscode.ThemeIcon(nodeData.isManagedHeader ? 'folder-active' : 'folder-opened');
    }
}

/**
 * @typedef {{ folders: Record<string, TreeNodeData>, sources: Set<string>, headers: Set<string>, relativePath: string, isManagedHeader: boolean, isLocked: boolean }} TreeNodeData
 */

/**
 * @param {TreeNodeData} node
 * @returns {boolean}
 */
function nodeDataHasChildren(node) {
    return Object.keys(node.folders).length > 0 || node.sources.size > 0 || node.headers.size > 0;
}

class TreeViewProvider {
    /**
     * @param {string} rootPath
     */
    constructor(rootPath) {
        this.rootPath = rootPath;
        /** @type {string[]} */
        this.managedSources = [];
        /** @type {string[]} */
        this.managedHeaderDirs = [];
        /** @type {string[]} */
        this.managedHeaderFiles = [];
        /** @type {Set<string>} */
        this.lockedSources = new Set();
        /** @type {Set<string>} */
        this.lockedFolders = new Set();
        /** @type {Set<string>} */
        this.lockedHeaderFiles = new Set();
        /** @type {TreeNodeData} */
        this.rootNode = {
            folders: {},
            sources: new Set(),
            headers: new Set(),
            relativePath: '',
            isManagedHeader: false,
            isLocked: false
        };

        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    /**
     * @param {string[]} sources
     * @param {string[]} headerDirs
     * @param {string[]} headerFiles
     * @param {{sources?: string[], headerDirs?: string[], headerFiles?: string[]}} [lockedState]
     */
    setManagedState(sources, headerDirs, headerFiles, lockedState) {
        this.managedSources = Array.isArray(sources) ? sources.map(normalizeRelPath) : [];
        this.managedHeaderDirs = Array.isArray(headerDirs) ? headerDirs.map(normalizeRelPath) : [];
        this.managedHeaderFiles = Array.isArray(headerFiles) ? headerFiles.map(normalizeRelPath) : [];
        const lockedSources = Array.isArray(lockedState?.sources) ? lockedState.sources : [];
        const lockedHeaderDirs = Array.isArray(lockedState?.headerDirs) ? lockedState.headerDirs : [];
        const lockedHeaderFiles = Array.isArray(lockedState?.headerFiles) ? lockedState.headerFiles : [];
        this.lockedSources = new Set(lockedSources.map(normalizeRelPath));
        this.lockedFolders = new Set(lockedHeaderDirs.map(normalizeRelPath));
        this.lockedHeaderFiles = new Set(lockedHeaderFiles.map(normalizeRelPath));
    }

    /**
     * @param {string} relPath
     * @returns {boolean}
     */
    isLockedSource(relPath) {
        return this.lockedSources.has(normalizeRelPath(relPath || ''));
    }

    /**
     * @param {string} relPath
     * @returns {boolean}
     */
    isLockedHeader(relPath) {
        const normalized = normalizeRelPath(relPath || '');
        return this.lockedHeaderFiles.has(normalized);
    }

    /**
     * @param {string} relPath
     * @returns {boolean}
     */
    isLockedFolderPath(relPath) {
        const normalized = normalizeRelPath(relPath || '');
        if (!normalized) return false;
        return this.lockedFolders.has(normalized);
    }

    async rebuild() {
        this.rootNode = {
            folders: {},
            sources: new Set(),
            headers: new Set(),
            relativePath: '',
            isManagedHeader: false,
            isLocked: false
        };

        for (const source of this.managedSources) {
            this.insertSource(source);
        }

        for (const headerDir of this.managedHeaderDirs) {
            this.markHeaderFolder(headerDir);
        }

        for (const headerFile of this.managedHeaderFiles) {
            this.insertHeader(headerFile);
        }

        this._onDidChangeTreeData.fire(undefined);
    }

    refresh() {
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * @param {string} relSource
     */
    insertSource(relSource) {
        const parts = relSource.split('/').filter(Boolean);
        if (parts.length === 0) return;

        const fileName = parts.pop();
        if (!fileName) return;

        let current = this.rootNode;
        let currentPath = '';
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            if (!current.folders[part]) {
                current.folders[part] = {
                    folders: {},
                    sources: new Set(),
                    headers: new Set(),
                    relativePath: currentPath,
                    isManagedHeader: false,
                    isLocked: this.isLockedFolderPath(currentPath)
                };
            }
            current = current.folders[part];
        }

        current.sources.add(fileName);
    }

    /**
     * @param {string} relHeader
     */
    insertHeader(relHeader) {
        const parts = relHeader.split('/').filter(Boolean);
        if (parts.length === 0) return;

        const fileName = parts.pop();
        if (!fileName) return;

        let current = this.rootNode;
        let currentPath = '';
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            if (!current.folders[part]) {
                current.folders[part] = {
                    folders: {},
                    sources: new Set(),
                    headers: new Set(),
                    relativePath: currentPath,
                    isManagedHeader: false,
                    isLocked: this.isLockedFolderPath(currentPath)
                };
            }
            current = current.folders[part];
        }

        current.headers.add(fileName);
    }

    /**
     * @param {string} relFolder
     */
    markHeaderFolder(relFolder) {
        const parts = relFolder.split('/').filter(Boolean);
        if (parts.length === 0) return;

        let current = this.rootNode;
        let currentPath = '';
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            if (!current.folders[part]) {
                current.folders[part] = {
                    folders: {},
                    sources: new Set(),
                    headers: new Set(),
                    relativePath: currentPath,
                    isManagedHeader: false,
                    isLocked: this.isLockedFolderPath(currentPath)
                };
            }
            current = current.folders[part];
        }

        current.isManagedHeader = true;
    }

    /**
     * @param {vscode.TreeItem} element
     * @returns {vscode.TreeItem}
     */
    getTreeItem(element) {
        return element;
    }

    /**
     * @param {any} element
     * @returns {vscode.TreeItem[]}
     */
    getChildren(element) {
        const node = element && element.nodeData ? element.nodeData : this.rootNode;
        return this.toChildren(node);
    }

    /**
     * @param {TreeNodeData} node
     * @returns {vscode.TreeItem[]}
     */
    toChildren(node) {
        /** @type {vscode.TreeItem[]} */
        const children = [];

        const folderEntries = Object.entries(node.folders).sort((a, b) => a[0].localeCompare(b[0]));
        for (const [name, folderData] of folderEntries) {
            const folderRelPath = folderData.relativePath || name;
            children.push(new FolderNode(this.rootPath, folderRelPath, folderData));
        }

        const sourceNames = Array.from(node.sources).sort((a, b) => a.localeCompare(b));
        for (const sourceName of sourceNames) {
            const sourceRelPath = node.relativePath ? `${node.relativePath}/${sourceName}` : sourceName;
            children.push(new SourceNode(this.rootPath, sourceRelPath, this.isLockedSource(sourceRelPath)));
        }

        const headerNames = Array.from(node.headers).sort((a, b) => a.localeCompare(b));
        for (const headerName of headerNames) {
            const headerRelPath = node.relativePath ? `${node.relativePath}/${headerName}` : headerName;
            children.push(new HeaderNode(this.rootPath, headerRelPath, this.isLockedHeader(headerRelPath)));
        }

        return children;
    }
}

/**
 * @param {string} p
 * @returns {string}
 */
function normalizeRelPath(p) {
    return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

module.exports = TreeViewProvider;
