"use strict";

const LOG_PREFIX = "\x1B[1mEXTENSION Kronos-ADO-integration[contentScript.js]:\x1B[m ";


function isInListView() {
    // If "Table view" button is visible, we're in List view
    // If "List view" button is visible, we're in Table view
    return document.querySelector("button[aria-label='Table view']") !== null;
}

function startTimecardLogic() {
    console.debug(LOG_PREFIX + "Waiting for timecard UI...");

    // Wait for either view's content to load
    waitForElementToAppear(
        "span.cellText > span > span, krn-slats-component",
        function () {
            if (isInListView()) {
                console.debug(LOG_PREFIX + "List view detected, parsing slats...");
                setTimeout(calculateKronosTimesFromListView, 500);
            } else {
                console.debug(LOG_PREFIX + "Table view detected, parsing grid...");
                setTimeout(calculateKronosTimes, 500);
            }
        },
        1000
    );
}

function waitForElementToAppear(selector, callback, waitTime) {
    if (document.querySelector(selector)) {
        callback();
    } else {
        setTimeout(function () {
            waitForElementToAppear(selector, callback, waitTime);
        }, waitTime);
    }
}

function calculateKronosTimesFromListView() {
    console.debug(LOG_PREFIX + "Parsing the timesheet from List view...");

    // In List view, each day is a "slat" component
    // We need to extract: date, daily total, and period running total
    const slats = document.querySelectorAll(".slats-component-slat");
    let hoursByDay = {};
    let periodTotal = 0;

    slats.forEach((slat) => {
        // Get the date from the slat header (e.g., "Sun, Feb 08")
        const dateHeader = slat.querySelector("[id^='tk-slat-date-']");
        if (!dateHeader) return;

        const dateText = dateHeader.textContent.trim();
        // Parse date like "Sun, Feb 08" or "Thu, Feb 20"
        const dateMatch = dateText.match(/\w+,\s+(\w+)\s+(\d+)/);
        if (!dateMatch) return;

        const monthName = dateMatch[1];
        const dayNum = parseInt(dateMatch[2], 10);

        // Convert month name to number
        const monthMap = {
            'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
            'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
        };
        const month = monthMap[monthName];
        if (month === undefined) return;

        // Determine the correct year
        const now = new Date();
        let year = now.getFullYear();
        // Handle year boundary cases
        if (month === 11 && now.getMonth() === 0) {
            year = now.getFullYear() - 1;
        } else if (month === 0 && now.getMonth() === 11) {
            year = now.getFullYear() + 1;
        }

        const rowDate = new Date(year, month, dayNum);
        const dateKey = rowDate.toISOString().slice(0, 10);

        // Get daily total from the slat
        // Look for the daily totals value (e.g., "8.00")
        const dailyTotalEl = slat.querySelector(".tk-daily-totals-value");
        let dailyTotal = "0";
        if (dailyTotalEl) {
            // Round to nearest tenth of an hour
            const rawValue = parseFloat(dailyTotalEl.textContent.trim()) || 0;
            dailyTotal = roundToDecimalPlaces(rawValue, 1).toString();
        }

        // Only include days that have passed (or today)
        if (rowDate <= now) {
            hoursByDay[dateKey] = { hours: dailyTotal };
            periodTotal += parseFloat(dailyTotal) || 0;
        }
    });

    // Also try to get the period total from the roll-up if available
    const rollUpTotal = document.querySelector(".rollUp-container__cell.middle .value");
    if (rollUpTotal) {
        const totalMatch = rollUpTotal.textContent.match(/([\d.]+)/);
        if (totalMatch) {
            console.log(LOG_PREFIX + "Period total from roll-up: " + totalMatch[1]);
        }
    }

    console.log(LOG_PREFIX + "Time card data from List view:");
    console.table(hoursByDay);

    // Store the data the same way as Table view
    chrome.storage.local.get("kronos_hoursByDay", (result) => {
        const existing = result.kronos_hoursByDay || {};
        let changed = false;

        for (const [date, value] of Object.entries(hoursByDay)) {
            if (!existing[date] || existing[date].hours !== value.hours) {
                changed = true;
            }
            existing[date] = value;
        }

        chrome.storage.local.set({ kronos_hoursByDay: existing }, () => {
            if (chrome.runtime.lastError) {
                console.error(LOG_PREFIX + "Storage failed:", chrome.runtime.lastError);
            } else {
                console.debug(LOG_PREFIX + "Upserted hoursByDay to chrome.storage.local (from List view)");
                if (changed) {
                    chrome.runtime.sendMessage({ action: "timecardDataUpdated" }, () => {
                        if (chrome.runtime.lastError) {
                            console.debug(LOG_PREFIX + "Message send failed (sidebar may not be ready):", chrome.runtime.lastError.message);
                        }
                    });
                }
            }
        });
    });

    // Note: List view doesn't show the same detailed punch data as Table view,
    // so we skip the "target out time" calculation for now.
    // Users who need that feature should use Table view.
    console.log(LOG_PREFIX + "Note: Target out time calculation requires Table view");
}

