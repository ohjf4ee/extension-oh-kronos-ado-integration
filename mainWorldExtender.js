// Runs in the page's MAIN JS world (declared via manifest "world": "MAIN").
//
// Why this file exists: the isolated-world content script can't read `angular`,
// so calling auth0StackService.extendSession() has historically been done by
// injecting a <script> element with inline code. That approach silently fails
// in this page's context for reasons we couldn't fully pin down (CSP, Trusted
// Types, or something else). Running here in the MAIN world bypasses every
// page-side script-injection restriction because the browser loads the file
// directly as part of the extension, not as a page-injected <script>.
//
// Protocol: the isolated-world script (contentScript.js) sends a
//   { type: '__KRONOS_KA_REQ__' }
// message via window.postMessage. We do the lookup and reply with one of:
//   { type: '__KRONOS_KA__', stage: '<stage>' [, error: '<msg>'] }
// which the isolated world picks up and stores in the diagnostic ring buffer.

(function () {
    'use strict';

    window.addEventListener('message', function (e) {
        if (e.source !== window) return;
        if (!e.data || e.data.type !== '__KRONOS_KA_REQ__') return;

        try {
            if (typeof angular === 'undefined') {
                window.postMessage({ type: '__KRONOS_KA__', stage: 'no-angular' }, '*');
                return;
            }
            var injector = angular.element(document.body).injector();
            if (!injector) {
                window.postMessage({ type: '__KRONOS_KA__', stage: 'no-injector' }, '*');
                return;
            }
            var svc = injector.get('auth0StackService');
            if (!svc) {
                window.postMessage({ type: '__KRONOS_KA__', stage: 'no-svc' }, '*');
                return;
            }
            if (svc.isExtending && svc.isExtending()) {
                window.postMessage({ type: '__KRONOS_KA__', stage: 'already-extending' }, '*');
                return;
            }
            console.log('[Kronos-ADO Extension] Proactively extending session...');
            window.postMessage({ type: '__KRONOS_KA__', stage: 'calling-extend' }, '*');
            svc.extendSession();
            window.postMessage({ type: '__KRONOS_KA__', stage: 'extend-called' }, '*');
        } catch (err) {
            console.warn('[Kronos-ADO Extension] Could not extend session:', err && err.message);
            window.postMessage({ type: '__KRONOS_KA__', stage: 'error', error: err && err.message }, '*');
        }
    });
})();
