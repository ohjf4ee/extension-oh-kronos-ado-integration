// Hours synchronization logic for ADO tasks
// Handles reading/writing hours tables to ADO task comments

import { CONFIG } from '../config.js';
import * as adoUtils from './utils.js';
import * as generalUtils from '../utils.js';

const LOG_PREFIX = "\x1B[1mEXTENSION Kronos-ADO-integration[ado/hours-sync.js]:\x1B[m ";

/**
 * Update task hours in ADO - writes hours table to comment and updates CompletedWork field
 * @param {Object} params - Parameters object
 * @param {Object} params.adoApi - AdoApiClient instance
 * @param {string|number} params.taskId - Task ID to update
 * @param {Object} params.task - Task details (project, title, etc.)
 * @param {Object} params.allocations - Allocations by day
 * @param {number} params.periodOffset - Current period offset
 * @returns {Promise<{success: boolean, runningTotal: number, error?: string}>}
 */
export async function updateTaskHours({ adoApi, taskId, task, allocations, periodOffset }) {
    const project = task?.project;
    if (!project) {
        return { success: false, runningTotal: 0, error: "No project found for task" };
    }

    try {
        // Fetch current description AND comments in parallel
        const [description, comments] = await Promise.all([
            adoApi.getWorkItemDescription(project, taskId),
            adoApi.getWorkItemComments(project, taskId)
        ]);

        // Check if hours table exists in description (legacy) or comments (new)
        const descriptionHasHoursTable = adoUtils.containsHoursTable(description);
        const hoursCommentInfo = adoUtils.findHoursComment(comments);

        // Parse existing rows - from comment if exists, otherwise from description (migration)
        const sourceHtml = hoursCommentInfo ? hoursCommentInfo.comment.text : description;
        let rowsData = adoUtils.parseHoursTableRows(sourceHtml);

        // Update with current period's data
        const { periodStart } = generalUtils.getCurrentPeriodRange(CONFIG.PAYROLL_FIRST_DAY, periodOffset);
        for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
            const currentDate = new Date(periodStart);
            currentDate.setDate(periodStart.getDate() + dayIndex);
            const dateString = generalUtils.formatDateAsYYYYMMDD(currentDate);
            const dateDisplayString = `${dateString} ${currentDate.toLocaleDateString(undefined, { weekday: 'short' })}`;
            const dayHours = (allocations[dateString] || [])
                .filter(allocation => String(allocation.taskId) === String(taskId))
                .reduce((sum, allocation) => sum + (parseFloat(allocation.hours) || 0), 0);

            const existing = rowsData.find(row => row.date.startsWith(dateString));
            if (existing) {
                existing.hours = dayHours;
            } else if (dayHours !== 0) {
                rowsData.push({ date: dateDisplayString, hours: dayHours });
            }
        }

        // Sort by date
        rowsData.sort((rowA, rowB) => new Date(rowA.date.slice(0, 10) + 'T00:00:00') - new Date(rowB.date.slice(0, 10) + 'T00:00:00'));

        // Build table HTML
        const { tableHtml, runningTotal } = adoUtils.buildHoursTableHtml(rowsData);

        // Build comment text with warning note
        const commentText = `${CONFIG.HOURS_COMMENT_NOTE}<br><br>${tableHtml}`;

        // Build PATCH operations for CompletedWork field
        const ops = [
            { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.CompletedWork", value: Math.round(runningTotal * 10) / 10 }
        ];

        // If migrating from description, also clear the hours table from description
        if (descriptionHasHoursTable && !hoursCommentInfo) {
            const cleanedDescription = adoUtils.removeHoursTableFromHtml(description);
            // Also remove the old note if present
            const oldNoteRegex = /(<br\s*\/?>\s*)*[Cc]hild task is used for tracking ("|&quot;)Completed Work("|&quot;) hours \(that are sent via a batch job to Planview\)/g;
            const finalDescription = cleanedDescription.replace(oldNoteRegex, '').trim();
            ops.push({ op: "add", path: "/fields/System.Description", value: finalDescription });
        }

        // Update work item fields
        const updateResult = await adoApi.updateWorkItem(project, taskId, ops);
        if (!updateResult) {
            return { success: false, runningTotal, error: "Failed to update work item fields" };
        }

        // Create or update hours comment
        if (hoursCommentInfo) {
            await adoApi.updateWorkItemComment(project, taskId, hoursCommentInfo.id, commentText);
        } else {
            await adoApi.addWorkItemComment(project, taskId, commentText);
        }

        return { success: true, runningTotal };

    } catch (error) {
        console.error(LOG_PREFIX + "Failed to update ADO task:", error);
        return { success: false, runningTotal: 0, error: error.message || "Unknown error" };
    }
}

