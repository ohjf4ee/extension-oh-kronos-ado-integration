// Compare & Audit functionality for the ODH-Kronos-ADO integration extension
// This file contains all functions related to the Compare & Audit button feature

const LOG_PREFIX = "\x1B[1mEXTENSION ODH-Kronos-ADO-integration[timecard-sidebar-compare-audit.js]:\x1B[m ";
console.debug(LOG_PREFIX + "Loading...");

// Helper function to access main timecard functions
function getTimecardFunctions() {
    if (!window.timecardFunctions) {
        throw new Error("Timecard functions not available - ensure timecard-sidebar.js is loaded first");
    }
    return window.timecardFunctions;
}

async function generateADOTaskReport() {
    console.debug(LOG_PREFIX + "START generateADOTaskReport()");
    const generateBtn = document.getElementById("compare-audit-btn");
    const reportOutput = document.getElementById("report-output");

    if (!generateBtn || !reportOutput) return;

    // Clear any previous results immediately
    reportOutput.innerHTML = "";

    // Disable button immediately when clicked
    generateBtn.disabled = true;
    generateBtn.textContent = "Loading...";

    try {
        // Show modal to get dashboard data
        const dashboardData = await showDashboardInputModal();
        if (!dashboardData) {
            console.debug(LOG_PREFIX + "User cancelled dashboard data input");
            generateBtn.disabled = false;
            generateBtn.textContent = "Compare & Audit";
            return;
        }

        generateBtn.textContent = "Generating...";
        reportOutput.innerHTML = "<p>Loading report data...</p>";

        const timecardFunctions = getTimecardFunctions();
        await timecardFunctions.loadTasksFromADO(true); // Force refresh to get latest tasks

        const allocationsByDay = (await timecardFunctions.loadLocal("odhKronos_allocationsByDay")) || {};
        const currentDate = new Date();

        // Calculate this week and last week date ranges
        const thisWeekRange = getWeekRange(currentDate);
        const lastWeekDate = new Date(currentDate);
        lastWeekDate.setDate(lastWeekDate.getDate() - 7);
        const lastWeekRange = getWeekRange(lastWeekDate);

        // Parse dashboard data
        const dashboardEntries = parseDashboardData(dashboardData);

        // Get all referenced task IDs from ALL stored allocations (not just current period)
        const referencedTaskIds = new Set();
        const weekDateKeys = new Set();

        // Pre-calculate all date keys for both weeks for efficiency
        for (let currentDate = new Date(lastWeekRange.start); currentDate <= lastWeekRange.end; currentDate.setDate(currentDate.getDate() + 1)) {
            weekDateKeys.add(currentDate.toISOString().slice(0, 10));
        }
        for (let currentDate = new Date(thisWeekRange.start); currentDate <= thisWeekRange.end; currentDate.setDate(currentDate.getDate() + 1)) {
            weekDateKeys.add(currentDate.toISOString().slice(0, 10));
        }

        Object.entries(allocationsByDay).forEach(([dateStr, dayAllocations]) => {
            // Only process dates that fall within our target weeks
            if (weekDateKeys.has(dateStr)) {
                dayAllocations.forEach(allocation => {
                    if (allocation.taskId) {
                        referencedTaskIds.add(String(allocation.taskId));
                    }
                });
            }
        });

        console.debug(LOG_PREFIX + `Found ${referencedTaskIds.size} referenced tasks for report weeks`);
        console.debug(LOG_PREFIX + `This week range: ${thisWeekRange.start.toISOString().slice(0, 10)} to ${thisWeekRange.end.toISOString().slice(0, 10)}`);
        console.debug(LOG_PREFIX + `Last week range: ${lastWeekRange.start.toISOString().slice(0, 10)} to ${lastWeekRange.end.toISOString().slice(0, 10)}`);
        console.debug(LOG_PREFIX + `Referenced task IDs:`, Array.from(referencedTaskIds));

        if (referencedTaskIds.size === 0) {
            reportOutput.innerHTML = "<p class='report-no-data'>No ADO tasks have been referenced in the sidebar for this week or last week.</p>";
            return;
        }

        // Generate reports for both weeks
        const lastWeekReport = await generateWeekReport(lastWeekRange, allocationsByDay, referencedTaskIds, "Last Week", dashboardEntries);
        const thisWeekReport = await generateWeekReport(thisWeekRange, allocationsByDay, referencedTaskIds, "This Week", dashboardEntries);

        // Generate audit section
        const auditReport = await generateAuditReport(lastWeekRange, thisWeekRange, allocationsByDay, referencedTaskIds);

        // Display the reports
        reportOutput.innerHTML = lastWeekReport + thisWeekReport + auditReport;

    } catch (error) {
        console.error(LOG_PREFIX + "Error generating report:", error);
        reportOutput.innerHTML = "<p style='color: red;'>Error generating report. Please try again.</p>";
    } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = "Compare & Audit";
    }
}

