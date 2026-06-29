# Changelog

## 0.0.3-rc.5

- Make chat cards open Codex on click and remove the dedicated Open button.
- Add inline confirmation pills for archive, delete chat, and delete project.
- Add chat deletion with state backups.
- Add live title filtering, live project filtering, and separate full-text
  search results grouped by project.
- Update tags without a full list refresh and display tags without a leading
  hash.
- Replace native drag/drop with pointer dragging for a better grabbing cursor.
- Show project counts before project names and replace the **No Project** chip
  with a compact clear-selection control.
- Slightly reduce chat title font size and weight.

## 0.0.3-rc.4

- Compact chat cards so metadata and action icons share the first row.
- Move the chat title and expand chevron onto a dedicated second row.
- Replace popup tag creation with an inline tag input.
- Let chat titles and project names be edited in place and saved on blur.
- Remove project drag helper text and rely on target highlighting while dragging.
- Slightly reduce icon sizing across the webview.
- Keep search and projects fixed while only the chat list scrolls.
- Rename the sidebar container to **Codex Chats Explorer**.
- Make the Open action try the Codex extension's local chat route before
  falling back to the Markdown transcript.

## 0.0.3-rc.3

- Change project filtering from multi-select to a single active project.
- Replace remaining text chat actions with borderless icon buttons.
- Replace project overflow menus with inline rename/delete icons.
- Use chevron-up/down title expansion controls and animate title expansion.
- Improve drag feedback with a custom drag preview and stronger project target highlight.

## 0.0.3-rc.2

- Add a project filter/drop section above the chat list.
- Default to showing **No Project** chats when no project filter is selected.
- Clamp long chat titles to two lines with an expand/collapse control.
- Replace text toolbar buttons with compact icon controls in the webview.
- Remove the VS Code view-title toolbar buttons.
- Replace the old tag editor button with inline add/remove tag controls.
- Remove Resume, Move, and Copy ID from chat card actions.

## 0.0.3-rc.1

- Mark the Codex Chats contribution as a webview view so VS Code attaches the
  webview provider instead of expecting a tree data provider.

## 0.0.3-rc.0

- Replace the tree with a card-based webview organizer.
- Add custom organizer projects with create, rename, delete, and drag/drop move.
- Add a built-in **No Project** section for unassigned chats.
- Show each chat's title, last edited time, transcript size, and colored folder label.
- Store project metadata in the organizer sidecar file.

## 0.0.2

- Add a diagnostics output channel and visible tree status rows for load errors.
- Add **Codex Chats: Show Diagnostics**.

## 0.0.1

- Initial local-only Codex chat organizer.
- Browse chats from Codex local state.
- Search metadata, tags, and transcript content.
- Rename chats in Codex state.
- Archive and unarchive chats in Codex state.
- Store organizer tags in sidecar metadata.
- Back up Codex state before mutations.