/**
 * Sync allocations with ADO - reads hours from task comments/descriptions
 * @param {Object} params - Parameters object
 * @param {Object} params.adoApi - AdoApiClient instance
 * @param {Object} params.allocations - Current browser allocations
 * @param {number} params.periodOffset - Current period offset
 * @param {Object} params.tasksCache - Cache to store task details
 * @returns {Promise<{allocations: Object, success: boolean}>}
 */
export async function syncAllocationsWithAdo({ adoApi, allocations, periodOffset, tasksCache }) {
    try {
        const { periodStart, periodEnd } = generalUtils.getCurrentPeriodRange(CONFIG.PAYROLL_FIRST_DAY, periodOffset);
        const taskIds = generalUtils.getUniqueTaskIdsInPeriod(allocations, periodStart, periodEnd);

        if (taskIds.length === 0) {
            return { allocations, success: true };
        }

        // Fetch task details in parallel
        const taskDetailsPromises = taskIds.map(id => adoApi.loadTaskDetails(id, true));
        const allTaskDetails = await Promise.all(taskDetailsPromises);

        // Build ADO allocations from task comments (or descriptions for unmigrated tasks)
        const adoAllocations = {};
        for (let i = 0; i < 7; i++) {
            const loopDate = new Date(periodStart);
            loopDate.setDate(periodStart.getDate() + i);
            adoAllocations[generalUtils.formatDateAsYYYYMMDD(loopDate)] = [];
        }

        for (let i = 0; i < taskIds.length; i++) {
            const taskId = taskIds[i];
            const taskDetails = allTaskDetails[i];
            if (!taskDetails) continue;

            // Cache task info
            if (tasksCache) {
                tasksCache[taskId] = taskDetails;
            }

            // Try to get hours from comment first, fall back to description
            const dailyHours = await extractDailyHoursFromTask({
                adoApi,
                taskId,
                project: taskDetails.project,
                description: taskDetails.description
            });

            for (const [dateStr, hours] of Object.entries(dailyHours)) {
                const entryDate = new Date(dateStr + 'T00:00:00');
                if (entryDate >= periodStart && entryDate <= periodEnd && hours > 0) {
                    if (!adoAllocations[dateStr]) adoAllocations[dateStr] = [];
                    adoAllocations[dateStr].push({
                        taskId,
                        hours,
                        confirmed: true,
                        source: 'ado'
                    });
                }
            }
        }

        // Merge allocations (ADO wins)
        const mergedAllocations = generalUtils.mergeAllocations(allocations, adoAllocations, 'ado-wins');

        return { allocations: mergedAllocations, success: true };

    } catch (error) {
        console.error(LOG_PREFIX + "Error syncing with ADO:", error);
        return { allocations, success: false };
    }
}

/**
 * Extract daily hours from a task (checks comment first, falls back to description)
 * @param {Object} params - Parameters object
 * @param {Object} params.adoApi - AdoApiClient instance
 * @param {string|number} params.taskId - Task ID
 * @param {string} params.project - Project name
 * @param {string} params.description - Optional pre-fetched description
 * @returns {Promise<Object>} - Object keyed by date (YYYY-MM-DD) with hours values
 */
