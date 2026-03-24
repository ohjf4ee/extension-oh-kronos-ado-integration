// Config panel UI component for Kronos-ADO integration
// Handles ADO organization URL and PAT configuration

import { CONFIG } from '../config.js';
import * as storage from '../storage.js';
import { AdoApiClient, createAdoHeaders, adoUtils } from '../ado/index.js';

// Privacy policy URL (update this when hosting location is finalized)
const PRIVACY_POLICY_URL = 'https://github.com/ohjf4ee/extension-oh-kronos-ado-integration/blob/main/PRIVACY.md';

// Idle refresh configuration
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const COUNTDOWN_SECONDS = 10;
const SNOOZE_MS = 60 * 1000; // 1 minute

// Module-level state for idle refresh
let idleWorker = null;
let countdownIntervalId = null; // For UI updates only (best-effort)
let idleRefreshEnabled = false;
let refreshPopupElement = null;
let popupShowing = false;

/**
 * Create an inline Web Worker for reliable timing even when tab is inactive.
 * Web Workers are not throttled by browser background tab restrictions.
 *
 * The worker handles ALL timing logic:
 * - Tracks last activity time
 * - Detects when idle timeout is exceeded
 * - Counts down to refresh
 * - Triggers refresh when countdown expires
 *
 * This ensures refresh happens even if the main thread is throttled.
 */
