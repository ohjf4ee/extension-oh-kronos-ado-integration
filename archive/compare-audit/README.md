# archive/compare-audit

Preserved (but not active) "Compare & Audit" sidebar feature.

## Origin

Transplanted from a now-deleted `develop` branch in this repo. `develop`
shared no common ancestor with `main` — it was a separate, parallel line
of development that accumulated features `main` never picked up. Last
commit on `develop` was `8d79898 btns for distribution, leveling`
(2026-02-20). The branch itself is gone; this folder is the only
surviving copy of the feature.

## Status

Archived, not wired up. None of these files are loaded by
[`manifest.json`](../../manifest.json) or
[`src/timecard-sidebar.html`](../../src/timecard-sidebar.html). The
extension runs without them.

## What the feature does

Adds a **Compare & Audit** button to the sidebar. When clicked it:

1. Prompts the user to paste text copied from a Planview team dashboard
   (Ctrl+A / Ctrl+C on that page, then paste).
2. Loads ADO tasks and the locally stored `allocationsByDay` history.
3. Pulls work-item revisions for the referenced tasks to extract daily
   hours from task comments / descriptions for the current week and the
   previous week.
4. Renders a per-week report table with rows tagged `audit-match`,
   `audit-warning`, or `audit-error` based on how the dashboard, the
   sidebar allocations, and the ADO task data line up.
5. Also renders an hours-change pivot table for the selected period.

Public API: `window.compareAuditFunctions.generateADOTaskReport`.

## Files

| File | What it is |
| --- | --- |
| `compare-audit.js` | The full 722-line module verbatim from `develop:src/ui/compare-audit.js`. Self-contained except for its calls into `window.timecardFunctions` and `chrome.storage.local`. |
| `sidebar-snippet.html` | Three pieces that must be re-added to `src/timecard-sidebar.html`: the report-section / audit CSS rules, the `#report-section` and `#dashboard-input-modal` markup, and the `<script src="ui/compare-audit.js">` tag. Each piece is labeled inline. |
| `sidebar-wiring-snippet.js` | The click handler from `develop:src/timecard-sidebar.js` that forwards the Compare & Audit button to `window.compareAuditFunctions.generateADOTaskReport`. |

## Why it isn't just dropped into `src/ui/`

`compare-audit.js` was written against the shape `window.timecardFunctions`
and the storage layer had on `develop`. `main`'s
[`src/timecard-sidebar.js`](../../src/timecard-sidebar.js),
[`src/storage.js`](../../src/storage.js), and
[`src/ado/api-client.js`](../../src/ado/api-client.js) have drifted
independently. At a minimum the calls below need to be checked against
the current shape on `main` before the feature will run:

- `window.timecardFunctions.loadTasksFromADO(forceRefresh)`
- `window.timecardFunctions.loadLocal("odhKronos_allocationsByDay")` and
  any other `loadLocal` keys referenced inside the module
- `window.timecardFunctions.loadTaskDetails(taskId, includeExtraFields)`
- `window.timecardFunctions.extractDailyHoursFromTaskComment(...)`
- `window.timecardFunctions.getCurrentPeriodRange()`
- Any direct `chrome.runtime.sendMessage` / ADO REST calls inside
  `fetchWorkItemRevisions` — confirm the same auth path is still used by
  the active code on `main`.

## To reactivate

1. Copy `compare-audit.js` to `src/ui/compare-audit.js`.
2. Splice the three sections from `sidebar-snippet.html` into
   `src/timecard-sidebar.html` at the locations indicated by the inline
   comments.
3. Splice `sidebar-wiring-snippet.js` into `src/timecard-sidebar.js`
   alongside the other button handlers.
4. Walk through every `window.timecardFunctions.*` and `loadLocal(...)`
   call in `compare-audit.js`. Re-point any that no longer exist.
5. Load the unpacked extension, open the sidebar, click Compare & Audit,
   and check the console for missing-function errors before declaring
   it working.