export async function extractDailyHoursFromTask({ adoApi, taskId, project, description }) {
    if (!adoApi || !taskId || !project) return {};

    try {
        // Try to get hours from comment first (migrated tasks)
        const comments = await adoApi.getWorkItemComments(project, taskId);
        const hoursCommentInfo = adoUtils.findHoursComment(comments);

        if (hoursCommentInfo) {
            return adoUtils.extractDailyHoursFromHtml(hoursCommentInfo.comment.text, taskId);
        }

        // Fall back to description (unmigrated tasks)
        const desc = description ?? await adoApi.getWorkItemDescription(project, taskId);
        return adoUtils.extractDailyHoursFromHtml(desc, taskId);

    } catch (error) {
        console.error(LOG_PREFIX + `Error extracting hours from task ${taskId}:`, error);
        return {};
    }
}

/**
 * Recover allocations from ADO comments when local storage is empty.
 *
 * This function is called when the extension detects that local storage has no
 * allocation data (e.g., after clearing data or installing on a new machine).
 * It searches ADO for tasks with hours-tracking comments and reconstructs the
 * allocations-by-day structure.
 *
 * @param {Object} params - Parameters object
 * @param {Object} params.adoApi - AdoApiClient instance
 * @param {number} params.daysBack - Days to search back (default 14 = one pay period)
 * @returns {Promise<{allocations: Object, tasksFound: number}>}
 *   - allocations: Object keyed by date (YYYY-MM-DD) with arrays of allocation objects
 *   - tasksFound: Number of tasks that had recoverable hours data
 */
export async function recoverAllocationsFromAdo({ adoApi, daysBack = 14 }) {
    if (!adoApi) {
        console.warn(LOG_PREFIX + "No adoApi provided for recovery");
        return { allocations: {}, tasksFound: 0 };
    }

    console.debug(LOG_PREFIX + `Starting allocation recovery (${daysBack} days back)...`);

    try {
        // Find all tasks with hours-tracking comments
        const tasksWithComments = await adoApi.findRecentHoursComments(daysBack);

        if (tasksWithComments.length === 0) {
            console.debug(LOG_PREFIX + "No tasks with hours comments found for recovery");
            return { allocations: {}, tasksFound: 0 };
        }

        // Build allocations object from the recovered comments.
        // Structure: { "YYYY-MM-DD": [ {taskId, hours, confirmed, source}, ... ] }
        const allocations = {};

        for (const { taskId, commentText } of tasksWithComments) {
            // Parse the hours table from the comment HTML
            const dailyHours = adoUtils.extractDailyHoursFromHtml(commentText, taskId);

            // Add each date's hours to the allocations structure
            for (const [dateStr, hours] of Object.entries(dailyHours)) {
                if (hours <= 0) continue;

                if (!allocations[dateStr]) {
                    allocations[dateStr] = [];
                }

                // Check if this task is already in the day's allocations (shouldn't happen, but be safe)
                const existingIndex = allocations[dateStr].findIndex(
                    a => String(a.taskId) === String(taskId)
                );

                if (existingIndex >= 0) {
                    // Update existing entry (take the higher value)
                    allocations[dateStr][existingIndex].hours = Math.max(
                        allocations[dateStr][existingIndex].hours,
                        hours
                    );
                } else {
                    // Add new allocation entry
                    allocations[dateStr].push({
                        taskId,
                        hours,
                        confirmed: true,
                        source: 'ado'  // Mark as recovered from ADO
                    });
                }
            }
        }

        const tasksFound = tasksWithComments.length;
        const datesRecovered = Object.keys(allocations).length;
        console.debug(LOG_PREFIX + `Recovery complete: ${tasksFound} tasks, ${datesRecovered} dates`);

        return { allocations, tasksFound };

    } catch (error) {
        console.error(LOG_PREFIX + "Error during allocation recovery:", error);
        return { allocations: {}, tasksFound: 0 };
    }
}