function createIdleWorker() {
    const workerCode = `
        const IDLE_TIMEOUT_MS = ${IDLE_TIMEOUT_MS};
        const COUNTDOWN_MS = ${COUNTDOWN_SECONDS * 1000};
        const IDLE_TICK_MS = 30000; // Check every 30 sec during idle phase
        const COUNTDOWN_TICK_MS = 1000; // Check every 1 sec during countdown

        let intervalId = null;
        let lastActivityTime = 0;
        let snoozeUntil = 0;
        let countdownStartTime = 0; // 0 = not in countdown, >0 = countdown started at this time

        function setTickRate(ms) {
            if (intervalId) clearInterval(intervalId);
            intervalId = setInterval(tick, ms);
        }

        self.onmessage = function(e) {
            if (e.data === 'start') {
                lastActivityTime = Date.now();
                snoozeUntil = 0;
                countdownStartTime = 0;
                setTickRate(IDLE_TICK_MS);
            } else if (e.data === 'stop') {
                if (intervalId) clearInterval(intervalId);
                intervalId = null;
                countdownStartTime = 0;
            } else if (e.data === 'activity') {
                // User activity detected - reset everything
                lastActivityTime = Date.now();
                snoozeUntil = 0;
                if (countdownStartTime > 0) {
                    countdownStartTime = 0;
                    setTickRate(IDLE_TICK_MS);
                    self.postMessage({ type: 'countdownCancelled' });
                }
            } else if (e.data === 'snooze') {
                // Snooze for 1 minute
                snoozeUntil = Date.now() + ${SNOOZE_MS};
                countdownStartTime = 0;
                setTickRate(IDLE_TICK_MS);
                self.postMessage({ type: 'countdownCancelled' });
            } else if (e.data === 'cancel') {
                // Cancel countdown, reset to full idle timeout
                lastActivityTime = Date.now();
                snoozeUntil = 0;
                countdownStartTime = 0;
                setTickRate(IDLE_TICK_MS);
                self.postMessage({ type: 'countdownCancelled' });
            } else if (e.data === 'refreshNow') {
                // Immediate refresh requested
                self.postMessage({ type: 'refresh' });
            }
        };

        function tick() {
            const now = Date.now();

            // If in countdown phase
            if (countdownStartTime > 0) {
                const elapsed = now - countdownStartTime;
                const remaining = Math.ceil((COUNTDOWN_MS - elapsed) / 1000);

                if (remaining <= 0) {
                    // Countdown finished - trigger refresh
                    countdownStartTime = 0;
                    self.postMessage({ type: 'refresh' });
                } else {
                    // Send countdown update for UI
                    self.postMessage({ type: 'countdown', seconds: remaining });
                }
                return;
            }

            // Check if snooze is active
            if (snoozeUntil > 0) {
                if (now >= snoozeUntil) {
                    // Snooze expired - start countdown
                    snoozeUntil = 0;
                    countdownStartTime = now;
                    setTickRate(COUNTDOWN_TICK_MS);
                    self.postMessage({ type: 'countdownStart', seconds: ${COUNTDOWN_SECONDS} });
                }
                return;
            }

            // Check idle timeout
            const idleTime = now - lastActivityTime;
            if (idleTime >= IDLE_TIMEOUT_MS) {
                // Idle timeout exceeded - start countdown
                countdownStartTime = now;
                setTickRate(COUNTDOWN_TICK_MS);
                self.postMessage({ type: 'countdownStart', seconds: ${COUNTDOWN_SECONDS} });
            }
        }
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
}

/**
 * Create a config panel controller
 * @param {Object} elements - DOM elements for the config panel
 * @param {Object} dependencies - Dependencies
 * @returns {Object} - Config panel controller
 */
export function createConfigPanel(elements, dependencies) {
    const {
        orgUrlInput,
        patInput,
        saveConfigBtn,
        openPatLink,
        patLabel,
        statusMsg,
        orgNameSpan,
        configSection,
        consentCheckbox,
        consentLabel,
        clearDataBtn,
        sessionKeepAliveCheckbox
    } = elements;

    const { onConfigured, showToast } = dependencies;

    // Initial state
    openPatLink.style.pointerEvents = "none";
    openPatLink.style.opacity = "0.5";
    patInput.disabled = true;
    if (saveConfigBtn) saveConfigBtn.disabled = true;

    // Setup consent checkbox if present
    if (consentCheckbox && consentLabel) {
        consentLabel.innerHTML = `I agree to store my credentials locally. <a href="${PRIVACY_POLICY_URL}" target="_blank" rel="noopener">Privacy Policy</a>`;
        consentCheckbox.addEventListener('change', updateSaveButtonState);
    }

    // Setup clear data button if present
    if (clearDataBtn) {
        clearDataBtn.addEventListener('click', handleClearData);
    }

    // Setup idle refresh toggle if present
    if (sessionKeepAliveCheckbox) {
        sessionKeepAliveCheckbox.addEventListener('change', handleIdleRefreshToggle);
        initIdleRefreshState();
    }

    function updateSaveButtonState() {
        const orgUrl = adoUtils.extractOrgUrl(orgUrlInput.value.trim());
        const pat = patInput.value.trim();
        const hasConsent = consentCheckbox ? consentCheckbox.checked : true;
        saveConfigBtn.disabled = !orgUrl || !pat || !hasConsent;
    }

    async function handleClearData() {
        const confirmed = confirm(
            'This will delete all saved credentials and timecard data.\n\n' +
            'You will need to reconfigure your ADO connection.\n\n' +
            'Continue?'
        );
        if (!confirmed) return;

        try {
            await storage.clearAllData();
            // Reset UI
            orgUrlInput.value = '';
            patInput.value = '';
            orgNameSpan.textContent = '';
            statusMsg.textContent = 'All data cleared.';
            configSection.open = true;
            if (consentCheckbox) consentCheckbox.checked = false;
            if (sessionKeepAliveCheckbox) {
                sessionKeepAliveCheckbox.checked = false;
                stopIdleRefresh();
            }
            updateSaveButtonState();
            if (showToast) showToast('All data cleared successfully', 'success');
        } catch (error) {
            console.error('Failed to clear data:', error);
            if (showToast) showToast('Failed to clear data: ' + error.message, 'error');
        }
    }

    // =========================================================================
    // Idle Refresh Feature
    // =========================================================================

    /**
     * Initialize idle refresh state from storage
     */
    async function initIdleRefreshState() {
        const stored = await storage.loadLocal(CONFIG.STORAGE_KEYS.SESSION_KEEP_ALIVE);
        if (sessionKeepAliveCheckbox) {
            sessionKeepAliveCheckbox.checked = !!stored;
        }
        if (stored) {
            startIdleRefresh();
        }
    }

    /**
     * Handle idle refresh toggle change
     */
    async function handleIdleRefreshToggle() {
        const enabled = sessionKeepAliveCheckbox.checked;
        await storage.saveLocal(CONFIG.STORAGE_KEYS.SESSION_KEEP_ALIVE, enabled);

        if (enabled) {
            startIdleRefresh();
            if (showToast) showToast('Session refresh enabled', 'success');
        } else {
            stopIdleRefresh();
            if (showToast) showToast('Session refresh disabled', 'success');
        }
    }

    /**
     * Start idle refresh monitoring using Web Worker for reliable background timing.
     * The worker handles ALL timing logic to ensure refresh happens even when
     * the main thread is throttled by background tab restrictions.
     */
    function startIdleRefresh() {
        if (idleRefreshEnabled) return;
        idleRefreshEnabled = true;
        popupShowing = false;

        // Listen for mouse movement to notify worker of activity
        document.addEventListener('mousemove', notifyActivity);
        document.addEventListener('keydown', notifyActivity);

        // Create and start the Web Worker
        idleWorker = createIdleWorker();
        idleWorker.onmessage = handleWorkerMessage;
        idleWorker.postMessage('start');

        console.debug('[config-panel] Idle refresh started (10 min timeout, Web Worker controls timing)');
    }

    /**
     * Stop idle refresh monitoring
     */
    function stopIdleRefresh() {
        idleRefreshEnabled = false;
        document.removeEventListener('mousemove', notifyActivity);
        document.removeEventListener('keydown', notifyActivity);

        if (idleWorker) {
            idleWorker.postMessage('stop');
            idleWorker.terminate();
            idleWorker = null;
        }

        clearInterval(countdownIntervalId);
        hideRefreshPopup();
        popupShowing = false;
        console.debug('[config-panel] Idle refresh stopped');
    }

    /**
     * Handle messages from the Web Worker.
     * The worker sends: countdownStart, countdown, countdownCancelled, refresh
     */
    function handleWorkerMessage(e) {
        if (!idleRefreshEnabled) return;

        const msg = e.data;

        if (msg.type === 'countdownStart') {
            // Worker detected idle timeout - show popup
            showRefreshPopup(msg.seconds);
        } else if (msg.type === 'countdown') {
            // Worker sent countdown update - update UI (best effort)
            updatePopupContent(msg.seconds);
        } else if (msg.type === 'countdownCancelled') {
            // Worker cancelled countdown (due to activity, snooze, or cancel)
            hideRefreshPopup();
            popupShowing = false;
            clearInterval(countdownIntervalId);
        } else if (msg.type === 'refresh') {
            // Worker says it's time to refresh - do it immediately
            doRefresh();
        }
    }

    /**
     * Notify the worker of user activity (mouse movement, keypress)
     */
    function notifyActivity() {
        if (!idleRefreshEnabled || !idleWorker) return;
        idleWorker.postMessage('activity');
    }

    /**
     * Show the refresh countdown popup.
     * The popup is purely for UI - the worker controls the actual timing.
     */
    function showRefreshPopup(seconds) {
        if (!idleRefreshEnabled) return;
        popupShowing = true;

        // Create popup if it doesn't exist
        if (!refreshPopupElement) {
            refreshPopupElement = document.createElement('div');
            refreshPopupElement.id = 'idle-refresh-popup';
            refreshPopupElement.style.cssText = `
                position: fixed;
                top: 10px;
                left: 10px;
                right: 10px;
                background: #fff3cd;
                border: 3px solid #ffc107;
                border-radius: 8px;
                padding: 16px 20px;
                z-index: 9999;
                box-shadow: 0 4px 16px rgba(0,0,0,0.25);
                font-family: sans-serif;
            `;
            document.body.prepend(refreshPopupElement);
        }

        updatePopupContent(seconds);
        refreshPopupElement.style.display = 'block';

        // Also start a local interval for smoother UI updates when tab is visible.
        // This is best-effort only - the worker will trigger refresh regardless.
        clearInterval(countdownIntervalId);
        let localSeconds = seconds;
        countdownIntervalId = setInterval(() => {
            localSeconds--;
            if (localSeconds > 0) {
                updatePopupContent(localSeconds);
            }
            // Don't trigger refresh here - let the worker do it
        }, 1000);
    }

    /**
     * Update the popup content with current countdown
     */
    function updatePopupContent(seconds) {
        if (!refreshPopupElement) return;

        refreshPopupElement.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
                <span style="font-weight: bold; color: #856404;">
                    Refreshing page to renew session in ${seconds}...
                </span>
                <div style="display: flex; gap: 8px;">
                    <button id="idle-refresh-cancel" style="padding: 4px 12px; cursor: pointer;">Cancel</button>
                    <button id="idle-refresh-snooze" style="padding: 4px 12px; cursor: pointer;">Snooze 1 min</button>
                    <button id="idle-refresh-now" style="padding: 4px 12px; cursor: pointer; background: #ffc107; border: 1px solid #e0a800;">Refresh Now</button>
                </div>
            </div>
        `;

        // Attach button handlers - these tell the worker what to do
        document.getElementById('idle-refresh-cancel')?.addEventListener('click', handleCancel);
        document.getElementById('idle-refresh-snooze')?.addEventListener('click', handleSnooze);
        document.getElementById('idle-refresh-now')?.addEventListener('click', handleRefreshNow);
    }

    /**
     * Hide the refresh popup
     */
    function hideRefreshPopup() {
        if (refreshPopupElement) {
            refreshPopupElement.style.display = 'none';
        }
    }

    /**
     * Handle cancel button - tell worker to reset to full 10 minutes
     */
    function handleCancel() {
        clearInterval(countdownIntervalId);
        hideRefreshPopup();
        popupShowing = false;
        if (idleWorker) {
            idleWorker.postMessage('cancel');
        }
    }

    /**
     * Handle snooze button - tell worker to snooze for 1 minute
     */
    function handleSnooze() {
        clearInterval(countdownIntervalId);
        hideRefreshPopup();
        popupShowing = false;
        if (idleWorker) {
            idleWorker.postMessage('snooze');
        }
    }

    /**
     * Handle refresh now button - tell worker to refresh immediately
     */
    function handleRefreshNow() {
        if (idleWorker) {
            idleWorker.postMessage('refreshNow');
        }
    }

    /**
     * Perform the page refresh
     */
    function doRefresh() {
        clearInterval(countdownIntervalId);
        // Refresh the top-level Kronos page
        window.top.location.reload();
    }

    // Event listeners
    orgUrlInput.addEventListener("focus", () => setInputVisibility(true));

    orgUrlInput.addEventListener("input", () => {
        const orgUrl = adoUtils.extractOrgUrl(orgUrlInput.value.trim());
        const isValid = !!orgUrl;
        openPatLink.style.pointerEvents = isValid ? "auto" : "none";
        openPatLink.style.opacity = isValid ? "1" : "0.5";
        patInput.disabled = !isValid;
        updateSaveButtonState();
    });

    patInput.addEventListener("input", updateSaveButtonState);

    openPatLink.addEventListener("click", (e) => {
        e.preventDefault();
        const orgUrl = adoUtils.extractOrgUrl(orgUrlInput.value.trim());
        if (!orgUrl) return;
        const patPage = `${orgUrl}/_usersSettings/tokens`;
        chrome.tabs.create({ url: patPage });
    });

    saveConfigBtn.addEventListener("click", async () => {
        const raw = orgUrlInput.value.trim();
        const pat = patInput.value.trim();

        // Check consent
        if (consentCheckbox && !consentCheckbox.checked) {
            alert("Please agree to the privacy policy to continue.");
            return;
        }

        // Save raw URL for display
        await storage.saveLocal(CONFIG.STORAGE_KEYS.ORG_URL_RAW, raw);

        const orgUrl = adoUtils.extractOrgUrl(raw);
        if (!orgUrl || !pat) {
            alert("Please enter both a valid ADO URL and a PAT.");
            return;
        }

        statusMsg.textContent = "Validating...";

        // Validate connection
        const isValid = await fetch(`${orgUrl}/_apis/projects?api-version=7.0`, {
            headers: createAdoHeaders(pat)
        }).then(response => response.ok).catch(() => false);

        if (isValid) {
            // Save credentials (PAT is encrypted)
            await storage.saveLocal(CONFIG.STORAGE_KEYS.ORG_URL, orgUrl);
            await storage.saveEncrypted(CONFIG.STORAGE_KEYS.PAT, pat);

            orgNameSpan.textContent = adoUtils.extractOrgName(orgUrl);
            configSection.open = false;
            statusMsg.textContent = "";

            // Notify parent that config is ready
            if (onConfigured) {
                const adoApi = new AdoApiClient(orgUrl);
                onConfigured(orgUrl, adoApi);
            }
        } else {
            statusMsg.textContent = "Invalid PAT or Org URL.";
        }

        setInputVisibility(false);
    });

    function setInputVisibility(hasFocus) {
        const display = hasFocus ? "block" : "none";
        patLabel.style.display = display;
        patInput.style.display = display;
        saveConfigBtn.style.display = display;
        // Show consent line when PAT input is visible
        const consentLine = document.getElementById("consent-line");
        if (consentLine) consentLine.style.display = display;
    }

    /**
     * Initialize config panel from stored settings
     * @returns {Promise<{orgUrl: string, adoApi: AdoApiClient}|null>}
     */
    async function init() {
        const keys = CONFIG.STORAGE_KEYS;

        // Load config values (PAT is encrypted)
        const [orgUrl, pat, orgUrlRaw] = await Promise.all([
            storage.loadLocal(keys.ORG_URL),
            storage.loadEncrypted(keys.PAT),
            storage.loadLocal(keys.ORG_URL_RAW)
        ]);

        // Restore raw URL input
        if (orgUrlRaw) {
            orgUrlInput.value = orgUrlRaw;
            const extractedOrgUrl = adoUtils.extractOrgUrl(orgUrlRaw);
            const name = adoUtils.extractOrgName(orgUrlRaw);
            if (name) orgNameSpan.textContent = name;
            if (extractedOrgUrl) {
                openPatLink.style.pointerEvents = "auto";
                openPatLink.style.opacity = "1";
                patInput.disabled = false;
            }
        }

        // Check if already configured
        if (orgUrl && pat) {
            orgNameSpan.textContent = adoUtils.extractOrgName(orgUrl) || orgUrl;
            configSection.open = false;
            statusMsg.textContent = "";

            const adoApi = new AdoApiClient(orgUrl);
            return { orgUrl, adoApi };
        } else {
            configSection.open = true;
            statusMsg.textContent = "No ADO connection set.";
            return null;
        }
    }

    return { init };
}