function showDashboardInputModal() {
    return new Promise((resolve) => {
        const modal = document.getElementById("dashboard-input-modal");
        const input = document.getElementById("dashboard-data-input");
        const okBtn = document.getElementById("dashboard-ok-btn");
        const cancelBtn = document.getElementById("dashboard-cancel-btn");

        // Clear previous input
        input.value = "";
        modal.style.display = "block";

        const cleanup = () => {
            modal.style.display = "none";
            okBtn.removeEventListener("click", handleOk);
            cancelBtn.removeEventListener("click", handleCancel);
        };

        const handleOk = () => {
            const data = input.value.trim();
            cleanup();
            resolve(data || null);
        };

        const handleCancel = () => {
            cleanup();
            resolve(null);
        };

        okBtn.addEventListener("click", handleOk);
        cancelBtn.addEventListener("click", handleCancel);

        // Focus the input
        input.focus();
    });
}

function getWeekRange(date) {
    const startOfWeek = new Date(date);
    startOfWeek.setDate(date.getDate() - date.getDay()); // Sunday
    startOfWeek.setHours(0, 0, 0, 0);

    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6); // Saturday
    endOfWeek.setHours(23, 59, 59, 999);

    return { start: startOfWeek, end: endOfWeek };
}

function parseDashboardData(dashboardText) {
    if (!dashboardText) return [];

    const entries = [];
    const lines = dashboardText.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Try to parse as tab-separated (from Excel/spreadsheet paste)
        const tabParts = trimmed.split('\t');
        if (tabParts.length >= 2) {
            const taskId = tabParts[0].trim();
            const hours = parseFloat(tabParts[1]);
            if (!isNaN(hours)) {
                entries.push({ taskId, hours });
                continue;
            }
        }

        // Try to parse various text formats
        // Format: "12345: 8 hours" or "12345 - 8h" or "Task 12345: 8"
        const patterns = [
            /(\d+)[:\-\s]+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)?/i,
            /Task\s+(\d+)[:\-\s]+(\d+(?:\.\d+)?)/i,
            /^(\d+)\s+(\d+(?:\.\d+)?)$/
        ];

        for (const pattern of patterns) {
            const match = trimmed.match(pattern);
            if (match) {
                const taskId = match[1];
                const hours = parseFloat(match[2]);
                if (!isNaN(hours)) {
                    entries.push({ taskId, hours });
                    break;
                }
            }
        }
    }

    console.debug(LOG_PREFIX + `Parsed ${entries.length} dashboard entries:`, entries);
    return entries;
}

