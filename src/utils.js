// Utility functions for Kronos-ADO integration
// Pure functions with no external dependencies
// Note: ADO-specific utilities are in src/ado/utils.js

/**
 * Calculate the difference between allocated and worked hours
 * @param {number} allocated - Hours allocated to tasks
 * @param {number} worked - Hours actually worked (from Kronos)
 * @returns {{text: string, className: string}} - Display text and CSS class
 */
export function calculateAllocationDifference(allocated, worked) {
    const difference = allocated - worked;
    if (Math.abs(difference) < 0.01) {
        return { text: "", className: "alloc-diff-na" };
    }
    if (difference < 0) {
        return { text: `-${Math.abs(difference).toFixed(1)}`, className: "alloc-diff-under" };
    }
    return { text: `+${difference.toFixed(1)}`, className: "alloc-diff-over" };
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text - Raw text
 * @returns {string} - HTML-escaped text
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Format a date as YYYY-MM-DD for storage keys
 * @param {Date} date - The date to format
 * @returns {string} - Formatted date string (e.g., "2025-01-15")
 */
export function formatDateAsYYYYMMDD(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Calculate the payroll period date range
 * @param {Date} firstDay - The first day of the first payroll period ever (anchor date)
 * @param {number} periodOffset - Offset from current period (0 = current, -1 = previous, +1 = next)
 * @returns {{periodStart: Date, periodEnd: Date}}
 */
export function getCurrentPeriodRange(firstDay, periodOffset = 0) {
    const now = new Date();

    // Calculate day difference using date arithmetic, not milliseconds (DST-safe)
    const firstDayMidnight = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate());
    const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffTime = nowMidnight - firstDayMidnight;
    const diffDays = Math.floor(diffTime / 86400000);
    const dayOffset = Math.floor(diffDays / 7) * 7;

    const periodStart = new Date(firstDay);
    periodStart.setDate(firstDay.getDate() + dayOffset + periodOffset * 7);
    const periodEnd = new Date(periodStart);
    periodEnd.setDate(periodStart.getDate() + 6);
    return { periodStart, periodEnd };
}

/**
 * Extract all task IDs that appear in the allocations for a given period
 * @param {Object} allocationsByDay - Object keyed by date string (YYYY-MM-DD)
 * @param {Date} periodStart - First day of the period
 * @param {Date} periodEnd - Last day of the period (unused, assumes 7-day period)
 * @returns {string[]} - Array of unique task IDs
 */
export function getUniqueTaskIdsInPeriod(allocationsByDay, periodStart, periodEnd) {
    const taskIds = new Set();

    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        const currentDate = new Date(periodStart);
        currentDate.setDate(periodStart.getDate() + dayIndex);
        const dateString = formatDateAsYYYYMMDD(currentDate);
        const dailyAllocations = allocationsByDay[dateString] || [];

        dailyAllocations.forEach(allocation => {
            if (allocation.taskId && String(allocation.taskId).trim()) {
                taskIds.add(String(allocation.taskId));
            }
        });
    }

    return Array.from(taskIds);
}

/**
 * Calculate total allocated hours from an array of allocations
 * @param {Array} allocations - Array of allocation objects with 'hours' property
 * @returns {number} - Sum of hours
 */
export function calculateTotalAllocatedHours(allocations) {
    return allocations.reduce((sum, allocation) => sum + (parseFloat(allocation.hours) || 0), 0);
}

/**
 * Merge browser allocations with ADO allocations
 * @param {Object} browserAllocations - Local allocations keyed by date
 * @param {Object} adoAllocations - Allocations from ADO keyed by date
 * @param {string} strategy - Merge strategy ('ado-wins' is default)
 * @returns {Object} - Merged allocations
 */
export function mergeAllocations(browserAllocations, adoAllocations, strategy = 'ado-wins') {
    const merged = { ...browserAllocations };

    for (const [date, adoTasks] of Object.entries(adoAllocations)) {
        if (strategy === 'ado-wins') {
            // ADO is source of truth - replace browser data for tasks that exist in ADO
            const browserTasks = merged[date] || [];
            const adoTaskIds = new Set(adoTasks.map(task => String(task.taskId)));

            // Keep browser tasks that don't exist in ADO, replace those that do
            const filteredBrowserTasks = browserTasks.filter(task => !adoTaskIds.has(String(task.taskId)))
                .map(task => ({
                    ...task,
                    source: task.source || 'manual'
                }));

            // Convert ADO tasks to browser format
            const convertedAdoTasks = adoTasks.map(task => ({
                taskId: task.taskId,
                hours: task.hours,
                confirmed: task.confirmed,
                source: task.source || 'ado'
            }));

            merged[date] = [...filteredBrowserTasks, ...convertedAdoTasks];
        }
    }

    return merged;
}
