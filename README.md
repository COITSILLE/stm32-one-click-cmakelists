# CMake Build List Manager

[English](#english) | [中文](#chinese)

> **v2.0.0** — Major upgrade of STM32 CMake Build Manager, now supports any CMake project.

A VS Code extension for managing CMake `USER_SOURCES` / `USER_HEADERS` via a standalone CMake fragment.

---

<a id="english"></a>

## English

### ⚠️ v1.x → v2.0 Migration Guide

| v1.x | v2.0 |
|------|------|
| Writes directly to root `CMakeLists.txt` | Writes standalone `cmake_manager_gen/ManagedLists.cmake` |
| CubeMX path auto-sync | Removed; use manual `lockDirs` |
| Text-based rename mapping | MD5 content-hash auto-detect |
| `stm32-cmake-build-list-manager.lockDirs` | `cmakeBuildListManager.lockDirs` |

#### Migration steps

1. Add this line to your root `CMakeLists.txt`:
```cmake
include(cmake_manager_gen/ManagedLists.cmake)
```

2. Migrate `stm32-cmake-build-list-manager.lockDirs` → `cmakeBuildListManager.lockDirs`

3. If you relied on CubeMX auto-sync, manually add `Drivers/CMSIS` etc. to `lockDirs`.

---

### Features

- **Tree view** in the Explorer sidebar shows all sources and headers tracked by CMake
- **Context menu** in Explorer and Build List view: add/remove source files and include paths
- **Auto-add prompt** — creating a `.c/.cpp/.h/.hpp` file triggers a dialog to add it to the build list
- **Auto-cleanup on delete** — deleting a source/header file auto-removes it and cleans up empty header folders
- **Lock directories & files** via `cmakeBuildListManager.lockDirs`, with right-click context menu shortcut
- **Scan & rebuild** from workspace (with configurable ignored directories)
- **MD5-based rename detection** — detects moved/renamed files by content hash, auto-applies to build list
- Integrates with **CMake Tools** extension for code model data and configuration

### How to use

1. Add this line to your root `CMakeLists.txt`:
```cmake
include(cmake_manager_gen/ManagedLists.cmake)
```

2. Right-click any `.c`/`.cpp` file or folder in the Explorer → choose **"Add source to build"**, **"Add header path"**, etc.

3. The extension writes to `cmake_manager_gen/ManagedLists.cmake` and triggers CMake reconfiguration.

> ⚠️ **New project?** Configure `cmakeBuildListManager.lockDirs` first (or right-click → **"Lock this path..."**), then run **"CMake Build: Rebuild build list from workspace scan"**. Otherwise the rebuild will pick up everything — including generated code, HAL drivers, and middleware — and your build list will be a mess.

### Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `cmakeBuildListManager.lockDirs` | `array` | `[]` | Locked directories/files (path, mode, group) |
| `cmakeBuildListManager.managedListsPath` | `string` | `cmake_manager_gen/ManagedLists.cmake` | Output path for the managed CMake file |
| `cmakeBuildListManager.targetName` | `string` | `${CMAKE_PROJECT_NAME}.elf` | Target name for `target_sources` / `target_include_directories` |
| `cmakeBuildListManager.watchedExtensions` | `array` | `["c","cpp","h","hpp"]` | File extensions to watch for auto-add/remove |
| `cmakeBuildListManager.ignoredDirectories` | `array` | `[".git",".vscode","build","dist","cmake_manager_gen"]` | Directories to skip during workspace scan |
| `cmakeBuildListManager.excludeDirs` | `array` | `[]` | [Deprecated] Use `lockDirs` instead |

Lock entry format:
```jsonc
{
  "cmakeBuildListManager.lockDirs": [
    "Drivers/CMSIS",                          // string = recursive, group "User"
    { "path": "src", "mode": "exact", "group": "User" },
    { "path": "Middlewares", "mode": "recursive", "group": "ThirdParty" }
  ]
}
```

### Commands

| Command | Description |
|---------|-------------|
| `Add source to build` | Add a `.c`/`.cpp`/`.cc`/`.cxx` file |
| `Add header path` | Add folder to include path |
| `Add source and header of this folder` | Add all sources + folder as include |
| `Recursively add source and header of this folder` | Recursive version |
| `Remove source from build` | Remove a source file |
| `Remove header search path` | Remove a header folder |
| `Remove source and header of this folder` | Remove folder entries |
| `Recursively remove source and header of this folder` | Recursive version |
| `Lock this path...` | Lock a file/folder; folders prompt for exact/recursive mode |
| `CMake Build: Rebuild build list from workspace scan` | Scan workspace and rebuild |
| `CMake Build: Clear all managed sources and headers` | Clear everything |
| `CMake Build: Build Rename Index` | Build MD5 rename index |
| `CMake Build: Detect Renames` | Detect renamed/moved files |

### Requirements

- [CMake Tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) extension
- `CMakeLists.txt` in workspace root

### Managed file format

`cmake_manager_gen/ManagedLists.cmake` (path configurable via `managedListsPath`):

```cmake
# =============================================================================
#  User-managed CMake entries for additional sources and include paths.
#
#  To use this file, add the following line to your root CMakeLists.txt:
#
#      include(cmake_manager_gen/ManagedLists.cmake)
# =============================================================================

set(USER_SOURCES
    src/main.c
    src/utils.c
)

set(USER_HEADERS
    src/
    lib/include/
)

if(TARGET ${CMAKE_PROJECT_NAME}.elf)
    target_sources(${CMAKE_PROJECT_NAME}.elf PRIVATE
        ${USER_SOURCES}
    )

    target_include_directories(${CMAKE_PROJECT_NAME}.elf PRIVATE
        ${USER_HEADERS}
    )
endif()
```

> The target name (`${CMAKE_PROJECT_NAME}.elf`) is configurable via `cmakeBuildListManager.targetName`.

---

<a id="chinese"></a>

## 中文

### ⚠️ v1.x → v2.0 迁移指南

| v1.x | v2.0 |
|------|------|
| 直接修改根 `CMakeLists.txt` | 写独立 `cmake_manager_gen/ManagedLists.cmake` |
| CubeMX 路径自动同步 | 已移除，改用手动 `lockDirs` |
| 手动文本重命名映射 | MD5 内容哈希自动检测 |
| `stm32-cmake-build-list-manager.lockDirs` | `cmakeBuildListManager.lockDirs` |

#### 迁移步骤

1. 在根 `CMakeLists.txt` 中加一行：
```cmake
include(cmake_manager_gen/ManagedLists.cmake)
```

2. 把 v1.x 的 `stm32-cmake-build-list-manager.lockDirs` 配置迁移到 `cmakeBuildListManager.lockDirs`

3. 如之前依赖 CubeMX 自动同步，手动把 `Drivers/CMSIS` 等目录加到 `lockDirs`

---

### 功能

- **树视图**：Explorer 侧边栏展示 CMake 追踪的所有源文件和头文件
- **右键菜单**：在 Explorer 和 Build List 面板中添加/删除源文件和头文件路径
- **自动添加弹窗**：创建 `.c/.cpp/.h/.hpp` 文件时弹窗询问是否加入构建列表
- **自动清理**：删除文件时自动从构建列表移除，目录清空后自动清理头文件路径
- **锁目录与文件**：通过 `cmakeBuildListManager.lockDirs` 保护，支持右键快捷锁定
- **扫描重建**：从工作区扫描并重建构建列表（可配置忽略目录）
- **MD5 重命名检测**：基于内容哈希检测文件移动/重命名，自动更新构建列表
- 与 **CMake Tools** 扩展集成，获取代码模型数据

### 使用方法

1. 在根 `CMakeLists.txt` 中添加：
```cmake
include(cmake_manager_gen/ManagedLists.cmake)
```

2. 右键任意 `.c`/`.cpp` 文件或文件夹 → 选择「Add source to build」「Add header path」等

3. 插件自动写入 `cmake_manager_gen/ManagedLists.cmake` 并触发 CMake 重新配置

> ⚠️ **新工程注意**：请先配置 `cmakeBuildListManager.lockDirs`（或右键 → **「Lock this path...」**），再执行 **「CMake Build: Rebuild build list from workspace scan」**。否则 rebuild 会把整个工作区的文件全扫进来——包括自动生成的代码、HAL 驱动、中间件等——构建列表会非常混乱。

### 配置

| 设置项 | 类型 | 默认值 | 描述 |
|---------|------|--------|------|
| `cmakeBuildListManager.lockDirs` | `array` | `[]` | 锁定的目录/文件（path, mode, group） |
| `cmakeBuildListManager.managedListsPath` | `string` | `cmake_manager_gen/ManagedLists.cmake` | 托管 CMake 文件的输出路径 |
| `cmakeBuildListManager.targetName` | `string` | `${CMAKE_PROJECT_NAME}.elf` | `target_sources` / `target_include_directories` 的目标名 |
| `cmakeBuildListManager.watchedExtensions` | `array` | `["c","cpp","h","hpp"]` | 监听自动添加/移除的文件后缀 |
| `cmakeBuildListManager.ignoredDirectories` | `array` | `[".git",".vscode","build","dist","cmake_manager_gen"]` | 工作区扫描时跳过的目录 |
| `cmakeBuildListManager.excludeDirs` | `array` | `[]` | [已弃用] 请使用 `lockDirs` |

锁定条目格式：
```jsonc
{
  "cmakeBuildListManager.lockDirs": [
    "Drivers/CMSIS",                          // 字符串 = 递归，分组 "User"
    { "path": "src", "mode": "exact", "group": "User" },
    { "path": "Middlewares", "mode": "recursive", "group": "ThirdParty" }
  ]
}
```

### 命令

| 命令 | 描述 |
|------|------|
| `Add source to build` | 添加 `.c`/`.cpp`/`.cc`/`.cxx` 文件 |
| `Add header path` | 添加文件夹到头文件搜索路径 |
| `Add source and header of this folder` | 添加当前文件夹所有源文件 + 头文件路径 |
| `Recursively add source and header of this folder` | 递归添加 |
| `Remove source from build` | 移除源文件 |
| `Remove header search path` | 移除头文件路径 |
| `Remove source and header of this folder` | 移除文件夹条目 |
| `Recursively remove source and header of this folder` | 递归移除 |
| `Lock this path (exact)` | 锁定文件/文件夹；文件夹可选 exact 或 recursive |
| `CMake Build: Rebuild build list from workspace scan` | 扫描工作区并重建 |
| `CMake Build: Clear all managed sources and headers` | 清空所有条目 |
| `CMake Build: Build Rename Index` | 构建 MD5 重命名索引 |
| `CMake Build: Detect Renames` | 检测重命名/移动的文件 |

### 系统要求

- [CMake Tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) 扩展
- 工作区根目录存在 `CMakeLists.txt`

### 托管文件格式

`cmake_manager_gen/ManagedLists.cmake`（路径可通过 `managedListsPath` 配置）：

```cmake
# =============================================================================
#  用户管理的 CMake 源文件和头文件路径。
#
#  要使用此文件，请在根 CMakeLists.txt 中添加：
#
#      include(cmake_manager_gen/ManagedLists.cmake)
# =============================================================================

set(USER_SOURCES
    src/main.c
    src/utils.c
)

set(USER_HEADERS
    src/
    lib/include/
)

if(TARGET ${CMAKE_PROJECT_NAME}.elf)
    target_sources(${CMAKE_PROJECT_NAME}.elf PRIVATE
        ${USER_SOURCES}
    )

    target_include_directories(${CMAKE_PROJECT_NAME}.elf PRIVATE
        ${USER_HEADERS}
    )
endif()
```

> 目标名（`${CMAKE_PROJECT_NAME}.elf`）可通过 `cmakeBuildListManager.targetName` 配置。
