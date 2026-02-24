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
 * Regex to match the hours tracking table by its structure (Date | Hours | Total headers)
 * Used to identify hours tables in both descriptions (legacy) and comments (new)
 */
export const HOURS_TABLE_REGEX = /<table[\s\S]*?>\s*<tr><th style="[\s\S]*?">Date<\/th><th style="[\s\S]*?">Hours<\/th><th style="[\s\S]*?">Total<\/th><\/tr>[\s\S]*?<\/table>/;

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

        const rows = tempElement.querySelectorAll('tr');
        console.debug(LOG_PREFIX + `Task ${taskId} found ${rows.length} table rows`);

        rows.forEach((tableRow, rowIndex) => {
            if (rowIndex === 0) return; // Skip header row

            const tableCells = tableRow.querySelectorAll('td');
            console.debug(LOG_PREFIX + `Task ${taskId} row ${rowIndex} has ${tableCells.length} cells`);

            if (tableCells.length >= 2) {
                const dateText = tableCells[0].textContent.trim();
                const hoursValue = parseFloat(tableCells[1].textContent.trim()) || 0;

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
 * Build hours table HTML for ADO comment/description
 * @param {Array} rowsData - Array of {date: string, hours: number} objects
 * @returns {{tableHtml: string, runningTotal: number}} - HTML table string and running total
 */
export function buildHoursTableHtml(rowsData) {
    let running = 0;
    let rows = "";

    rowsData.forEach(rowData => {
        running += rowData.hours;
        rows += `<tr><td style="border:1px solid;padding:.2em">${rowData.date}</td>` +
            `<td style="border:1px solid;padding:.2em;text-align: center;">${rowData.hours.toFixed(1)}</td>` +
            `<td style="border:1px solid;padding:.2em;text-align: center;">${running.toFixed(1)}</td></tr>`;
    });

    const tableHtml = `<table style="border-collapse:collapse;">` +
        `<tr><th style="border:1px solid;padding:.2em;text-align: left;">Date</th>` +
        `<th style="border:1px solid;padding:.2em;text-align: center;">Hours</th>` +
        `<th style="border:1px solid;padding:.2em;text-align: center;">Total</th></tr>` +
        `${rows}</table>`;

    return { tableHtml, runningTotal: running };
}

/**
 * Parse existing hours table rows from HTML
 * @param {string} html - HTML containing hours table
 * @returns {Array} - Array of {date: string, hours: number} objects
 */
export function parseHoursTableRows(html) {
    const rowsData = [];

    if (!containsHoursTable(html)) return rowsData;

    const temp = document.createElement('div');
    temp.innerHTML = html.match(HOURS_TABLE_REGEX)[0];

    temp.querySelectorAll('tr').forEach((tr, idx) => {
        if (idx === 0) return; // Skip header
        const tds = tr.querySelectorAll('td');
        if (tds.length >= 2) {
            rowsData.push({
                date: tds[0].textContent.trim(),
                hours: parseFloat(tds[1].textContent.trim()) || 0
            });
        }
    });

    return rowsData;
}
