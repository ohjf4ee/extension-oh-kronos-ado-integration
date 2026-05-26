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

    // Setup session keep-alive toggle if present
    if (sessionKeepAliveCheckbox) {
        sessionKeepAliveCheckbox.addEventListener('change', handleSessionKeepAliveToggle);
        initSessionKeepAliveState();
    }

    // Diagnostic log buttons for the keep-alive feature
    const exportKeepAliveLogBtn = document.getElementById('export-keep-alive-log-btn');
    if (exportKeepAliveLogBtn) {
        exportKeepAliveLogBtn.addEventListener('click', handleExportKeepAliveLog);
    }
    const clearKeepAliveLogBtn = document.getElementById('clear-keep-alive-log-btn');
    if (clearKeepAliveLogBtn) {
        clearKeepAliveLogBtn.addEventListener('click', handleClearKeepAliveLog);
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
            }
            updateSaveButtonState();
            if (showToast) showToast('All data cleared successfully', 'success');
        } catch (error) {
            console.error('Failed to clear data:', error);
            if (showToast) showToast('Failed to clear data: ' + error.message, 'error');
        }
    }

    // =========================================================================
    // Session Keep-Alive Feature
    // =========================================================================

    /**
     * Initialize session keep-alive state from storage
     */
    async function initSessionKeepAliveState() {
        const stored = await storage.loadLocal(CONFIG.STORAGE_KEYS.SESSION_KEEP_ALIVE);
        if (sessionKeepAliveCheckbox) {
            sessionKeepAliveCheckbox.checked = !!stored;
        }
    }

    /**
     * Handle session keep-alive toggle change
     */
    async function handleSessionKeepAliveToggle() {
        const enabled = sessionKeepAliveCheckbox.checked;
        await storage.saveLocal(CONFIG.STORAGE_KEYS.SESSION_KEEP_ALIVE, enabled);

        if (showToast) {
            showToast(enabled ? 'Session keep-alive enabled' : 'Session keep-alive disabled', 'success');
        }
    }

    async function handleExportKeepAliveLog() {
        const status = document.getElementById('export-keep-alive-log-status');
        const result = await new Promise((resolve) => {
            chrome.storage.local.get('kronos_keepAliveLog', resolve);
        });
        const log = Array.isArray(result.kronos_keepAliveLog) ? result.kronos_keepAliveLog : [];
        const text = JSON.stringify(log, null, 2);
        const count = log.length;

        // Try clipboard API first (fails inside Kronos's iframe due to its
        // permissions policy). Fall back to execCommand, then to a textarea
        // the user can manually select+copy.
        try {
            await navigator.clipboard.writeText(text);
            const msg = `Copied ${count} entries to clipboard.`;
            if (status) status.textContent = msg;
            if (showToast) showToast(msg, 'success');
            return;
        } catch (_) { /* fall through */ }

        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            if (ok) {
                const msg = `Copied ${count} entries to clipboard (fallback).`;
                if (status) status.textContent = msg;
                if (showToast) showToast(msg, 'success');
                return;
            }
        } catch (_) { /* fall through */ }

        // Last resort: render the JSON in a visible textarea for manual copy.
        showLogTextarea(text, count, status);
    }

    function showLogTextarea(text, count, status) {
        let host = document.getElementById('keep-alive-log-textarea-host');
        if (!host) {
            host = document.createElement('div');
            host.id = 'keep-alive-log-textarea-host';
            host.style.cssText = 'margin: 8px 0 0 24px;';
            const btn = document.getElementById('export-keep-alive-log-btn');
            if (btn && btn.parentNode) btn.parentNode.appendChild(host);
        }
        host.innerHTML = '';
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size: 0.8em; color: #666; margin-bottom: 4px;';
        hint.textContent = `Clipboard blocked by Kronos's iframe policy. Click in the box, then Ctrl+A, Ctrl+C to copy all ${count} entries.`;
        host.appendChild(hint);
        const ta = document.createElement('textarea');
        ta.readOnly = true;
        ta.value = text;
        ta.style.cssText = 'width: 100%; height: 200px; font-family: monospace; font-size: 11px;';
        ta.addEventListener('focus', () => ta.select());
        host.appendChild(ta);
        ta.focus();
        if (status) status.textContent = `${count} entries shown for manual copy.`;
    }

    async function handleClearKeepAliveLog() {
        const status = document.getElementById('export-keep-alive-log-status');
        try {
            await new Promise((resolve) => {
                chrome.storage.local.set({ kronos_keepAliveLog: [] }, resolve);
            });
            if (status) status.textContent = 'Log cleared.';
            if (showToast) showToast('Keep-alive log cleared', 'success');
        } catch (e) {
            const msg = 'Clear failed: ' + e.message;
            if (status) status.textContent = msg;
            if (showToast) showToast(msg, 'error');
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
