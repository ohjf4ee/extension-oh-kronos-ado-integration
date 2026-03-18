// Config panel UI component for Kronos-ADO integration
// Handles ADO organization URL and PAT configuration

import { CONFIG } from '../config.js';
import * as storage from '../storage.js';
import { AdoApiClient, createAdoHeaders, adoUtils } from '../ado/index.js';

// Privacy policy URL (update this when hosting location is finalized)
const PRIVACY_POLICY_URL = 'https://github.com/ohjf4ee/extension-oh-kronos-ado-integration/blob/main/PRIVACY.md';

// Idle refresh configuration
const IDLE_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes
const COUNTDOWN_SECONDS = 10;
const SNOOZE_MS = 60 * 1000; // 1 minute

// Module-level state for idle refresh
let idleTimeoutId = null;
let countdownIntervalId = null;
let idleRefreshEnabled = false;
let refreshPopupElement = null;

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
     * Start idle refresh monitoring
     */
    function startIdleRefresh() {
        if (idleRefreshEnabled) return;
        idleRefreshEnabled = true;

        // Listen for mouse movement to reset idle timer
        document.addEventListener('mousemove', resetIdleTimer);

        // Start the idle timer
        resetIdleTimer();
        console.debug('[config-panel] Idle refresh started (25 min timeout)');
    }

    /**
     * Stop idle refresh monitoring
     */
    function stopIdleRefresh() {
        idleRefreshEnabled = false;
        document.removeEventListener('mousemove', resetIdleTimer);
        clearTimeout(idleTimeoutId);
        clearInterval(countdownIntervalId);
        hideRefreshPopup();
        console.debug('[config-panel] Idle refresh stopped');
    }

    /**
     * Reset the idle timer (called on mouse movement)
     */
    function resetIdleTimer() {
        if (!idleRefreshEnabled) return;

        // Clear any existing timeout
        clearTimeout(idleTimeoutId);
        clearInterval(countdownIntervalId);
        hideRefreshPopup();

        // Set new timeout
        idleTimeoutId = setTimeout(showRefreshPopup, IDLE_TIMEOUT_MS);
    }

    /**
     * Show the refresh countdown popup
     */
    function showRefreshPopup() {
        if (!idleRefreshEnabled) return;

        // Create popup if it doesn't exist
        if (!refreshPopupElement) {
            refreshPopupElement = document.createElement('div');
            refreshPopupElement.id = 'idle-refresh-popup';
            refreshPopupElement.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                background: #fff3cd;
                border-bottom: 2px solid #ffc107;
                padding: 12px 16px;
                z-index: 9999;
                box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                font-family: sans-serif;
            `;
            document.body.prepend(refreshPopupElement);
        }

        let secondsLeft = COUNTDOWN_SECONDS;
        updatePopupContent(secondsLeft);
        refreshPopupElement.style.display = 'block';

        // Start countdown
        countdownIntervalId = setInterval(() => {
            secondsLeft--;
            if (secondsLeft <= 0) {
                clearInterval(countdownIntervalId);
                doRefresh();
            } else {
                updatePopupContent(secondsLeft);
            }
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

        // Attach button handlers
        document.getElementById('idle-refresh-cancel')?.addEventListener('click', handleCancel);
        document.getElementById('idle-refresh-snooze')?.addEventListener('click', handleSnooze);
        document.getElementById('idle-refresh-now')?.addEventListener('click', doRefresh);
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
     * Handle cancel button - reset to full 25 minutes
     */
    function handleCancel() {
        clearInterval(countdownIntervalId);
        hideRefreshPopup();
        resetIdleTimer();
    }

    /**
     * Handle snooze button - add 1 minute
     */
    function handleSnooze() {
        clearInterval(countdownIntervalId);
        hideRefreshPopup();
        // Set a shorter timeout for snooze
        clearTimeout(idleTimeoutId);
        idleTimeoutId = setTimeout(showRefreshPopup, SNOOZE_MS);
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