function calculateKronosTimes() {
    console.debug(LOG_PREFIX + "Parsing the timesheet from Table view...");
    // Scrape the DOM for the timesheet rows' data
    let timesheetRows = [];
    let leftGridRows = document.querySelectorAll(".ui-grid-render-container-left div.ui-grid-viewport div[role='row']");
    for (let gridRow of leftGridRows) {
        timesheetRows.push({ Date: gridRow.innerText });
    }
    let bodyGridRows = document.querySelectorAll(".ui-grid-render-container-body div.ui-grid-viewport div[role='row']");
    for (let rowIndex = 0; rowIndex < bodyGridRows.length; rowIndex++) {
        let timecardCells = bodyGridRows[rowIndex].querySelectorAll("timecard-cell");
        timesheetRows[rowIndex].inPunch = timecardCells[2].innerText;
        timesheetRows[rowIndex].outPunch = timecardCells[4].innerText;
        timesheetRows[rowIndex].dailyTotal = timecardCells[8].innerText;
        timesheetRows[rowIndex].periodRunningTotal = timecardCells[9].innerText;
    }

    // Process the timesheet row data we scraped

    let cumulativeExpectedHoursFor80HourPeriod = {
        "-1": 0,
        0: 0,
        1: 8,
        2: 16,
        3: 24,
        4: 32,
        5: 40,
        6: 40,
        7: 40,
        8: 48,
        9: 56,
        10: 64,
        11: 72,
        12: 80,
        13: 80,
    };
    let dayIndex = -1;
    let previousRow = { Date: "" };
    let cumulativeTotalForWeek1 = 0;

    function calculateRowMetrics(row) {
        // Do calculations for the row
        row.expectedHoursFor80HourPeriod = cumulativeExpectedHoursFor80HourPeriod[dayIndex];
        row.expectedHoursFor40HourWeek =
            cumulativeExpectedHoursFor80HourPeriod[dayIndex] - 40 <= 0 ? cumulativeExpectedHoursFor80HourPeriod[dayIndex] : cumulativeExpectedHoursFor80HourPeriod[dayIndex] - 40;
        row.actualHoursFor80HourPeriod = parseFloat(row.periodRunningTotal || 0);
        if (dayIndex <= 6) {
            row.actualHoursFor40HourWeek = roundToDecimalPlaces(row.actualHoursFor80HourPeriod, 1);
        }
        if (dayIndex == 6) {
            cumulativeTotalForWeek1 = row.actualHoursFor40HourWeek;
        }
        if (dayIndex >= 7) {
            row.actualHoursFor40HourWeek = roundToDecimalPlaces(parseFloat(row.periodRunningTotal || 0) - cumulativeTotalForWeek1, 1);
        }

        row.hoursDifferenceFor80HourPeriod = roundToDecimalPlaces(row.actualHoursFor80HourPeriod - row.expectedHoursFor80HourPeriod, 1);
        row.hoursDifferenceFor40HourWeek = roundToDecimalPlaces(row.actualHoursFor40HourWeek - row.expectedHoursFor40HourWeek, 1);
        row.formattedDifferenceFor80HourPeriod =
            (row.hoursDifferenceFor80HourPeriod >= 0 ? "+" : "-") +
            Math.floor(Math.abs(row.hoursDifferenceFor80HourPeriod)).toString().padStart(2, "0") +
            ":" +
            Math.round((Math.abs(row.hoursDifferenceFor80HourPeriod) - Math.floor(Math.abs(row.hoursDifferenceFor80HourPeriod))) * 60, 0)
                .toString()
                .padStart(2, "0");
        row.formattedDifferenceFor40HourWeek =
            (row.hoursDifferenceFor40HourWeek >= 0 ? "+" : "-") +
            Math.floor(Math.abs(row.hoursDifferenceFor40HourWeek)).toString().padStart(2, "0") +
            ":" +
            Math.round((Math.abs(row.hoursDifferenceFor40HourWeek) - Math.floor(Math.abs(row.hoursDifferenceFor40HourWeek))) * 60, 0)
                .toString()
                .padStart(2, "0");
    }

    // For each row in the timesheet...
    timesheetRows.forEach((currentRow) => {
        // If this row has a date and it isn't equal to the previous row's date...
        if (currentRow.Date != "" && currentRow.Date != previousRow.Date) {
            // Then the previous row is the final row for the previous date
            // So, do calculations for it
            calculateRowMetrics(previousRow);
            dayIndex++;
        }
        previousRow = currentRow;
    });
    calculateRowMetrics(previousRow);

    let hoursByDay = {};

    // For each row in the timesheet...
    for (let rowIndex = 0; rowIndex < timesheetRows.length; rowIndex++) {
        // Ignore rows with no Date string value
        if (timesheetRows[rowIndex].Date === "") continue;
        // Convert the string into an actual date time object
        // (defaults to 2001 for some reason)
        let rowDate = new Date(Date.parse(timesheetRows[rowIndex].Date));
        let now = new Date();
        // Determine the correct year and set rowDate's year to it
        if (rowDate.getMonth() === 11 && now.getMonth() === 0) {
            rowDate.setFullYear(now.getFullYear() - 1);
        } else if (rowDate.getMonth() === 0 && now.getMonth() === 11) {
            rowDate.setFullYear(now.getFullYear() + 1);
        } else {
            rowDate.setFullYear(now.getFullYear());
        }

        // TODO - the following code isn't going to work if there are hours on the last day!

        // Determine yesterday's date
        let yesterday = new Date(rowDate);
        yesterday.setDate(rowDate.getDate() - 1);

        if (rowIndex > 0) {
            // Round to nearest tenth of an hour
            const rawHours = parseFloat(timesheetRows[rowIndex - 1].dailyTotal) || 0;
            hoursByDay[yesterday.toISOString().slice(0, 10)] = { hours: roundToDecimalPlaces(rawHours, 1).toString() };
        }

        // If the current date and time is less than the row's date...
        if (now < rowDate) {
            // Slice off any rows after this one in our array of timesheet rows
            timesheetRows = timesheetRows.slice(0, rowIndex);
            // Isolate yesterday's Year Month Day
            let yesterdayYMD = yesterday.toString().slice(0, yesterday.toString().indexOf(":") - 2);
            // Get the last punch time and convert it into a date-time
            let lastPunch;
            let basedOn;
            if (timesheetRows[rowIndex - 1].outPunch === "") {
                lastPunch = timesheetRows[rowIndex - 1].inPunch;
                lastPunch = lastPunch.replace(" ", "").slice(0, -2) + " " + lastPunch.slice(-2);
                basedOn = "based on last punch in time";
            } else {
                lastPunch = new Date().toTimeString().slice(0, 5);
                basedOn = "if you punch in now";
            }
            let lastPunchDate = new Date(yesterdayYMD + lastPunch);
            // Determine the number of hours needed for today
            let hoursNeededForToday = timesheetRows[rowIndex - 1].expectedHoursFor40HourWeek - timesheetRows[rowIndex - 1].actualHoursFor40HourWeek;
            hoursNeededForToday = hoursNeededForToday < 0 ? 0 : hoursNeededForToday;
            // Use that number to determine the target out time for today
            let targetOut = addHoursToDate(lastPunchDate, hoursNeededForToday);
            targetOut = targetOut.toLocaleString();
            targetOut = targetOut.slice(targetOut.indexOf(" ") + 1).split(/[: ]/);
            targetOut = targetOut[0] + ":" + targetOut[1] + " " + targetOut[3];
            timesheetRows[rowIndex - 1].targetOut = targetOut;
            // Create a corresponding message and display it
            const divForMessage = document.createElement("div");
            let messagePrefix = `Today's target out time: `;
            let messageSuffix = ` (target for clocking 40 hours in this week ${basedOn})`;
            console.log(LOG_PREFIX + messagePrefix + targetOut + messageSuffix);
            divForMessage.innerHTML =
                `<div style="border: 10px double red; border-radius: 12px; padding: 5px 6px; line-height: normal;">` +
                `${messagePrefix} &nbsp;&nbsp;&nbsp;<span style="font-weight: bold">${targetOut}</span> &nbsp; <i>${messageSuffix}</i></div>`;
            document
                .querySelector("div#editor\\.timecard[data-framework='action-bar'] > div:first-child > div:first-child")
                .appendChild(divForMessage);
            break;
        }
    }
    console.log(LOG_PREFIX + "Time card data through today:");
    console.table(timesheetRows);
    console.table(hoursByDay);
    chrome.storage.local.get("kronos_hoursByDay", (result) => {
        const existing = result.kronos_hoursByDay || {};
        let changed = false;

        // Upsert: overwrite/add new values but preserve old ones
        for (const [date, value] of Object.entries(hoursByDay)) {
            if (!existing[date] || existing[date].hours !== value.hours) {
                changed = true;
            }
            existing[date] = value;
        }

        chrome.storage.local.set({ kronos_hoursByDay: existing }, () => {
            if (chrome.runtime.lastError) {
                console.error(LOG_PREFIX + "Storage failed:", chrome.runtime.lastError);
            } else {
                console.debug(LOG_PREFIX + "Upserted hoursByDay to chrome.storage.local");
                if (changed) {
                    chrome.runtime.sendMessage({ action: "timecardDataUpdated" }, () => {
                        if (chrome.runtime.lastError) {
                            console.debug(LOG_PREFIX + "Message send failed (sidebar may not be ready):", chrome.runtime.lastError.message);
                        }
                    });
                }
            }
        });
    });
}

