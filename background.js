const LOG_PREFIX = "\x1B[1mEXTENSION Kronos-ADO-integration[background.js]:\x1B[m ";

// Storage key for session keep-alive setting (must match config.js)
const STORAGE_KEY_SESSION_KEEP_ALIVE = 'kronos_sessionKeepAlive';

// Alarm name for session keep-alive
const KEEP_ALIVE_ALARM_NAME = 'kronos-session-keep-alive';

// Keep-alive interval in minutes (20 minutes to stay well under 30-minute timeout)
const KEEP_ALIVE_INTERVAL_MINUTES = 20;

// Kronos SSO ping endpoint - lightweight request that extends the session
const KRONOS_PING_URL = 'https://stateofohiodas-sso.prd.mykronos.com/sso/ping';

/**
 * Session Keep-Alive Feature
 *
 * Kronos sessions timeout after 30 minutes of inactivity, requiring users to
 * re-authenticate with MFA. This is disruptive for users who need quick access
 * to punch in/out throughout the day.
 *
 * When enabled by the user, this feature uses chrome.alarms to send periodic
 * lightweight requests to the Kronos SSO ping endpoint. Unlike setInterval,
 * chrome.alarms runs reliably even when the browser tab is in the background
 * or the browser is throttling JavaScript execution.
 *
 * This is an opt-in feature - users must explicitly enable it in the settings.
 * It only extends the session while the browser is running, respecting the
 * organization's security policies for idle timeout.
 */

// Toggle sidebar when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
    if (tab.id) {
        console.debug(LOG_PREFIX + "sending message toggleSidebar");
        chrome.tabs.sendMessage(tab.id, { action: "toggleSidebar" });
    }
});

// Handle alarm events for session keep-alive
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === KEEP_ALIVE_ALARM_NAME) {
        await performKeepAlivePing();
    }
});

// Listen for messages from the sidebar to enable/disable keep-alive
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'setSessionKeepAlive') {
        handleSetSessionKeepAlive(message.enabled).then(sendResponse);
        return true; // Indicates async response
    }
    if (message.action === 'getSessionKeepAliveStatus') {
        getKeepAliveStatus().then(sendResponse);
        return true;
    }
});

/**
 * Enable or disable the session keep-alive alarm
 * @param {boolean} enabled - Whether to enable keep-alive
 */
async function handleSetSessionKeepAlive(enabled) {
    if (enabled) {
        // Create alarm that fires every 20 minutes
        await chrome.alarms.create(KEEP_ALIVE_ALARM_NAME, {
            periodInMinutes: KEEP_ALIVE_INTERVAL_MINUTES
        });
        // Also do an immediate ping to confirm it works
        const result = await performKeepAlivePing();
        console.debug(LOG_PREFIX + `Session keep-alive enabled (every ${KEEP_ALIVE_INTERVAL_MINUTES} minutes)`);
        return { success: true, enabled: true, pingResult: result };
    } else {
        await chrome.alarms.clear(KEEP_ALIVE_ALARM_NAME);
        console.debug(LOG_PREFIX + "Session keep-alive disabled");
        return { success: true, enabled: false };
    }
}

/**
 * Get current keep-alive status
 */
async function getKeepAliveStatus() {
    const alarm = await chrome.alarms.get(KEEP_ALIVE_ALARM_NAME);
    return {
        enabled: !!alarm,
        nextScheduledTime: alarm ? alarm.scheduledTime : null
    };
}

/**
 * Perform a keep-alive ping to the Kronos SSO endpoint
 */
async function performKeepAlivePing() {
    const timestamp = new Date().toLocaleTimeString();
    try {
        const response = await fetch(KRONOS_PING_URL, {
            method: 'GET',
            credentials: 'include'
        });

        if (response.ok && !response.redirected) {
            console.debug(LOG_PREFIX + `[${timestamp}] Keep-alive ping successful (${response.status})`);
            return { success: true, status: response.status };
        } else {
            // Session may have expired or user logged out
            console.warn(LOG_PREFIX + `[${timestamp}] Keep-alive ping returned ${response.status}${response.redirected ? ' (redirected)' : ''}`);
            return { success: false, status: response.status, redirected: response.redirected };
        }
    } catch (error) {
        console.error(LOG_PREFIX + `[${timestamp}] Keep-alive ping failed:`, error.message);
        return { success: false, error: error.message };
    }
}

// On extension startup, check if keep-alive should be restored
chrome.runtime.onStartup.addListener(async () => {
    const result = await chrome.storage.local.get(STORAGE_KEY_SESSION_KEEP_ALIVE);
    if (result[STORAGE_KEY_SESSION_KEEP_ALIVE]) {
        console.debug(LOG_PREFIX + "Restoring session keep-alive on browser startup");
        await handleSetSessionKeepAlive(true);
    }
});

// Also check on install/update
chrome.runtime.onInstalled.addListener(async () => {
    const result = await chrome.storage.local.get(STORAGE_KEY_SESSION_KEEP_ALIVE);
    if (result[STORAGE_KEY_SESSION_KEEP_ALIVE]) {
        console.debug(LOG_PREFIX + "Restoring session keep-alive after install/update");
        await handleSetSessionKeepAlive(true);
    }
});
