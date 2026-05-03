# Change Log

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