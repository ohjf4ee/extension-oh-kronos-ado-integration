const LOG_PREFIX = "\x1B[1mEXTENSION Kronos-ADO-integration[background.js]:\x1B[m ";

// Toggle sidebar when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
    if (tab.id) {
        console.debug(LOG_PREFIX + "sending message toggleSidebar");
        chrome.tabs.sendMessage(tab.id, { action: "toggleSidebar" });
    }
});

// ---------------------------------------------------------------------------
// Session keep-alive (service-worker-driven, throttling-resistant)
// ---------------------------------------------------------------------------
// The in-tab setInterval can't survive Chrome's hidden-tab throttling, and
// chrome.tabs.sendMessage to a heavily-throttled tab gets queued but not
// delivered until the tab wakes up. The combination that actually works:
//   1. chrome.alarms fires in the service worker on its own scheduler.
//   2. On fire, chrome.scripting.executeScript injects a function into the
//      tab's MAIN world. The injection forces the renderer to run code,
//      which wakes the tab enough to call Auth0's extendSession() directly.
const KEEP_ALIVE_ALARM_NAME = 'kronos-session-keep-alive';
const KEEP_ALIVE_PERIOD_MIN = 1;
const KRONOS_TAB_URL_PATTERN = 'https://stateofohiodas-sso.prd.mykronos.com/timekeeping*';
const KEEPALIVE_LOG_KEY = 'kronos_keepAliveLog';
const MAX_LOG_ENTRIES = 500;

function syncKeepAliveAlarm() {
    chrome.storage.local.get('kronos_sessionKeepAlive', (result) => {
        if (result.kronos_sessionKeepAlive) {
            chrome.alarms.create(KEEP_ALIVE_ALARM_NAME, { periodInMinutes: KEEP_ALIVE_PERIOD_MIN });
            console.debug(LOG_PREFIX + "keep-alive alarm scheduled");
        } else {
            chrome.alarms.clear(KEEP_ALIVE_ALARM_NAME);
            console.debug(LOG_PREFIX + "keep-alive alarm cleared");
        }
    });
}

// Critical: top-level call. Service workers wake up on events without
// re-firing onInstalled/onStartup — so without this, a fresh service worker
// has no alarm registered. Top-level code runs on every SW spin-up.
syncKeepAliveAlarm();

chrome.runtime.onInstalled.addListener(syncKeepAliveAlarm);
chrome.runtime.onStartup.addListener(syncKeepAliveAlarm);

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'kronos_sessionKeepAlive' in changes) {
        syncKeepAliveAlarm();
    }
});

// Injected into the page's MAIN world by chrome.scripting.executeScript.
// Runs synchronously in the tab. Reads Auth0 session state from localStorage,
// applies the same 20-minute idle threshold the in-tab logic uses, and if it
// should extend, calls auth0StackService.extendSession() directly.
function runCheckAndExtendInPageWorld() {
    try {
        const cidRaw = localStorage.getItem('ngStorage-AUTH0_SESSION_CLIENT_ID');
        if (!cidRaw) return { stage: 'no-client-id' };
        const cid = JSON.parse(cidRaw);
        const sessRaw = localStorage.getItem('ngStorage-' + cid);
        if (!sessRaw) return { stage: 'no-session' };
        const state = JSON.parse(sessRaw);

        const now = Date.now();
        const idleMs = now - state.lastAuth0CallTime;
        const idleMinutes = Math.round(idleMs / 60000);
        const MAX_IDLE = 20 * 60 * 1000;
        const documentHidden = document.hidden;

        if (idleMs < MAX_IDLE) {
            return { stage: 'not-idle', idleMinutes, documentHidden };
        }
        if (state.isExtending) {
            return { stage: 'state-isExtending', idleMinutes, documentHidden };
        }
        if (typeof angular === 'undefined') {
            return { stage: 'no-angular', idleMinutes, documentHidden };
        }
        const injector = angular.element(document.body).injector();
        if (!injector) return { stage: 'no-injector', idleMinutes, documentHidden };
        const svc = injector.get('auth0StackService');
        if (!svc) return { stage: 'no-svc', idleMinutes, documentHidden };
        if (svc.isExtending && svc.isExtending()) {
            return { stage: 'svc-isExtending', idleMinutes, documentHidden };
        }

        console.log('[Kronos-ADO Extension] SW-driven extend at idle', idleMinutes, 'min');
        svc.extendSession();
        return { stage: 'extend-called', idleMinutes, documentHidden };
    } catch (e) {
        return { stage: 'error', error: String(e && e.message) };
    }
}

function logSwEvent(event, data) {
    const entry = {
        ts: new Date().toISOString(),
        frame: 'sw',
        url: '',
        event,
        data: data || {}
    };
    console.log('[KEEPALIVE-SW]', entry);
    chrome.storage.local.get(KEEPALIVE_LOG_KEY, (r) => {
        const log = Array.isArray(r[KEEPALIVE_LOG_KEY]) ? r[KEEPALIVE_LOG_KEY] : [];
        log.push(entry);
        while (log.length > MAX_LOG_ENTRIES) log.shift();
        chrome.storage.local.set({ [KEEPALIVE_LOG_KEY]: log });
    });
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEP_ALIVE_ALARM_NAME) return;
    chrome.tabs.query({ url: KRONOS_TAB_URL_PATTERN }, (tabs) => {
        if (!tabs.length) {
            logSwEvent('sw-tick', { stage: 'no-tabs' });
            return;
        }
        for (const tab of tabs) {
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN',
                func: runCheckAndExtendInPageWorld
            }, (results) => {
                if (chrome.runtime.lastError) {
                    logSwEvent('sw-tick', {
                        tabId: tab.id,
                        stage: 'inject-failed',
                        error: chrome.runtime.lastError.message
                    });
                    return;
                }
                const result = (results && results[0] && results[0].result) || { stage: 'no-result' };
                logSwEvent('sw-tick', { tabId: tab.id, ...result });
            });
        }
    });
});
