[简体中文说明 / Chinese README](README.zh-CN.md)

# STM32 CMake Build List Manager

Manage `USER_SOURCES` and `USER_HEADERS` in `CMakeLists.txt` from VS Code Explorer, so you can add source files and header search paths to STM32 CMake builds without manual edits.

Lock rules are also supported to prevent accidental changes in protected folders.

### Requirements

- Workspace is an STM32CubeMX-generated CMake STM32 project.
- Workspace root contains `CMakeLists.txt`.
- CMake Tools extension (`ms-vscode.cmake-tools`) is installed.

### Context menu operations

**On source files (`.c`/`.cpp`):**
- `Add source to build`: Add this file to `USER_SOURCES`.
- `Remove source from build`: Remove this file from `USER_SOURCES`.

**On folders:**
- `Add header path`: Add this folder to `USER_HEADERS` (include search path).
- `Add source and header of this folder`: Add `.c`/`.cpp` files in this folder to `USER_SOURCES`, and add this folder to `USER_HEADERS`.
- `Recursively add source and header of this folder`: Recursively scan, add all `.c`/`.cpp` to `USER_SOURCES`, and add all subdirectories containing header files to `USER_HEADERS`.
- `Remove header search path`: Remove this folder from `USER_HEADERS`.
- `Remove source and header of this folder`: Remove sources and header path of this folder.
- `Recursively remove source and header of this folder`: Recursively remove sources and header paths.

### Command palette

- `STM32 CMake Build Manager: Rebuild USER_SOURCES/USER_HEADERS`: Scan workspace files and rebuild both lists (with preview confirmation).
- `STM32 CMake Build Manager: Clear USER_SOURCES/USER_HEADERS`: Clear both lists and automatically trigger CMake Configure.
- `STM32 CMake Build Manager: Sync CubeMX Paths To lockDirs`: Update `lockDirs` from CubeMX paths.

### Tree view

`STM32 Build List` in Explorer shows current managed sources and header paths. Right-click items to remove them directly.

### Configuration

**`stm32-cmake-build-list-manager.lockDirs`**

Lock rules protect folders from add/remove/rebuild operations. Supported formats:
- String: treated as a recursive rule.
- Object: `{ "path": "...", "mode": "exact|recursive", "group": "..." }`

Example:

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

