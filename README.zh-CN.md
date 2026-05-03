# STM32 CMake Build List Manager

[English README](https://github.com/COITSILLE/stm32-one-click-cmakelists/blob/main/README.md)

通过在 VS Code 中管理 `CMakeLists.txt` 里的 `USER_SOURCES` 和 `USER_HEADERS`，你可以直接从资源管理器添加源码文件和头文件搜索路径，而不用手动编辑 CMake。

同时支持锁定路径规则，用来保护指定文件夹不被误改。

当你在 VS Code 资源管理器里重命名已被管理的 `.c`、`.cpp`、`.h`、`.hpp` 文件时，扩展会先预览并同步根目录 `CMakeLists.txt` 里的 `USER_SOURCES` / `USER_HEADERS` 条目。

## 使用前提

- 工程是 STM32CubeMX 生成的 CMake STM32 工程。
- 工作区根目录包含 `CMakeLists.txt`。
- 已安装 CMake Tools 扩展 `ms-vscode.cmake-tools`。

## 资源管理器右键菜单

**在源码文件 (`.c`/`.cpp`) 上：**
- `Add source to build`：将当前文件加入 `USER_SOURCES`。
- `Remove source from build`：从 `USER_SOURCES` 中移除当前文件。

**在文件夹上：**
- `Add header path`：将当前文件夹加入 `USER_HEADERS` 作为头文件搜索路径。
- `Add source and header of this folder`：把当前文件夹中的 `.c`/`.cpp` 文件加入 `USER_SOURCES`，并把当前文件夹加入 `USER_HEADERS`。
- `Recursively add source and header of this folder`：递归扫描当前文件夹，把所有 `.c`/`.cpp` 加入 `USER_SOURCES`，并把包含头文件的子目录加入 `USER_HEADERS`。
- `Remove header search path`：从 `USER_HEADERS` 中移除当前文件夹。
- `Remove source and header of this folder`：移除当前文件夹下的源码项和头文件搜索路径。
- `Recursively remove source and header of this folder`：递归移除源码项和头文件搜索路径。

## 命令面板

- `STM32 CMake Build Manager: Rebuild USER_SOURCES/USER_HEADERS`：扫描工作区并重建两个列表，带预览确认。
- `STM32 CMake Build Manager: Preview Rename Mappings`：粘贴 old/new 路径映射，预览并应用 CMake 列表更新。
- `STM32 CMake Build Manager: Clear USER_SOURCES/USER_HEADERS`：清空两个列表，并自动触发 CMake Configure。
- `STM32 CMake Build Manager: Sync CubeMX Paths To lockDirs`：根据 CubeMX 路径同步 `lockDirs`。

## 树视图

资源管理器里的 `STM32 Build List` 会显示当前已管理的源码和头文件路径。右键条目可以直接移除。

## 配置

**`stm32-cmake-build-list-manager.lockDirs`**

锁定规则用于保护文件夹不被 add/remove/rebuild 逻辑修改。支持的格式：
- 字符串：按递归规则处理。
- 对象：`{ "path": "...", "mode": "exact|recursive", "group": "..." }`

示例：

```json
"stm32-cmake-build-list-manager.lockDirs": [
  "Middlewares/Third_Party",
  {
    "path": "Drivers/CMSIS",
    "mode": "recursive",
    "group": "CubeMX Auto"
  }
]
```