async function generateWeekReport(weekRange, allocationsByDay, referencedTaskIds, weekLabel, dashboardEntries) {
    let html = `<div class="report-week-header">${weekLabel} Report (${weekRange.start.toLocaleDateString()} - ${weekRange.end.toLocaleDateString()})</div>`;
    html += `<table class="report-table">`;
    html += `<thead><tr>`;
    html += `<th>Task ID</th>`;
    html += `<th>Task Title</th>`;

    const millisecondsPerDay = 86400000;
    const dayHeaders = [];
    for (let currentDate = new Date(weekRange.start); currentDate <= weekRange.end; currentDate = new Date(currentDate.getTime() + millisecondsPerDay)) {
        const dayName = currentDate.toLocaleDateString('en-US', { weekday: 'short' });
        dayHeaders.push(dayName);
        html += `<th>${dayName}</th>`;
    }

    html += `<th>Task<br/>Total</th>`;
    html += `<th>Dashboard<br/>Hours</th>`;
    html += `<th>Match</th>`;
    html += `</tr></thead><tbody>`;

    const dailyTotals = new Array(7).fill(0);
    let weeklyTaskTotal = 0;
    let weeklyDashboardTotal = 0;

    for (const taskId of referencedTaskIds) {
        const timecardFunctions = getTimecardFunctions();
        const taskDetails = await timecardFunctions.loadTaskDetails(taskId);
        const taskTitle = taskDetails ? taskDetails.title : "Unknown Task";

        const dailyHours = [];
        let taskTotal = 0;

        for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
            const currentDate = new Date(weekRange.start.getTime() + dayIndex * millisecondsPerDay);
            const dateString = currentDate.toISOString().slice(0, 10);
            const dayAllocations = allocationsByDay[dateString] || [];
            const taskAllocation = dayAllocations.find(allocation => String(allocation.taskId) === String(taskId));
            const hours = taskAllocation ? parseFloat(taskAllocation.hours || 0) : 0;

            dailyHours.push(hours);
            taskTotal += hours;
            dailyTotals[dayIndex] += hours;
        }

        if (taskTotal === 0) continue;

        weeklyTaskTotal += taskTotal;

        const dashboardEntry = dashboardEntries.find(entry => String(entry.taskId) === String(taskId));
        const dashboardHours = dashboardEntry ? dashboardEntry.hours : 0;
        weeklyDashboardTotal += dashboardHours;

        const match = Math.abs(taskTotal - dashboardHours) < 0.1 ? '✓' :
                     dashboardHours === 0 ? '?' :
                     'X';

        html += `<tr>`;
        html += `<td><a href="${timecardFunctions.orgUrl}/_workitems/edit/${taskId}" target="_blank">${taskId}</a></td>`;
        html += `<td>${timecardFunctions.escapeHtml(taskTitle)}</td>`;

        for (const hours of dailyHours) {
            const displayHours = hours > 0 ? hours.toFixed(1) : '-';
            html += `<td style="text-align: center;">${displayHours}</td>`;
        }

        html += `<td style="text-align: center; font-weight: bold;">${taskTotal.toFixed(1)}</td>`;
        html += `<td style="text-align: center;">${dashboardHours > 0 ? dashboardHours.toFixed(1) : '-'}</td>`;
        html += `<td style="text-align: center; ${match === 'X' ? 'color: red; font-weight: bold;' : ''}">${match}</td>`;
        html += `</tr>`;
    }

    // Add totals row
    html += `<tr class="report-totals">`;
    html += `<td colspan="2"><strong>Totals</strong></td>`;

    let allDaysTotal = 0;
    for (const dayTotal of dailyTotals) {
        allDaysTotal += dayTotal;
        html += `<td style="text-align: center; font-weight: bold;">${dayTotal > 0 ? dayTotal.toFixed(1) : '-'}</td>`;
    }

    const totalMatch = Math.abs(weeklyTaskTotal - weeklyDashboardTotal) < 0.1 ? '✓' :
                      weeklyDashboardTotal === 0 ? '?' :
                      'X';

    html += `<td style="text-align: center; font-weight: bold;">${weeklyTaskTotal.toFixed(1)}</td>`;
    html += `<td style="text-align: center; font-weight: bold;">${weeklyDashboardTotal > 0 ? weeklyDashboardTotal.toFixed(1) : '-'}</td>`;
    html += `<td style="text-align: center; font-weight: bold; ${totalMatch === 'X' ? 'color: red;' : ''}">${totalMatch}</td>`;
    html += `</tr>`;

    html += `</tbody></table>`;

    return html;
}

async function fetchWorkItemRevisions(taskId, startDate, endDate) {
    const timecardFunctions = getTimecardFunctions();
    const pat = await timecardFunctions.loadLocal("adoPAT");
    if (!timecardFunctions.orgUrl || !pat || !taskId) return [];

    try {
        // Get the task details to find the project
        const task = timecardFunctions.cachedTasks?.find(cachedTask => String(cachedTask.id) === String(taskId));
        if (!task || !task.project) return [];

        // Fetch revision history
        const response = await fetch(
            `${timecardFunctions.orgUrl}/${encodeURIComponent(task.project)}/_apis/wit/workitems/${taskId}/revisions?api-version=7.0`,
            { headers: timecardFunctions.createAdoHeaders(pat) }
        );

        if (!response.ok) return [];
        const data = await response.json();

        // Filter revisions within date range and with Completed Work changes
        const revisions = [];
        let previousCompletedWork = 0;

        for (const revision of data.value) {
            const revDate = new Date(revision.fields["System.ChangedDate"] || revision.fields["System.CreatedDate"]);
            const completedWork = revision.fields["Microsoft.VSTS.Scheduling.CompletedWork"] || 0;

            // Check if Completed Work changed (not just if within date range)
            if (completedWork !== previousCompletedWork) {
                revisions.push({
                    date: revDate,
                    dateStr: revDate.toISOString().slice(0, 10),
                    timeStr: revDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                    previousHours: previousCompletedWork,
                    newHours: completedWork,
                    changeAmount: completedWork - previousCompletedWork,
                    changedBy: revision.fields["System.ChangedBy"] || revision.fields["System.CreatedBy"]
                });
            }
            previousCompletedWork = completedWork;
        }

        return revisions;
    } catch (error) {
        console.error(LOG_PREFIX + `Error fetching revisions for task ${taskId}:`, error);
        return [];
    }
}

