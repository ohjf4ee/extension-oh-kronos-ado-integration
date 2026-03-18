// Kronos-ADO Integration - Main Sidebar Entry Point
// This file is a thin orchestrator that wires together the UI components

import { CONFIG } from './config.js';
import * as utils from './utils.js';
import * as storage from './storage.js';
import { createAdoHeaders } from './ado/api-client.js';
import { extractDailyHoursFromTask } from './ado/hours-sync.js';
import { showInfoStatus, showErrorStatus, showSyncNotification, createModalHelpers } from './ui/modals.js';
import { createConfigPanel } from './ui/config-panel.js';
import { createTimeGrid } from './ui/time-grid.js';
import { createTaskTreeSelector } from './ui/task-tree.js';

const LOG_PREFIX = "\x1B[1mEXTENSION Kronos-ADO-integration[timecard-sidebar.js]:\x1B[m ";
console.debug(LOG_PREFIX + "Loading...");

document.addEventListener("DOMContentLoaded", async () => {
    console.debug(LOG_PREFIX + "START DOMContentLoaded()");

    // DOM elements
    const timeGridContainer = document.getElementById("time-grid");
    const addTaskModal = document.getElementById("add-task-modal");
    const addTaskSelected = document.getElementById("add-task-selected");
    const addTaskStep = document.getElementById("add-task-step");

    // State
    let orgUrl = "";
    let adoApi = null;
    let modalHelpers = null;
    let showTaskSelectionModal = null;
    let timeGrid = null;

    // Initialize config panel
    const configPanel = createConfigPanel({
        orgUrlInput: document.getElementById("org-url-input"),
        patInput: document.getElementById("pat-input"),
        saveConfigBtn: document.getElementById("save-config-btn"),
        openPatLink: document.getElementById("open-pat-page-link"),
        patLabel: document.getElementById("pat-label"),
        statusMsg: document.getElementById("status-msg"),
        orgNameSpan: document.getElementById("org-name"),
        configSection: document.getElementById("config-section"),
        consentCheckbox: document.getElementById("consent-checkbox"),
        consentLabel: document.getElementById("consent-label"),
        clearDataBtn: document.getElementById("clear-data-btn"),
        sessionKeepAliveCheckbox: document.getElementById("session-keep-alive-checkbox")
    }, {
        onConfigured: (newOrgUrl, newAdoApi) => {
            orgUrl = newOrgUrl;
            adoApi = newAdoApi;
            initializeComponents();
            if (timeGrid) timeGrid.render();
        },
        showToast: (message, type) => {
            // Use Toastify for toast messages
            if (typeof Toastify !== 'undefined') {
                Toastify({
                    text: message,
                    duration: 3000,
                    gravity: "top",
                    position: "right",
                    backgroundColor: type === 'error' ? '#dc3545' : '#28a745'
                }).showToast();
            }
        }
    });

    // Load initial config
    const config = await configPanel.init();
    if (config) {
        orgUrl = config.orgUrl;
        adoApi = config.adoApi;
    }

    // Initialize components after config is loaded
    initializeComponents();

    function initializeComponents() {
        if (!adoApi) return;

        // Create modal helpers
        modalHelpers = createModalHelpers(
            { addTaskStep, addTaskSelected, addTaskModal },
            { adoApi, utils }
        );

        // Create task tree selector
        showTaskSelectionModal = createTaskTreeSelector({
            orgUrl,
            storage,
            CONFIG,
            adoApi,
            showErrorStatus,
            createAdoHeaders,
            modalHelpers,
            LOG_PREFIX,
            modalElements: { addTaskModal, addTaskSelected, addTaskStep }
        });

        // Create time grid (only once)
        if (!timeGrid) {
            timeGrid = createTimeGrid(timeGridContainer, {
                adoApi,
                showInfoStatus,
                showErrorStatus,
                showSyncNotification,
                onAddTask: handleAddTaskButtonClick
            });
        }
    }

    async function handleAddTaskButtonClick(date) {
        if (!showTaskSelectionModal) return;

        const selectedTaskId = await showTaskSelectionModal(date);
        if (selectedTaskId && timeGrid) {
            await timeGrid.addTask(date, selectedTaskId);
        }
    }

    // Period navigation
    document.getElementById("prev-period-btn").addEventListener("click", () => {
        if (timeGrid) timeGrid.setPeriod(-1);
    });

    document.getElementById("next-period-btn").addEventListener("click", () => {
        if (timeGrid) timeGrid.setPeriod(+1);
    });

    // Refresh button
    const refreshBtn = document.getElementById("refresh-grid-btn");
    if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
            if (timeGrid) timeGrid.render();
        });
    }

    // Copy grid button
    const copyGridBtn = document.getElementById("copy-grid-btn");
    if (copyGridBtn) {
        copyGridBtn.addEventListener("click", () => {
            if (window.copyGridFunctions?.copyTimeGridToClipboard) {
                window.copyGridFunctions.copyTimeGridToClipboard();
            } else {
                console.error(LOG_PREFIX + "Copy Grid functions not loaded");
            }
        });
    }

    // Copy pivot button
    const copyPivotBtn = document.getElementById("copy-pivot-btn");
    if (copyPivotBtn) {
        copyPivotBtn.addEventListener("click", () => {
            if (window.copyGridFunctions?.copyPivotToClipboard) {
                window.copyGridFunctions.copyPivotToClipboard();
            } else {
                console.error(LOG_PREFIX + "Copy Pivot functions not loaded");
            }
        });
    }

    // Listen for timecard data updates from content script
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === "timecardDataUpdated" && timeGrid) {
            timeGrid.render();
        }
    });

    // Initial render
    if (timeGrid) {
        await timeGrid.render();
    }

    // Export functions for use by other modules (copy-grid.js)
    window.timecardFunctions = {
        loadTasksFromADO: (forceRefresh) => adoApi?.loadTasks(forceRefresh, showErrorStatus),
        loadLocal: storage.loadLocal,
        loadTaskDetails: (taskId, includeExtraFields) => adoApi?.loadTaskDetails(taskId, includeExtraFields),
        extractDailyHoursFromTaskComment: async (taskId, project, description) => {
            return extractDailyHoursFromTask({ adoApi, taskId, project, description });
        },
        getCurrentPeriodRange: () => {
            const offset = timeGrid?.getPeriodOffset() || 0;
            return utils.getCurrentPeriodRange(CONFIG.PAYROLL_FIRST_DAY, offset);
        },
        createAdoHeaders,
        escapeHtml: utils.escapeHtml,
        get orgUrl() { return orgUrl; },
        get cachedTasks() { return adoApi?.cachedTasks; }
    };
});
