// ADO-specific utility functions for Kronos-ADO integration
// Functions for parsing and manipulating ADO work item data

const LOG_PREFIX = "\x1B[1mEXTENSION Kronos-ADO-integration[ado/utils.js]:\x1B[m ";

/**
 * Extract the base ADO organization URL from any ADO URL
 * @param {string} url - Any URL containing an ADO org reference
 * @returns {string|null} - The base org URL (e.g., "https://dev.azure.com/myorg") or null
 */
export function extractOrgUrl(url) {
    const match = url.match(/^https:\/\/dev\.azure\.com\/[^\/]+/);
    return match ? match[0] : null;
}

/**
 * Extract just the organization name from an ADO URL
 * @param {string} url - Any URL containing an ADO org reference
 * @returns {string} - The org name (decoded) or empty string
 */
export function extractOrgName(url) {
    const match = url.match(/^https:\/\/dev\.azure\.com\/([^\/]+)/);
    return match ? decodeURIComponent(match[1]) : "";
}

/**
 * Regex to match the hours tracking table by its header structure.
 * The Day and Notes header cells are optional so both formats match:
 *   3-col (legacy): Date | Hours | Total
 *   5-col:          Date | Day | Hours | Notes | Total
 * Used to identify hours tables in both descriptions (legacy) and comments (new)
 */
export const HOURS_TABLE_REGEX = /<table[\s\S]*?>\s*<tr><th style="[\s\S]*?">Date<\/th>(?:<th style="[\s\S]*?">Day<\/th>)?<th style="[\s\S]*?">Hours<\/th>(?:<th style="[\s\S]*?">Notes<\/th>)?<th style="[\s\S]*?">Total<\/th><\/tr>[\s\S]*?<\/table>/;

/** Short English day names indexed by Date.getDay() (fixed, locale-independent) */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Short day name (Mon/Tue/...) for a date string starting with YYYY-MM-DD.
 * Parses and reads in UTC so the calendar date maps to the same day name regardless of the
 * host machine's timezone (dates here are US Eastern calendar dates, not instants).
 * @param {string} dateStr
 * @returns {string} - Three-letter day name, or "" if unparseable
 */
export function dayOfWeekShort(dateStr) {
    const match = String(dateStr).match(/\d{4}-\d{2}-\d{2}/);
    if (!match) return '';
    const date = new Date(match[0] + 'T00:00:00Z');
    return Number.isNaN(date.getTime()) ? '' : DAY_NAMES[date.getUTCDay()];
}

/**
 * Escape text for safe embedding in an HTML table cell (used for Notes)
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Check whether a parsed hours table is the 5-col format (Date | Day | Hours | Notes | Total)
 * @param {Element} tableElement - DOM element containing the table
 * @returns {boolean}
 */
function isFiveColumnTable(tableElement) {
    const headers = Array.from(tableElement.querySelectorAll('th')).map(th => th.textContent.trim());
    return headers.includes('Day') && headers.includes('Notes');
}

/**
 * Check if HTML content contains an hours tracking table
 * @param {string} html - HTML string to check
 * @returns {boolean} - True if hours table found
 */
export function containsHoursTable(html) {
    if (!html) return false;
    return HOURS_TABLE_REGEX.test(html);
}

/**
 * Find the hours tracking comment among a list of comments
 * @param {Array} comments - Array of comment objects from ADO API (each has .text property)
 * @returns {{comment: Object, id: number}|null} - The hours comment and its ID, or null if not found
 */
export function findHoursComment(comments) {
    if (!comments || !Array.isArray(comments)) return null;

    for (const comment of comments) {
        if (comment.text && containsHoursTable(comment.text)) {
            return { comment, id: comment.id };
        }
    }
    return null;
}

/**
 * Remove the hours table from HTML content (for migration cleanup)
 * @param {string} html - HTML string potentially containing hours table
 * @returns {string} - HTML with hours table removed
 */
export function removeHoursTableFromHtml(html) {
    if (!html) return '';
    return html.replace(HOURS_TABLE_REGEX, '').trim();
}

/**
 * Parse hours from ADO work item HTML (description or comment)
 * @param {string} html - HTML content containing hours table
 * @param {string|number} taskId - Task ID for debug logging (optional)
 * @returns {Object} - Object keyed by date (YYYY-MM-DD) with hours values
 */
