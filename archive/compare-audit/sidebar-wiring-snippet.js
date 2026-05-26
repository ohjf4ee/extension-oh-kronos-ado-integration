// Piece of src/timecard-sidebar.js that has to be re-added to wire up the
// Compare & Audit button. Source: develop branch tip (commit 8d79898),
// src/timecard-sidebar.js. Not present in main.
//
// Paste inside the existing initialization block in src/timecard-sidebar.js,
// alongside the other button handlers (e.g. near the Copy / Copy Pivot
// button wiring). compare-audit.js attaches window.compareAuditFunctions,
// so this handler just forwards to it.
//
// Prerequisite: window.timecardFunctions must already be exported by
// timecard-sidebar.js (it is on main today) so compare-audit.js can call
// loadTasksFromADO, loadLocal, etc. through it.

// Compare audit button
const compareAuditBtn = document.getElementById("compare-audit-btn");
if (compareAuditBtn) {
    compareAuditBtn.addEventListener("click", () => {
        if (window.compareAuditFunctions?.generateADOTaskReport) {
            window.compareAuditFunctions.generateADOTaskReport();
        } else {
            console.error(LOG_PREFIX + "Compare & Audit functions not loaded");
        }
    });
}