async function generateHoursChangePivotTable(periodStart, periodEnd, referencedTaskIds, allocationsByDay) {
    const timecardFunctions = getTimecardFunctions();
    let html = `
        <div class="report-week-header" style="margin-top: 2em;">Hours Change Tracking - Week of ${periodStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
    `;

    // Get all the days in the period for column headers
    const daysInPeriod = [];
    const dayColumns = [];
    for (let currentDate = new Date(periodStart); currentDate <= periodEnd; currentDate.setDate(currentDate.getDate() + 1)) {
        const dateString = currentDate.toISOString().slice(0, 10);
        const dayName = currentDate.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
        daysInPeriod.push(dateString);
        dayColumns.push(dayName);
    }

    // Collect data from sidebar allocations and revision history
    const taskData = {};
    let hasAnyData = false;

    for (const taskId of referencedTaskIds) {
        try {
            const task = timecardFunctions.cachedTasks?.find(cachedTask => String(cachedTask.id) === String(taskId));
            if (!task) continue;

            // Get hours from sidebar allocations for this period
            const hoursPerDay = {};
            for (const dateStr of daysInPeriod) {
                const dayAllocations = allocationsByDay[dateStr] || [];
                const taskAllocation = dayAllocations.find(allocation => String(allocation.taskId) === String(taskId));
                if (taskAllocation && taskAllocation.hours > 0) {
                    hoursPerDay[dateStr] = parseFloat(taskAllocation.hours);
                    hasAnyData = true;
                }
            }

            // Get revision history to find when hours were actually added to ADO
            const allRevisions = await fetchWorkItemRevisions(taskId, new Date('2020-01-01'), new Date());

            if (Object.keys(hoursPerDay).length > 0 || allRevisions.length > 0) {
                taskData[taskId] = {
                    title: task.title || `Task ${taskId}`,
                    hoursPerDay: hoursPerDay,
                    revisions: allRevisions
                };
            }
        } catch (error) {
            console.error(LOG_PREFIX + `Error processing data for task ${taskId}:`, error);
        }
    }

    if (!hasAnyData) {
        html += `<p style="color: #666; font-style: italic;">No hours allocated for tasks during this week.</p>`;
        return html;
    }

    // Build the pivot table
    html += `
        <table class="report-table" style="font-size: 0.85em;">
            <thead>
                <tr>
                    <th style="text-align: left; min-width: 250px;">Task</th>
    `;

    // Add column headers for each day
    for (const dayColumn of dayColumns) {
        html += `<th style="text-align: center; min-width: 80px;">${dayColumn}</th>`;
    }
    html += `<th style="text-align: center; min-width: 80px;">Total</th></tr></thead><tbody>`;

    // Daily totals tracking
    const dailyTotals = {};
    for (const dateStr of daysInPeriod) {
        dailyTotals[dateStr] = 0;
    }

    // Process each task
    for (const [taskId, data] of Object.entries(taskData)) {
        // Main task row - showing hours from sidebar allocations
        let taskTotal = 0;
        html += `<tr style="background-color: #f5f5f5; font-weight: bold;">`;
        html += `<td><a href="${timecardFunctions.orgUrl}/_workitems/edit/${taskId}" target="_blank" style="text-decoration: none; color: #0066cc;">${taskId}</a> ${timecardFunctions.escapeHtml(data.title)}</td>`;

        // Fill in cells for each day with sidebar allocation hours
        for (const dateStr of daysInPeriod) {
            const hours = data.hoursPerDay[dateStr] || 0;
            if (hours > 0) {
                html += `<td style="text-align: center;">${hours.toFixed(1)}</td>`;
                taskTotal += hours;
                dailyTotals[dateStr] += hours;
            } else {
                html += `<td style="text-align: center;">-</td>`;
            }
        }
        html += `<td style="text-align: center; font-weight: bold;">${taskTotal.toFixed(1)}</td>`;
        html += `</tr>`;

        // Detail rows showing when these hours were actually added to ADO
        // Find revisions that happened during or near this period
        const relevantRevisions = data.revisions.filter(rev => {
            const revDate = new Date(rev.dateStr);
            // Show revisions from the week and up to 7 days after (when hours might have been entered)
            const endDatePlus7 = new Date(periodEnd);
            endDatePlus7.setDate(endDatePlus7.getDate() + 7);
            return rev.changeAmount > 0 && revDate >= periodStart && revDate <= endDatePlus7;
        });

        if (relevantRevisions.length > 0) {
            for (const revision of relevantRevisions) {
                html += `<tr style="font-size: 0.9em; color: #666;">`;
                html += `<td style="padding-left: 30px;">Changed ${revision.dateStr} ${revision.timeStr}: ${revision.previousHours.toFixed(1)}h to ${revision.newHours.toFixed(1)}h (+${revision.changeAmount.toFixed(1)}h)</td>`;

                // Empty cells for each day column
                for (const dateStr of daysInPeriod) {
                    html += `<td></td>`;
                }
                html += `<td></td>`;
                html += `</tr>`;
            }
        }
    }

    // Total row
    let weekTotal = 0;
    html += `<tr style="border-top: 2px solid #333; font-weight: bold; background-color: #e8e8e8;">`;
    html += `<td>Daily Totals</td>`;
    for (const dateStr of daysInPeriod) {
        const dayTotal = dailyTotals[dateStr] || 0;
        weekTotal += dayTotal;
        if (dayTotal > 0) {
            html += `<td style="text-align: center;">${dayTotal.toFixed(1)}</td>`;
        } else {
            html += `<td style="text-align: center;">-</td>`;
        }
    }
    html += `<td style="text-align: center; font-weight: bold;">${weekTotal.toFixed(1)}</td>`;
    html += `</tr>`;

    html += `</tbody></table>`;

    html += `
        <div style="margin-top: 1em; font-size: 0.8em; color: #666;">
            <p><strong>Note:</strong> This table shows the hours allocated in the sidebar for each day of the selected week, with details below each task showing when the "Completed Work" field was actually updated in ADO.</p>
        </div>
    `;

    return html;
}