export function extractDailyHoursFromHtml(html, taskId) {
    const hoursByDate = {};

    if (!html) return hoursByDate;

    console.debug(LOG_PREFIX + `Task ${taskId} HTML length: ${html.length}`);
    console.debug(LOG_PREFIX + `Task ${taskId} HTML preview: ${html.substring(0, 200)}...`);

    const tableMatch = html.match(HOURS_TABLE_REGEX);
    console.debug(LOG_PREFIX + `Task ${taskId} table match found: ${!!tableMatch}`);

    if (tableMatch) {
        console.debug(LOG_PREFIX + `Task ${taskId} table HTML: ${tableMatch[0]}`);

        const tempElement = document.createElement('div');
        tempElement.innerHTML = tableMatch[0];

        // 5-col: Date | Day | Hours | Notes | Total — hours in cell 2; 3-col legacy: cell 1
        const hoursCellIndex = isFiveColumnTable(tempElement) ? 2 : 1;

        const rows = tempElement.querySelectorAll('tr');
        console.debug(LOG_PREFIX + `Task ${taskId} found ${rows.length} table rows`);

        rows.forEach((tableRow, rowIndex) => {
            if (rowIndex === 0) return; // Skip header row

            const tableCells = tableRow.querySelectorAll('td');
            console.debug(LOG_PREFIX + `Task ${taskId} row ${rowIndex} has ${tableCells.length} cells`);

            if (tableCells.length > hoursCellIndex) {
                const dateText = tableCells[0].textContent.trim();
                const hoursValue = parseFloat(tableCells[hoursCellIndex].textContent.trim()) || 0;

                console.debug(LOG_PREFIX + `Task ${taskId} row ${rowIndex}: date="${dateText}", hours=${hoursValue}`);

                // Extract just the YYYY-MM-DD portion from the date
                const dateMatch = dateText.match(/(\d{4}-\d{2}-\d{2})/);
                if (dateMatch && hoursValue > 0) {
                    hoursByDate[dateMatch[1]] = hoursValue;
                    console.debug(LOG_PREFIX + `Task ${taskId} added hours: ${dateMatch[1]} = ${hoursValue}`);
                }
            }
        });
    }

    console.debug(LOG_PREFIX + `Task ${taskId} final daily hours:`, hoursByDate);
    return hoursByDate;
}

/**
 * Build the 5-col hours table HTML (Date | Day | Hours | Notes | Total) for ADO comment.
 * Always emits the 5-col format; the date cell is normalized to pure YYYY-MM-DD (legacy
 * combined "2026-06-09 Mon" inputs are accepted — the day moves to its own column).
 * @param {Array} rowsData - Array of {date: string, hours: number, notes?: string} objects
 * @returns {{tableHtml: string, runningTotal: number}} - HTML table string and running total
 */
export function buildHoursTableHtml(rowsData) {
    let running = 0;
    let rows = "";

    rowsData.forEach(rowData => {
        const dateMatch = String(rowData.date).match(/\d{4}-\d{2}-\d{2}/);
        const date = dateMatch ? dateMatch[0] : String(rowData.date);
        running += rowData.hours;
        rows += `<tr><td style="border:1px solid;padding:.2em">${date}</td>` +
            `<td style="border:1px solid;padding:.2em;text-align: center;">${dayOfWeekShort(date)}</td>` +
            `<td style="border:1px solid;padding:.2em;text-align: center;">${rowData.hours.toFixed(1)}</td>` +
            `<td style="border:1px solid;padding:.2em">${escapeHtml(rowData.notes || '')}</td>` +
            `<td style="border:1px solid;padding:.2em;text-align: center;">${running.toFixed(1)}</td></tr>`;
    });

    const tableHtml = `<table style="border-collapse:collapse;">` +
        `<tr><th style="border:1px solid;padding:.2em;text-align: left;">Date</th>` +
        `<th style="border:1px solid;padding:.2em;text-align: center;">Day</th>` +
        `<th style="border:1px solid;padding:.2em;text-align: center;">Hours</th>` +
        `<th style="border:1px solid;padding:.2em;text-align: left;">Notes</th>` +
        `<th style="border:1px solid;padding:.2em;text-align: center;">Total</th></tr>` +
        `${rows}</table>`;

    return { tableHtml, runningTotal: running };
}

/**
 * Parse existing hours table rows from HTML (handles both 3-col and 5-col formats)
 * @param {string} html - HTML containing hours table
 * @returns {Array} - Array of {date: string, day: string, hours: number, notes: string};
 *   date is normalized to YYYY-MM-DD, day always populated (derived when absent)
 */
export function parseHoursTableRows(html) {
    const rowsData = [];

    if (!containsHoursTable(html)) return rowsData;

    const temp = document.createElement('div');
    temp.innerHTML = html.match(HOURS_TABLE_REGEX)[0];

    const fiveCol = isFiveColumnTable(temp);

    temp.querySelectorAll('tr').forEach((tr, idx) => {
        if (idx === 0) return; // Skip header
        const tds = tr.querySelectorAll('td');
        if (tds.length < 2) return;

        const dateMatch = tds[0].textContent.trim().match(/(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) return;
        const date = dateMatch[1];

        if (fiveCol && tds.length >= 5) {
            rowsData.push({
                date,
                day: tds[1].textContent.trim() || dayOfWeekShort(date),
                hours: parseFloat(tds[2].textContent.trim()) || 0,
                notes: tds[3].textContent.trim()
            });
        } else {
            // 3-col legacy: Date | Hours | Total (day may be embedded in the date cell)
            rowsData.push({
                date,
                day: dayOfWeekShort(date),
                hours: parseFloat(tds[1].textContent.trim()) || 0,
                notes: ''
            });
        }
    });

    return rowsData;
}