function roundToDecimalPlaces(value, digits) {
    const pow = Math.pow(10, digits);
    return Math.round(value * pow) / pow;
}

function addHoursToDate(date, hours) {
    const milliseconds = hours * 60 * 60 * 1000;
    return new Date(date.getTime() + milliseconds);
}

// Sidebar and iframe layout logic
const SIDEBAR_ID = "kronos-timecard-sidebar";
const PAGE_FRAME_ID = "kronos-timecard-page-frame";
const SIDEBAR_FRAME_ID = "kronos-timecard-sidebar-frame";
let defaultSidebarWidth = 1095;
let maximumSidebarWidth = window.innerWidth * 0.5;
let sidebarWidth = Math.max(100, defaultSidebarWidth <= maximumSidebarWidth ? defaultSidebarWidth : maximumSidebarWidth);
let windowResizeHandler = null;

function initializeFrames() {
    if (document.getElementById(PAGE_FRAME_ID)) return;
    const frame = document.createElement("iframe");
    frame.id = PAGE_FRAME_ID;
    frame.src = window.location.href;
    frame.style.position = "fixed";
    frame.style.top = "0";
    frame.style.left = "0";
    frame.style.height = "100%";
    frame.style.border = "none";
    frame.style.width = "100%";
    document.body.innerHTML = "";
    document.body.appendChild(frame);

    // When the page iframe loads, inject a click handler to redirect link navigations to the top-level window
    frame.addEventListener("load", () => {
        try {
            const iframeDoc = frame.contentDocument || frame.contentWindow.document;
            iframeDoc.addEventListener("click", (event) => {
                // Find the closest anchor element (handles clicks on child elements within links)
                const anchor = event.target.closest("a");
                if (anchor && anchor.href) {
                    // Skip if the link opens in a new tab/window
                    const target = anchor.target;
                    if (target === "_blank" || target === "_new") return;
                    // Skip javascript: links
                    if (anchor.href.startsWith("javascript:")) return;
                    // Skip if it's just a hash link on the same page
                    if (anchor.href.startsWith("#") || (anchor.getAttribute("href") || "").startsWith("#")) return;
                    // Redirect the navigation to the top-level window
                    event.preventDefault();
                    event.stopPropagation();
                    window.top.location.href = anchor.href;
                }
            }, true); // Use capture phase to intercept before other handlers
        } catch (err) {
            // Cross-origin iframe - can't inject handler (shouldn't happen for same-origin Kronos page)
            console.warn(LOG_PREFIX + "Could not inject link handler into page frame:", err);
        }
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "toggleSidebar") {
        console.debug(LOG_PREFIX + "received message toggleSidebar");
        toggleSidebar();
    }
});

