// Time grid UI component for Kronos-ADO integration
// Uses event delegation pattern - one listener per event type on the container

import { CONFIG } from '../config.js';
import * as utils from '../utils.js';
import * as storage from '../storage.js';
import { updateTaskHours, syncAllocationsWithAdo as syncWithAdo, recoverAllocationsFromAdo } from '../ado/hours-sync.js';

/**
 * Create a time grid controller with event delegation
 * @param {HTMLElement} container - The container element for the grid
 * @param {Object} deps - Dependencies
 * @returns {Object} - Grid controller with render, setPeriod methods
 */
export function createTimeGrid(container, dependencies) {
    const { adoApi, showInfoStatus, showErrorStatus, showSyncNotification, onAddTask } = dependencies;

    // Grid state
    let state = {
        periodOffset: 0,
        allocations: {},
        hoursByDay: {},
        tasks: {} // taskId -> {title, project, pbiTitle}
    };

    // Promise to coordinate hour input processing
    let hourInputProcessing = Promise.resolve();

    // Track original values for escape key revert
    const originalValues = new WeakMap();

    // Attach event listeners ONCE to the container
    container.addEventListener('click', handleClick);
    container.addEventListener('input', handleInput);
    container.addEventListener('change', handleChange);
    container.addEventListener('focus', handleFocus, true); // capture phase for focus
    container.addEventListener('blur', handleBlur, true);   // capture phase for blur
    container.addEventListener('keydown', handleKeydown);

    // ========== Helper Functions ==========

    /**
     * Get task rows for a specific date from the DOM
     * @param {string} date - Date string (YYYY-MM-DD)
     * @returns {Array<{input: HTMLElement, checkbox: HTMLElement}>} - Array of task row items
     */
    function getTaskRowsForDate(date) {
        const dateCell = container.querySelector(`.dateCell[data-date="${date}"]`);
        if (!dateCell) return [];

        const table = dateCell.closest('table');
        if (!table) return [];

        const rows = Array.from(table.querySelectorAll('tr'));
        let dateRowIndex = -1;
        rows.forEach((row, index) => {
            if (row.contains(dateCell)) dateRowIndex = index;
        });

        if (dateRowIndex === -1) return [];

        const items = [];
        for (let i = dateRowIndex; i < rows.length; i++) {
            const row = rows[i];
            const nextDateCell = row.querySelector('.dateCell');
            if (nextDateCell && nextDateCell !== dateCell) break;

            const hourInput = row.querySelector('.hour-input');
            const checkbox = row.querySelector('.task-checkbox');

            if (hourInput && checkbox) {
                items.push({ input: hourInput, checkbox });
            }
        }
        return items;
    }

    /**
     * Get checked task items, or all items if none are checked
     * @param {Array} taskRows - Array of task row items from getTaskRowsForDate
     * @returns {Array} - Checked items (or all items if none checked)
     */
    function getCheckedOrAllItems(taskRows) {
        const checked = taskRows.filter(item => item.checkbox.checked);
        if (checked.length === 0) {
            // If none checked, check all and return all
            taskRows.forEach(item => { item.checkbox.checked = true; });
            return taskRows;
        }
        return checked;
    }

    // ========== Event Handlers ==========

    function handleClick(event) {
        const target = event.target;

        if (target.matches('.add-task-btn') || target.closest('.add-task-btn')) {
            const btn = target.closest('.add-task-btn') || target;
            const date = btn.dataset.date;
            if (onAddTask) onAddTask(date);
        }

        if (target.matches('.copy-tasks-btn') || target.closest('.copy-tasks-btn')) {
            const btn = target.closest('.copy-tasks-btn') || target;
            const date = btn.dataset.date;
            copyTasksFromPrevious(date);
        }

        if (target.matches('.distribute-btn') || target.closest('.distribute-btn')) {
            const btn = target.closest('.distribute-btn') || target;
            const date = btn.dataset.date;
            distributeToChecked(date);
        }

        if (target.matches('.level-btn') || target.closest('.level-btn')) {
            const btn = target.closest('.level-btn') || target;
            const date = btn.dataset.date;
            levelCheckedItems(date);
        }

        if (target.matches('.del-btn') || target.closest('.del-btn')) {
            const btn = target.closest('.del-btn') || target;
            const dateString = btn.dataset.date;
            const taskId = btn.dataset.taskId;
            deleteAllocation(dateString, taskId);
        }

        if (target.matches('.fill-hours-btn') || target.closest('.fill-hours-btn')) {
            const btn = target.closest('.fill-hours-btn') || target;
            const dateString = btn.dataset.date;
            const index = parseInt(btn.dataset.index, 10);
            fillHoursForTask(dateString, index);
        }

        // Track checkbox selection order
        if (target.matches('.task-checkbox')) {
            if (target.checked) {
                target.dataset.checkOrder = Date.now();
            } else {
                delete target.dataset.checkOrder;
            }
        }
    }

    function handleInput(event) {
        if (!event.target.matches('.hour-input')) return;
        // Clear auto-insert flag when user types
        delete event.target.dataset.autoInserted;
        originalValues.delete(event.target);
    }

    async function handleFocus(event) {
        if (!event.target.matches('.hour-input')) return;

        // Wait for any ongoing processing
        await hourInputProcessing;

        // Only proceed if still focused
        if (document.activeElement !== event.target) return;

        const input = event.target;
        const dateString = input.dataset.date;

        // Show tip in day status area
        const statusElement = container.querySelector(`.day-status[data-date="${dateString}"]`);
        if (statusElement && !statusElement.textContent) {
            statusElement.textContent = "Tip: Task Hours supports math like 1+2 or 4-.5";
            statusElement.dataset.isTip = "true";
        }

        // Select all text
        if (document.activeElement === input) {
            input.setSelectionRange(0, input.value.length, "forward");
        }
    }

    function handleBlur(event) {
        if (!event.target.matches('.hour-input')) return;

        const input = event.target;
        const dateString = input.dataset.date;

        // Clear tip from day status area (if it's still showing the tip)
        const statusElement = container.querySelector(`.day-status[data-date="${dateString}"]`);
        if (statusElement && statusElement.dataset.isTip === "true") {
            statusElement.textContent = "";
            delete statusElement.dataset.isTip;
        }
        let resolveProcessing;
        hourInputProcessing = new Promise(resolve => {
            resolveProcessing = resolve;
        });
        input._processingResolver = resolveProcessing;

        // If empty, set to zero
        const wasEmpty = input.value.trim() === "";
        if (wasEmpty) {
            input.value = "0";
        }

        // Trigger change if auto-inserted or was empty
        if (input.dataset.autoInserted || wasEmpty) {
            delete input.dataset.autoInserted;
            input.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
            // Resolve immediately if no change needed
            setTimeout(() => {
                if (input._processingResolver === resolveProcessing) {
                    resolveProcessing();
                    input._processingResolver = null;
                }
            }, 0);
        }
    }

    async function handleChange(event) {
        if (!event.target.matches('.hour-input')) return;

        const input = event.target;
        const dateString = input.dataset.date;
        const taskId = input.dataset.taskId;
        const index = parseInt(input.dataset.index, 10);

        let resolveProcessing = input._processingResolver;
        if (!resolveProcessing) {
            hourInputProcessing = new Promise(resolve => {
                resolveProcessing = resolve;
            });
        }

        try {
            const newHours = parseHoursExpression(input.value);
            if (newHours === null) {
                const task = state.tasks[taskId];
                showErrorStatus("Invalid hours entry", null, {
                    date: dateString,
                    taskId: taskId,
                    taskTitle: task?.title
                });
                return;
            }

            input.value = newHours;

            // Update state
            if (!state.allocations[dateString]) state.allocations[dateString] = [];
            if (state.allocations[dateString][index]) {
                state.allocations[dateString][index].hours = newHours;
            }

            // Save to storage
            await storage.saveLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY, state.allocations);

            // Update UI inline (without full re-render)
            updateDaySummary(dateString);

            // Update ADO
            if (taskId) {
                await updateTaskInAdo(taskId, dateString, input);
            }

        } catch (error) {
            console.error("Error updating hours:", error);
            const task = state.tasks[taskId];
            showErrorStatus(error.message || "Failed to update hours", null, {
                date: dateString,
                taskId: taskId,
                taskTitle: task?.title
            });
        } finally {
            resolveProcessing();
            input._processingResolver = null;
        }
    }

    function handleKeydown(event) {
        if (!event.target.matches('.hour-input')) return;

        if (event.key === "Escape") {
            const input = event.target;
            const original = originalValues.get(input);
            if (original !== undefined) {
                event.preventDefault();
                input.value = original;
                originalValues.delete(input);
                delete input.dataset.autoInserted;
                input.setSelectionRange(0, input.value.length, "forward");
            }
        }
    }

    // ========== Helper Functions ==========


    function parseHoursExpression(expression) {
        expression = expression.trim();
        if (expression === "") return 0;

        const match = expression.match(/^((?:\d+\.\d+)|(?:\.\d+)|(?:\d+))(?:\s*([+-])\s*((?:\d+\.\d+)|(?:\.\d+)|(?:\d+)))?$/);
        if (!match) return null;

        let result = parseFloat(match[1]);
        if (match[2]) {
            const secondNumber = parseFloat(match[3]);
            result = match[2] === "+" ? result + secondNumber : result - secondNumber;
        }
        return Math.round(result * 10) / 10;
    }

    function fillHoursForTask(dateString, index) {
        const dailyAllocations = state.allocations[dateString] || [];
        const worked = parseFloat(state.hoursByDay[dateString]?.hours || "0");
        const allocated = utils.calculateTotalAllocatedHours(dailyAllocations);
        const difference = allocated - worked;

        // If no difference, do nothing (button should be disabled anyway)
        if (Math.abs(difference) < 0.01) return;

        // Find the input for this task
        const input = container.querySelector(`.hour-input[data-date="${dateString}"][data-index="${index}"]`);
        if (!input) return;

        const currentValue = parseFloat(input.value) || 0;
        let newValue;

        if (difference < 0) {
            // Under-allocated: add the remaining hours
            newValue = currentValue + Math.abs(difference);
        } else {
            // Over-allocated: subtract the excess (but don't go below 0)
            newValue = Math.max(0, currentValue - difference);
        }

        // Update the input and trigger change
        input.value = newValue.toFixed(1).replace(/\.0$/, "");
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function updateDaySummary(dateString) {
        const dailyAllocations = state.allocations[dateString] || [];
        const worked = parseFloat(state.hoursByDay[dateString]?.hours || "0");
        const allocated = utils.calculateTotalAllocatedHours(dailyAllocations);
        const difference = allocated - worked;
        const hasDifference = Math.abs(difference) >= 0.01;

        const allocatedElement = container.querySelector(`.allocatedDisplay[data-date="${dateString}"]`);
        const differenceElement = container.querySelector(`.allocDiffCell[data-date="${dateString}"]`);

        if (allocatedElement) {
            allocatedElement.textContent = allocated === 0 ? "" : allocated.toFixed(1);
        }

        if (differenceElement) {
            const { text, className } = utils.calculateAllocationDifference(allocated, worked);
            const hasAllocationDifference = text && text.trim() !== "";

            if (hasAllocationDifference) {
                differenceElement.innerHTML = `<button class="distribute-btn" data-date="${dateString}" title="Distribute difference to checked items" tabindex="-1" style="font-size:1.5em">&divide;</button><div style="margin:.3em 0">${text}</div><button class="level-btn" data-date="${dateString}" title="Level checked items to equal values" tabindex="-1" style="font-size:1.5em">=</button>`;
            } else {
                differenceElement.innerHTML = text;
            }
            differenceElement.className = `allocDiffCell ${className}`;
        }

        // Update fill-hours buttons disabled state for this day
        const fillButtons = container.querySelectorAll(`.fill-hours-btn[data-date="${dateString}"]`);
        fillButtons.forEach(btn => {
            btn.disabled = !hasDifference;
        });
    }

    async function copyTasksFromPrevious(date) {
        const current = state.allocations[date] || [];
        const existingIds = new Set(current.map(allocation => String(allocation.taskId)));

        // Search back up to 21 days to find a day with tasks
        let previousAllocations = [];
        let previousDateString = null;
        const searchDate = new Date(date + 'T00:00:00');

        for (let i = 0; i < 21; i++) {
            searchDate.setDate(searchDate.getDate() - 1);
            const dateString = utils.formatDateAsYYYYMMDD(searchDate);
            const allocations = state.allocations[dateString] || [];

            if (allocations.length > 0) {
                previousAllocations = allocations;
                previousDateString = dateString;
                break;
            }
        }

        if (previousAllocations.length === 0) {
            return;
        }

        // Find checked tasks from the found day (only if it's visible in the grid)
        const checkedTaskIds = new Set();
        const previousDateCell = container.querySelector(`.dateCell[data-date="${previousDateString}"]`);

        if (previousDateCell) {
            const table = previousDateCell.closest('table');
            if (table) {
                const rows = Array.from(table.querySelectorAll('tr'));
                let previousDateRowIndex = -1;
                rows.forEach((row, index) => {
                    if (row.contains(previousDateCell)) previousDateRowIndex = index;
                });

                if (previousDateRowIndex !== -1) {
                    let taskRowCount = 0;
                    for (let i = previousDateRowIndex; i < rows.length; i++) {
                        const row = rows[i];
                        const nextDateCell = row.querySelector('.dateCell');
                        if (nextDateCell && nextDateCell !== previousDateCell) break;

                        const checkbox = row.querySelector('.task-checkbox');
                        if (checkbox) {
                            if (checkbox.checked && taskRowCount < previousAllocations.length) {
                                checkedTaskIds.add(String(previousAllocations[taskRowCount].taskId));
                            }
                            taskRowCount++;
                        }
                    }
                }
            }
        }

        // Copy tasks (checked only if any checked, otherwise all)
        const tasksToCopy = checkedTaskIds.size > 0
            ? previousAllocations.filter(allocation => allocation.taskId && checkedTaskIds.has(String(allocation.taskId)))
            : previousAllocations;

        tasksToCopy.forEach(allocation => {
            if (allocation.taskId && !existingIds.has(String(allocation.taskId))) {
                current.push({ taskId: allocation.taskId, hours: "", confirmed: true, source: 'manual' });
                existingIds.add(String(allocation.taskId));
            }
        });

        state.allocations[date] = current;
        await storage.saveLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY, state.allocations);
        await render();
    }

    async function distributeToChecked(date) {
        const dayAllocations = state.allocations[date] || [];
        const worked = parseFloat(state.hoursByDay[date]?.hours || "0");
        const allocated = utils.calculateTotalAllocatedHours(dayAllocations);
        const diff = allocated - worked;

        if (Math.abs(diff) < 0.01) return;

        const taskRows = getTaskRowsForDate(date);
        if (taskRows.length === 0) return;

        const items = getCheckedOrAllItems(taskRows);
        if (items.length === 0) return;

        // Items are already in visual DOM order (top to bottom)
        // Remainder goes to earlier items (top), so bottom items have less

        // Distribute in 0.1 increments
        const totalToDistribute = -diff;
        const isUnderAllocated = totalToDistribute > 0;
        const totalIncrements = Math.round(Math.abs(totalToDistribute) * 10);
        const incrementsPerItem = Math.floor(totalIncrements / items.length);
        const remainingIncrements = totalIncrements % items.length;

        // Update each item
        items.forEach((item, index) => {
            const currentValue = parseFloat(item.input.value || "0");
            let increments = incrementsPerItem;
            if (index < remainingIncrements) increments += 1;

            const distributionAmount = increments * 0.1;
            const signedAmount = isUnderAllocated ? distributionAmount : -distributionAmount;
            const newValue = Math.round((currentValue + signedAmount) * 10) / 10;

            item.input.value = Math.max(0, newValue);
            item.input.dispatchEvent(new Event("change", { bubbles: true }));

            // Uncheck
            item.checkbox.checked = false;
            delete item.checkbox.dataset.checkOrder;
        });
    }

    async function levelCheckedItems(date) {
        const dayAllocations = state.allocations[date] || [];
        const worked = parseFloat(state.hoursByDay[date]?.hours || "0");
        const allocated = utils.calculateTotalAllocatedHours(dayAllocations);
        const diff = allocated - worked;

        if (Math.abs(diff) < 0.01) return;

        const taskRows = getTaskRowsForDate(date);
        if (taskRows.length === 0) return;

        const items = getCheckedOrAllItems(taskRows);
        if (items.length === 0) return;

        // Items are already in visual DOM order (top to bottom)
        // Remainder goes to earlier items (top), so bottom items have less

        // Calculate the target total: sum of checked items + remaining hours needed
        const checkedSum = items.reduce((sum, item) => sum + (parseFloat(item.input.value) || 0), 0);
        const targetTotal = checkedSum - diff; // -diff because diff = allocated - worked, so we need to add -diff to balance

        // Calculate target value per item (to nearest tenth)
        const targetPerItem = Math.round((targetTotal / items.length) * 10) / 10;
        const totalFromEvenDistribution = targetPerItem * items.length;
        const remainderInTenths = Math.round((targetTotal - totalFromEvenDistribution) * 10);

        // Distribute: each item gets targetPerItem, with remainder (in 0.1 increments) going to earlier items
        items.forEach((item, index) => {
            let value = targetPerItem;
            if (index < Math.abs(remainderInTenths)) {
                value += (remainderInTenths > 0 ? 0.1 : -0.1);
            }
            value = Math.round(value * 10) / 10; // Ensure clean decimal
            item.input.value = Math.max(0, value);
            item.input.dispatchEvent(new Event("change", { bubbles: true }));

            // Uncheck
            item.checkbox.checked = false;
            delete item.checkbox.dataset.checkOrder;
        });
    }

    async function deleteAllocation(dateString, taskId) {
        state.allocations[dateString] = (state.allocations[dateString] || [])
            .filter(allocation => String(allocation.taskId) !== String(taskId));

        await storage.saveLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY, state.allocations);

        // Update ADO to remove hours for this task
        if (taskId) {
            await updateTaskInAdo(taskId, dateString, null);
        }

        await render();
    }

    async function updateTaskInAdo(taskId, dateForStatus, triggeringInput) {
        let task = state.tasks[taskId];
        if (!task) {
            task = await adoApi.loadTaskDetails(taskId);
            if (task) state.tasks[taskId] = task;
        }

        const focusedElement = document.activeElement;
        if (triggeringInput) triggeringInput.disabled = true;
        setDayStatus(dateForStatus, "Updating task...");

        try {
            const result = await updateTaskHours({
                adoApi,
                taskId,
                task,
                allocations: state.allocations,
                periodOffset: state.periodOffset
            });

            if (!result.success) {
                throw new Error(result.error || "Failed to update task");
            }

            setDayStatus(dateForStatus, "");
            showInfoStatus(`Task updated ${new Date().toLocaleTimeString()}`, {
                date: dateForStatus,
                taskId: taskId,
                taskTitle: task?.title
            });

        } catch (err) {
            console.error("Failed to update ADO task:", err);
            setDayStatus(dateForStatus, "");
            showErrorStatus("Failed to update ADO task", () => updateTaskInAdo(taskId, dateForStatus, triggeringInput), {
                date: dateForStatus,
                taskId: taskId,
                taskTitle: task?.title
            });
        } finally {
            if (triggeringInput) triggeringInput.disabled = false;
            if (focusedElement?.classList?.contains('hour-input')) {
                focusedElement.focus();
            }
        }
    }

    function setDayStatus(date, message) {
        const element = container.querySelector(`.day-status[data-date="${date}"]`);
        if (element) element.textContent = message;
    }

    // ========== Sync with ADO ==========

    async function syncAllocationsWithAdo() {
        try {
            const result = await syncWithAdo({
                adoApi,
                allocations: state.allocations,
                periodOffset: state.periodOffset,
                tasksCache: state.tasks
            });

            if (result.success) {
                state.allocations = result.allocations;
                await storage.saveLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY, state.allocations);
                showSyncNotification("Synced with ADO", "success");
            } else {
                showSyncNotification("Sync failed", "error");
            }

        } catch (error) {
            console.error("Error syncing with ADO:", error);
            showSyncNotification("Sync failed", "error");
        }
    }

    // ========== Render ==========

    async function render() {
        // Load data from storage
        state.hoursByDay = (await storage.loadLocal(CONFIG.STORAGE_KEYS.HOURS_BY_DAY)) || {};
        state.allocations = (await storage.loadLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY)) || {};

        // Recovery check: If allocations are completely empty, try to recover from ADO comments.
        // This handles the case when local storage is cleared or on first load with a new PAT.
        const hasAnyAllocations = Object.values(state.allocations).some(day => day && day.length > 0);
        if (!hasAnyAllocations && adoApi) {
            const recovery = await recoverAllocationsFromAdo({ adoApi, daysBack: 14 });
            if (recovery.tasksFound > 0) {
                state.allocations = recovery.allocations;
                await storage.saveLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY, state.allocations);
                showSyncNotification(`Recovered ${recovery.tasksFound} task(s) from ADO`, 'success');
            }
        }

        // Ensure task metadata is loaded
        if (adoApi) {
            adoApi.taskDetailsCache = {};
            await adoApi.loadTasks(false, showErrorStatus);
        }

        // Sync with ADO
        await syncAllocationsWithAdo();

        // Re-fetch allocations after sync
        state.allocations = (await storage.loadLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY)) || {};

        const { periodStart, periodEnd } = utils.getCurrentPeriodRange(CONFIG.PAYROLL_FIRST_DAY, state.periodOffset);

        // Build tasks cache from cached tasks
        if (adoApi?.cachedTasks) {
            adoApi.cachedTasks.forEach(task => {
                state.tasks[task.id] = task;
            });
        }

        // Build HTML
        container.innerHTML = buildGridHTML(state, periodStart);

        // Update period display
        const displaySpan = document.getElementById("period-display");
        if (displaySpan) {
            const startFmt = (date) => `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${date.getFullYear()}`;
            const endFmt = (date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
            displaySpan.innerHTML = `${startFmt(periodStart)}&nbsp;&ndash;&nbsp;${endFmt(periodEnd)}`;
        }
    }

    function buildGridHTML(state, periodStart) {
        let html = `
            <table>
            <thead>
            <tr>
                <th>Date</th>
                <th>Hours In Kronos</th>
                <th>Hours Allocated</th>
                <th><span class="alloc-diff-under">Under</span> / <span class="alloc-diff-over">Over</span><br/>Allocated</th>
                <th></th>
                <th></th>
                <th title="Supports simple math: 2+0.5 or 8-1">Task Hours</th>
                <th class="taskCol">Project</th>
                <th class="taskCol">PBI</th>
                <th class="taskCol">Task</th>
                <th></th>
            </tr>
            </thead>
            <tbody>`;

        for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
            const currentDate = new Date(periodStart);
            currentDate.setDate(periodStart.getDate() + dayIndex);
            const dateString = utils.formatDateAsYYYYMMDD(currentDate);
            const displayDate = `${currentDate.toLocaleDateString(undefined, { weekday: 'short' })} ${currentDate.getMonth() + 1}/${currentDate.getDate()}`;

            const worked = parseFloat(state.hoursByDay[dateString]?.hours || "0");
            const dailyAllocations = state.allocations[dateString] || [];
            const allocated = utils.calculateTotalAllocatedHours(dailyAllocations);
            const { text: allocationDifferenceText, className: allocationDifferenceClass } = utils.calculateAllocationDifference(allocated, worked);
            const hasDifference = Math.abs(allocated - worked) >= 0.01;
            const fillBtnDisabled = hasDifference ? '' : 'disabled';

            const dayClass = dayIndex % 2 === 0 ? "day-group-even" : "day-group-odd";
            const totalRows = Math.max(dailyAllocations.length, 1) + 1;

            // If no allocations, show empty row with header
            if (dailyAllocations.length === 0) {
                html += `<tr class="${dayClass}">
                    ${buildDayHeaderCells(totalRows, dateString, displayDate, worked, allocated, allocationDifferenceText, allocationDifferenceClass)}
                </tr>`;
            }

            // Allocation rows
            dailyAllocations.forEach((allocation, index) => {
                const task = state.tasks[allocation.taskId] || {};
                const taskUrl = adoApi ? `${adoApi.orgUrl}/_workitems/edit/${allocation.taskId}` : '#';

                html += `<tr class="${dayClass}">`;

                if (index === 0) {
                    html += buildDayHeaderCells(totalRows, dateString, displayDate, worked, allocated, allocationDifferenceText, allocationDifferenceClass);
                }

                html += `
                    <td>
                        <input type="checkbox" class="task-checkbox" data-date="${dateString}" data-index="${index}" tabindex="-1">
                    </td>
                    <td>
                        <button class="fill-hours-btn" data-date="${dateString}" data-task-id="${allocation.taskId}" data-index="${index}" tabindex="-1" title="Add remaining hours to this task" ${fillBtnDisabled}>⮞</button>
                    </td>
                    <td>
                        <input type="text" class="hour-input"
                               data-date="${dateString}"
                               data-task-id="${allocation.taskId}"
                               data-index="${index}"
                               value="${allocation.hours || ''}">
                    </td>
                    <td class="taskCol">${utils.escapeHtml(task.project || '')}</td>
                    <td class="taskCol">${utils.escapeHtml(task.pbiTitle || '')}</td>
                    <td class="taskCol">
                        <a href="${taskUrl}" target="_blank">${utils.escapeHtml(task.title || `Task #${allocation.taskId}`)}</a>
                    </td>
                    <td>
                        <button class="del-btn" data-date="${dateString}" data-task-id="${allocation.taskId}" tabindex="-1">X</button>
                    </td>
                </tr>`;
            });

            // Add task row
            html += `<tr class="${dayClass}">
                <td></td>
                <td colspan="6" class="task-btn-cell">
                    <button class="copy-tasks-btn" data-date="${dateString}" tabindex="-1" title="Copy checked tasks from the most recent day with tasks (up to 21 days back). If none are checked, copy all tasks.">Copy Tasks from Previous</button>
                    <button class="add-task-btn" data-date="${dateString}" tabindex="-1">Add Task to Day</button>
                    <span class="day-status" data-date="${dateString}"></span>
                </td>
                <td></td>
            </tr>`;
        }

        html += '</tbody></table>';
        return html;
    }

    function buildDayHeaderCells(totalRows, dateString, displayDate, worked, allocated, allocationDifferenceText, allocationDifferenceClass) {
        const allocatedHoursText = allocated === 0 ? "" : allocated.toFixed(1);
        const workedHoursText = worked === 0 ? "" : worked;
        const differenceDisplay = allocationDifferenceText || "";
        const hasAllocationDifference = differenceDisplay && differenceDisplay.trim() !== "";

        return `
            <td rowspan="${totalRows}" class="dateCell" data-date="${dateString}">${displayDate}</td>
            <td rowspan="${totalRows}" class="workedCell">${workedHoursText}</td>
            <td rowspan="${totalRows}" class="allocatedCell">
                <span class="allocatedDisplay" data-date="${dateString}">${allocatedHoursText}</span>
            </td>
            <td rowspan="${totalRows}" class="allocDiffCell ${allocationDifferenceClass}" data-date="${dateString}">
                ${hasAllocationDifference ? '<button class="distribute-btn" data-date="' + dateString + '" title="Distribute difference to checked items" tabindex="-1" style="font-size:1.5em">&divide;</button><div style="margin:.3em 0">' + differenceDisplay + '</div><button class="level-btn" data-date="' + dateString + '" title="Level checked items to equal values" tabindex="-1" style="font-size:1.5em">=</button>' : differenceDisplay}
            </td>`;
    }

    // ========== Public API ==========

    function setPeriod(delta) {
        state.periodOffset += delta;
        render();
    }

    function getPeriodOffset() {
        return state.periodOffset;
    }

    async function addTask(date, taskId) {
        if (!state.allocations[date]) state.allocations[date] = [];
        state.allocations[date].push({ taskId, hours: "", confirmed: true, source: 'manual' });
        await storage.saveLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY, state.allocations);
        await render();
    }

    return {
        render,
        setPeriod,
        getPeriodOffset,
        addTask,
        getState: () => state
    };
}
