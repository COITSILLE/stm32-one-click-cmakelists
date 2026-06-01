# Change Log

## [2.0.1] - 2026-06-01

### Fixed
- **Rename detection performance**: `onDidRenameFiles` now filters by watched extensions before triggering full workspace scan and MD5 hashing. Previously any file rename (`.txt`, `.md`, etc.) would trigger an expensive scan.
- **Lock UX**: duplicate check now runs before the exact/recursive QuickPick, so users no longer waste time picking a mode for an already-locked folder.
- **Lock command title**: changed from `Lock this path (exact)` to `Lock this path...` — the old title was misleading for folders which support both exact and recursive modes.

### Changed
- **README**: added prominent guidance for new projects — configure `lockDirs` *before* running rebuild, otherwise generated code and HAL drivers get swept into the build list.
- **README**: updated lock command entry to reflect the new title.

### Removed
- Dead code `ensureVariableInTargetCommand` in `cmakeEditor.js` (hardcoded `${CMAKE_PROJECT_NAME}`, never called).
- Unreachable `Cannot lock the workspace root` warning in `lockPath` handler.

## [2.0.0] - 2026-05-31

> Major upgrade of STM32 CMake Build Manager (`stm32-cmake-build-manager`).

### Breaking Changes
- **Standalone CMake file**: no longer modifies root `CMakeLists.txt` directly; writes to `cmake_manager_gen/ManagedLists.cmake` instead. Requires user to manually `include()`.
- **Removed CubeMX auto-sync**: `syncCubeMxLockDirs` command removed; use manual `lockDirs` instead.
- **Config key change**: prefix changed from `stm32-cmake-build-list-manager` to `cmakeBuildListManager`.
- **Command prefix change**: command IDs now use `cmake-build-list-manager` prefix.
- **Rename method changed**: text-based mapping replaced by MD5 content-hash auto-detection.

### Added
- MD5 content-hash rename detection (ported from Renesas RA version).
- Modular architecture: `src/utils.js`, `src/lockRules.js`, `src/cmakeTools.js`, `src/renames.js`, `src/fileWatcher.js`.
- Auto-create `ManagedLists.cmake` on first activation and prompt user for the `include()` line.
- **File creation monitoring**: when a `.c/.cpp/.h/.hpp` file is created, prompts the user to add the source and/or header folder to the build list.
- **File deletion monitoring**: when a file is deleted, auto-removes it from the build list and cleans up the header folder if the directory becomes empty.
- **Right-click lock**: lock any file or folder in the Explorer via context menu, with exact/recursive mode QuickPick for folders.
- **File-level locking**: lock rules now support locking individual source/header files in addition to directories.
- **Editable template**: generated `ManagedLists.cmake` includes usage instructions and commented examples.
- **Resilient rebuild**: re-creates `ManagedLists.cmake` on-the-fly if the file was deleted before running the rebuild command.

### Added settings
- `cmakeBuildListManager.managedListsPath` — custom path for the managed CMake file.
- `cmakeBuildListManager.targetName` — custom CMake target name (default `${CMAKE_PROJECT_NAME}.elf`).
- `cmakeBuildListManager.watchedExtensions` — file extensions to watch for auto-add/remove.
- `cmakeBuildListManager.ignoredDirectories` — directories skipped during workspace scan (prevents `build/` leakage).

## [1.1.0] - 2026-05-03

### Added
- Sync `USER_SOURCES` and `USER_HEADERS` when managed files are renamed inside VS Code.
- Added rename preview flow for Explorer rename events.
- Added manual `Preview Rename Mappings` command for pasting old/new path pairs.

### Behavior
- Normalizes rename paths to workspace-relative form before matching CMake entries.
- Updates only the root `CMakeLists.txt` user lists and refreshes CMake state after applying changes.

## [1.0.1] - 2026-04-13

### Fixed
- Slim package

## [1.0.0] - 2026-04-12

### Added
- Initial public release of STM32 CMake Build List Manager.
- Explorer context-menu commands for source files and folders to add/remove managed entries.
- Command palette actions:
	- `STM32 CMake Build Manager: Rebuild USER_SOURCES/USER_HEADERS`
	- `STM32 CMake Build Manager: Clear USER_SOURCES/USER_HEADERS`
	- `STM32 CMake Build Manager: Sync CubeMX Paths To lockDirs`
- `STM32 Build List` explorer tree view to inspect and remove managed sources/headers.
- `stm32-cmake-build-list-manager.lockDirs` setting with support for:
	- string entries (recursive lock rule)
	- object entries (`path`, `mode`, `group`)

### Behavior
- Uses CMake Tools API (`ms-vscode.cmake-tools`) as the runtime source of project state.
- Parses CubeMX CMakeLists path tokens and updates auto lock rules for generated paths.
- Applies lock rules consistently across add/remove/rebuild operations.
- Recursive header management targets directories that actually contain header files.

### Notes
- Requires workspace root `CMakeLists.txt` and the CMake Tools extension.