function toggleSidebar() {
    console.debug(LOG_PREFIX + "START toggleSidebar()");
    const sidebar = document.getElementById(SIDEBAR_ID);
    const pageFrame = document.getElementById(PAGE_FRAME_ID);
    if (!pageFrame) return;
    if (sidebar) {
        sidebar.remove();
        pageFrame.style.width = "100%";
        if (windowResizeHandler) {
            window.removeEventListener("resize", windowResizeHandler);
            windowResizeHandler = null;
        }
        return;
    }

    const sidebarElement = document.createElement("div");
    sidebarElement.id = SIDEBAR_ID;
    sidebarElement.style.position = "fixed";
    sidebarElement.style.top = "0";
    sidebarElement.style.right = "0";
    sidebarElement.style.height = "100%";
    sidebarElement.style.background = "#fff";
    sidebarElement.style.boxShadow = "0 0 5px rgba(0,0,0,0.3)";
    sidebarElement.style.zIndex = "100000";
    sidebarElement.style.display = "flex";

    const resizeHandle = document.createElement("div");
    resizeHandle.style.width = "5px";
    resizeHandle.style.cursor = "ew-resize";
    resizeHandle.style.background = "#ccc";
    resizeHandle.style.position = "absolute";
    resizeHandle.style.left = "0";
    resizeHandle.style.top = "0";
    resizeHandle.style.bottom = "0";
    sidebarElement.appendChild(resizeHandle);

    const sidebarIframe = document.createElement("iframe");
    sidebarIframe.id = SIDEBAR_FRAME_ID;
    sidebarIframe.src = chrome.runtime.getURL("src/timecard-sidebar.html");
    sidebarIframe.style.border = "none";
    sidebarIframe.style.flex = "1";
    sidebarElement.appendChild(sidebarIframe);

    document.body.appendChild(sidebarElement);

    function applyLayout() {
        sidebarElement.style.width = sidebarWidth + "px";
        pageFrame.style.width = "calc(100% - " + sidebarWidth + "px)";
    }

    applyLayout();
    windowResizeHandler = applyLayout;
    window.addEventListener("resize", windowResizeHandler);

    let dragStartX = 0;
    let dragStartWidth = sidebarWidth;

    resizeHandle.addEventListener("mousedown", (event) => {
        dragStartX = event.clientX;
        dragStartWidth = sidebarWidth;
        sidebarIframe.style.pointerEvents = "none";
        pageFrame.style.pointerEvents = "none";
        document.documentElement.addEventListener("mousemove", handleDragMove);
        document.documentElement.addEventListener("mouseup", handleDragEnd);
    });

    function handleDragMove(event) {
        const dragDeltaX = dragStartX - event.clientX;
        sidebarWidth = Math.max(100, dragStartWidth + dragDeltaX);
        applyLayout();
    }

    function handleDragEnd() {
        document.documentElement.removeEventListener("mousemove", handleDragMove);
        document.documentElement.removeEventListener("mouseup", handleDragEnd);
        sidebarIframe.style.pointerEvents = "";
        pageFrame.style.pointerEvents = "";
    }
}

if (window.self === window.top) {
    initializeFrames();
    toggleSidebar();
} else {
    startTimecardLogic();
}