async function generateAuditReport(lastWeekRange, thisWeekRange, allocationsByDay, referencedTaskIds) {
    const timecardFunctions = getTimecardFunctions();
    const hoursByDay = (await timecardFunctions.loadLocal("odhKronos_hoursByDay")) || {};

    let html = `
        <div class="report-week-header" style="margin-top: 2em;">Data Audit & Validation</div>
        <table class="report-table">
            <thead>
                <tr>
                    <th>Audit Check</th>
                    <th>Result</th>
                    <th>Details</th>
                    <th>Proposed Action(s)</th>
                </tr>
            </thead>
            <tbody>
    `;

    // 1. Compare ADO description hours vs allocated hours by day
    const weeks = [
        { name: "Last Week", range: lastWeekRange },
        { name: "This Week", range: thisWeekRange }
    ];

    for (const week of weeks) {
        let kronosTotal = 0;
        let allocatedTotal = 0;
        const dayDetails = [];

        for (let currentDate = new Date(week.range.start); currentDate <= week.range.end; currentDate.setDate(currentDate.getDate() + 1)) {
            const dateString = currentDate.toISOString().slice(0, 10);
            const kronosHours = parseFloat(hoursByDay?.[dateString]?.hours || "0");
            const dayAllocations = allocationsByDay[dateString] || [];
            const allocatedHours = dayAllocations.reduce((sum, allocation) => sum + (allocation.hours || 0), 0);

            kronosTotal += kronosHours;
            allocatedTotal += allocatedHours;

            if (kronosHours > 0 || allocatedHours > 0) {
                const diff = Math.abs(kronosHours - allocatedHours);
                const status = diff < 0.1 ? "OK" : "DIFF";
                dayDetails.push(`${dateString}: Kronos=${kronosHours}, Allocated=${allocatedHours} ${status}`);
            }
        }

        const totalDiff = Math.abs(kronosTotal - allocatedTotal);
        let status = "MATCH";
        let statusClass = "";
        if (totalDiff >= 0.1) {
            if (allocatedTotal > kronosTotal) {
                status = `DIFF: <span style="color: red; font-weight: bold;">+${(allocatedTotal - kronosTotal).toFixed(1)}h</span>`;
            } else {
                status = `DIFF: <span style="color: #cc7000; font-weight: bold;">-${(kronosTotal - allocatedTotal).toFixed(1)}h</span>`;
            }
        }

        let proposedAction = '<em style="color: #707070;">No action needed</em>';
        if (totalDiff >= 0.1) {
            if (kronosTotal > allocatedTotal) {
                proposedAction = `Allocate ${(kronosTotal - allocatedTotal).toFixed(1)} additional hours to tasks for ${week.name.toLowerCase()}`;
            } else {
                proposedAction = `Reduce task allocations by ${(allocatedTotal - kronosTotal).toFixed(1)} hours, or verify Kronos entries for ${week.name.toLowerCase()}`;
            }
        }

        html += `
            <tr>
                <td>${week.name}: Kronos vs Allocated Hours</td>
                <td>${status}</td>
                <td>Kronos: ${kronosTotal.toFixed(1)}h, Allocated: ${allocatedTotal.toFixed(1)}h<br>
                    <small>${dayDetails.join('<br>')}</small></td>
                <td>${proposedAction}</td>
            </tr>
        `;
    }

    // 2. Compare allocated hours vs ADO task description tables
    for (const taskId of referencedTaskIds) {
        try {
            const taskDetails = await timecardFunctions.loadTaskDetails(taskId, true);
            if (!taskDetails) continue;

            const dailyHours = await timecardFunctions.extractDailyHoursFromTaskComment(taskId, taskDetails.project);

            // Calculate totals from allocations for this task (include ALL dates, not just 2-week window)
            let allocatedTotal = 0;
            const allocationDetails = [];

            // Check all dates in allocationsByDay for this task
            for (const [dateString, dayAllocations] of Object.entries(allocationsByDay)) {
                const taskAllocation = dayAllocations.find(allocation => String(allocation.taskId) === String(taskId));
                if (taskAllocation && taskAllocation.hours > 0) {
                    allocatedTotal += taskAllocation.hours;
                    allocationDetails.push(`${dateString}: ${taskAllocation.hours}h`);
                }
            }

            // Calculate totals from ADO description tables (include ALL dates, not just 2-week window)
            let adoTotal = 0;
            const adoDetails = [];
            for (const [dateStr, hours] of Object.entries(dailyHours)) {
                adoTotal += hours;
                adoDetails.push(`${dateStr}: ${hours}h`);
            }

            const taskDiff = Math.abs(allocatedTotal - adoTotal);
            let taskStatus = "MATCH";
            if (taskDiff >= 0.1) {
                if (allocatedTotal > adoTotal) {
                    taskStatus = `DIFF: <span style="color: red; font-weight: bold;">+${(allocatedTotal - adoTotal).toFixed(1)}h</span>`;
                } else {
                    taskStatus = `DIFF: <span style="color: #cc7000; font-weight: bold;">-${(adoTotal - allocatedTotal).toFixed(1)}h</span>`;
                }
            }

            let taskProposedAction = '<em style="color: #707070;">No action needed</em>';
            if (taskDiff >= 0.1) {
                if (allocatedTotal > adoTotal) {
                    taskProposedAction = `Click "Distribute" button to update ADO task description with ${(allocatedTotal - adoTotal).toFixed(1)}h additional hours`;
                } else {
                    taskProposedAction = `Verify task allocations in sidebar - ADO shows ${(adoTotal - allocatedTotal).toFixed(1)}h more than allocated`;
                }
            }

            html += `
                <tr>
                    <td><a href="${timecardFunctions.orgUrl}/_workitems/edit/${taskId}" target="_blank">Task ${taskId}</a>: Allocated vs ADO Description</td>
                    <td>${taskStatus}</td>
                    <td><strong>${timecardFunctions.escapeHtml(taskDetails.title)}</strong><br>
                        Allocated: ${allocatedTotal.toFixed(1)}h (${allocationDetails.join(', ')})<br>
                        ADO Description: ${adoTotal.toFixed(1)}h (${adoDetails.join(', ')})</td>
                    <td>${taskProposedAction}</td>
                </tr>
            `;

            // 3. Get ADO Completed Work field for comparison
            try {
                const pat = await timecardFunctions.loadLocal("adoPAT");
                if (timecardFunctions.orgUrl && pat) {
                    const response = await fetch(
                        `${timecardFunctions.orgUrl}/_apis/wit/workitems?ids=${taskId}&fields=Microsoft.VSTS.Scheduling.CompletedWork&api-version=7.0`,
                        { headers: timecardFunctions.createAdoHeaders(pat) }
                    );

                    if (response.ok) {
                        const data = await response.json();
                        if (data.value?.length > 0) {
                            const completedWork = data.value[0].fields["Microsoft.VSTS.Scheduling.CompletedWork"] || 0;
                            const completedDiff = Math.abs(adoTotal - completedWork);
                            let completedStatus = "MATCH";
                            if (completedDiff >= 0.1) {
                                if (adoTotal > completedWork) {
                                    completedStatus = `DIFF: <span style="color: red; font-weight: bold;">+${(adoTotal - completedWork).toFixed(1)}h</span>`;
                                } else {
                                    completedStatus = `DIFF: <span style="color: #cc7000; font-weight: bold;">-${(completedWork - adoTotal).toFixed(1)}h</span>`;
                                }
                            }

                            let completedProposedAction = '<em style="color: #707070;">No action needed</em>';
                            if (completedDiff >= 0.1) {
                                if (adoTotal > completedWork) {
                                    completedProposedAction = `Click "Distribute" button to update Completed Work field with ${(adoTotal - completedWork).toFixed(1)}h additional hours`;
                                } else {
                                    completedProposedAction = `Manually verify ADO task - Completed Work field shows ${(completedWork - adoTotal).toFixed(1)}h more than description table`;
                                }
                            }

                            html += `
                                <tr>
                                    <td><a href="${timecardFunctions.orgUrl}/_workitems/edit/${taskId}" target="_blank">Task ${taskId}</a>: ADO Description vs Completed Work</td>
                                    <td>${completedStatus}</td>
                                    <td><strong>${timecardFunctions.escapeHtml(taskDetails.title)}</strong><br>
                                        Description Total: ${adoTotal.toFixed(1)}h<br>
                                        Completed Work: ${completedWork.toFixed(1)}h</td>
                                    <td>${completedProposedAction}</td>
                                </tr>
                            `;
                        }
                    }
                }
            } catch (error) {
                console.debug(LOG_PREFIX + `Could not fetch completed work for task ${taskId}:`, error);
            }

        } catch (error) {
            console.error(LOG_PREFIX + `Error auditing task ${taskId}:`, error);
        }
    }

    html += `
            </tbody>
        </table>
        <div style="margin-top: 1em; font-size: 0.9em; color: #666;">
            <p><strong>Audit Legend:</strong></p>
            <ul>
                <li><strong>MATCH</strong> = Values match (within 0.1 hour tolerance)</li>
                <li><strong>DIFF</strong> = Values differ (may indicate data sync issues)</li>
            <li><strong>Proposed Actions:</strong>
                <ul>
                    <li>Specific steps to resolve discrepancies and maintain data consistency</li>
                    <li>"Distribute" refers to clicking hour input fields to trigger ADO updates</li>
                </ul>
            </li>
            <li><strong>Data Sources:</strong>
                <ul>
                    <li><strong>ADO Hours:</strong> Daily hours extracted from ADO task comments (or description for legacy tasks)</li>
                    <li><strong>Allocated Hours:</strong> Hours allocated to tasks via this sidebar</li>
                    <li><strong>Completed Work:</strong> ADO task field updated by the extension</li>
                </ul>
            </li>
            </ul>
        </div>
    `;

    // Generate Hours Change Pivot Table for the selected week
    // Get the current period dates from the sidebar's week navigation
    const { periodStart, periodEnd } = timecardFunctions.getCurrentPeriodRange();

    // Build pivot table showing hours from sidebar allocations
    html += await generateHoursChangePivotTable(periodStart, periodEnd, referencedTaskIds, allocationsByDay);

    return html;
}

// Export functions that need to be accessible from the main file
window.compareAuditFunctions = {
    generateADOTaskReport
};