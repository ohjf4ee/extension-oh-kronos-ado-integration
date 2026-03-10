// Config panel UI component for Kronos-ADO integration
// Handles ADO organization URL and PAT configuration

import { CONFIG } from '../config.js';
import * as storage from '../storage.js';
import { AdoApiClient, createAdoHeaders, adoUtils } from '../ado/index.js';

// Privacy policy URL (update this when hosting location is finalized)
const PRIVACY_POLICY_URL = 'https://github.com/ohjf4ee/extension-oh-kronos-ado-integration/blob/main/PRIVACY.md';

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
        sessionKeepAliveCheckbox,
        keepAliveStatus
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

    // Setup session keep-alive toggle if present
    if (sessionKeepAliveCheckbox) {
        sessionKeepAliveCheckbox.addEventListener('change', handleSessionKeepAliveToggle);
        initSessionKeepAliveState();
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
                // Also disable the alarm
                chrome.runtime.sendMessage({ action: 'setSessionKeepAlive', enabled: false });
            }
            updateSaveButtonState();
            if (showToast) showToast('All data cleared successfully', 'success');
        } catch (error) {
            console.error('Failed to clear data:', error);
            if (showToast) showToast('Failed to clear data: ' + error.message, 'error');
        }
    }

    /**
     * Initialize session keep-alive checkbox state from storage
     */
    async function initSessionKeepAliveState() {
        const stored = await storage.loadLocal(CONFIG.STORAGE_KEYS.SESSION_KEEP_ALIVE);
        if (sessionKeepAliveCheckbox) {
            sessionKeepAliveCheckbox.checked = !!stored;
        }
        updateKeepAliveStatusDisplay();
    }

    /**
     * Handle session keep-alive toggle change
     */
    async function handleSessionKeepAliveToggle() {
        const enabled = sessionKeepAliveCheckbox.checked;

        // Save preference to storage
        await storage.saveLocal(CONFIG.STORAGE_KEYS.SESSION_KEEP_ALIVE, enabled);

        // Send message to background script to enable/disable alarm
        try {
            const response = await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                    { action: 'setSessionKeepAlive', enabled },
                    resolve
                );
            });

            if (response && response.success) {
                updateKeepAliveStatusDisplay();
                if (showToast) {
                    showToast(
                        enabled ? 'Session keep-alive enabled' : 'Session keep-alive disabled',
                        'success'
                    );
                }
            } else {
                throw new Error('Failed to update keep-alive setting');
            }
        } catch (error) {
            console.error('Failed to toggle session keep-alive:', error);
            // Revert checkbox on error
            sessionKeepAliveCheckbox.checked = !enabled;
            await storage.saveLocal(CONFIG.STORAGE_KEYS.SESSION_KEEP_ALIVE, !enabled);
            if (showToast) showToast('Failed to update setting: ' + error.message, 'error');
        }
    }

    /**
     * Update the keep-alive status display text
     */
    async function updateKeepAliveStatusDisplay() {
        if (!keepAliveStatus) return;

        try {
            const response = await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                    { action: 'getSessionKeepAliveStatus' },
                    resolve
                );
            });

            if (response && response.enabled && response.nextScheduledTime) {
                const nextPing = new Date(response.nextScheduledTime);
                keepAliveStatus.textContent = `(next ping: ${nextPing.toLocaleTimeString()})`;
            } else {
                keepAliveStatus.textContent = '';
            }
        } catch (error) {
            keepAliveStatus.textContent = '';
        }
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
