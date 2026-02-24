const LOG_PREFIX = "\x1B[1mEXTENSION Kronos-ADO-integration[background.js]:\x1B[m ";
chrome.action.onClicked.addListener((tab) => {
    if (tab.id) {
        console.debug(LOG_PREFIX + "sending message toggleSidebar");
        chrome.tabs.sendMessage(tab.id, { action: "toggleSidebar" });
    }
});
