// Copy Grid to Clipboard functionality for the Kronos-ADO integration extension
// This file contains functionality to copy the timecard grid to clipboard in email-friendly format

(function() {
const LOG_PREFIX = "\x1B[1mEXTENSION Kronos-ADO-integration[copy-grid.js]:\x1B[m ";
console.debug(LOG_PREFIX + "Loading...");

async function copyTimeGridToClipboard() {
    console.debug(LOG_PREFIX + "START copyTimeGridToClipboard()");

    try {
        const timeGrid = document.getElementById("time-grid");
        if (!timeGrid) {
            console.error(LOG_PREFIX + "Time grid not found");
            return;
        }

        const table = timeGrid.querySelector("table");
        if (!table) {
            console.error(LOG_PREFIX + "Table not found in time grid");
            return;
        }

        // Build the clipboard content as HTML table and plain text
        const { htmlContent, textContent } = buildClipboardContent(table);

        // Copy to clipboard with proper HTML MIME type
        try {
            // Try the modern ClipboardItem API with proper MIME types
            if (navigator.clipboard && window.ClipboardItem) {
                const clipboardItem = new ClipboardItem({
                    'text/html': new Blob([htmlContent], { type: 'text/html' }),
                    'text/plain': new Blob([textContent], { type: 'text/plain' })
                });
                await navigator.clipboard.write([clipboardItem]);
                console.debug(LOG_PREFIX + "Successfully copied with ClipboardItem API");
            } else {
                throw new Error("ClipboardItem not available");
            }
        } catch (clipboardError) {
            console.debug(LOG_PREFIX + "ClipboardItem API failed, trying alternative method:", clipboardError.message);

            // Alternative method: Use a hidden contenteditable div that can handle both HTML and text
            try {
                await copyWithContentEditable(htmlContent, textContent);
                console.debug(LOG_PREFIX + "Successfully copied with contenteditable method");
            } catch (fallbackError) {
                console.debug(LOG_PREFIX + "Contenteditable method failed, using plain text fallback");

                // Final fallback: just copy the text content
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(textContent);
                } else {
                    // Last resort: old execCommand method
                    const textarea = document.createElement('textarea');
                    textarea.value = textContent;
                    textarea.style.position = 'fixed';
                    textarea.style.left = '-9999px';
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textarea);
                }
            }
        }

        // Show success feedback
        showCopyFeedback(true);
        console.debug(LOG_PREFIX + "Grid copied to clipboard successfully");

    } catch (error) {
        console.error(LOG_PREFIX + "Error copying grid to clipboard:", error);
        showCopyFeedback(false);
    }
}

async function copyWithContentEditable(htmlContent, textContent) {
    return new Promise((resolve, reject) => {
        // Create a contenteditable div that can hold both HTML and text
        const containerDiv = document.createElement('div');
        containerDiv.contentEditable = true;
        containerDiv.innerHTML = htmlContent;

        // Style to make it invisible but accessible to selection
        containerDiv.style.position = 'fixed';
        containerDiv.style.left = '-9999px';
        containerDiv.style.top = '-9999px';
        containerDiv.style.width = '1px';
        containerDiv.style.height = '1px';
        containerDiv.style.opacity = '0';
        containerDiv.style.overflow = 'hidden';

        document.body.appendChild(containerDiv);

        try {
            // Select the content
            const range = document.createRange();
            range.selectNodeContents(containerDiv);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);

            // Copy using execCommand which should preserve HTML formatting
            const successful = document.execCommand('copy');

            if (successful) {
                resolve();
            } else {
                reject(new Error('execCommand copy returned false'));
            }
        } catch (error) {
            reject(error);
        } finally {
            // Clean up
            const selection = window.getSelection();
            selection.removeAllRanges();
            document.body.removeChild(containerDiv);
        }
    });
}

function buildClipboardContent(table) {
    console.debug(LOG_PREFIX + "Building clipboard content from table");

    // Build a simplified grid structure by extracting data directly from the DOM
    const data = extractGridData(table);

    let htmlContent = '<table border="1" style="border-collapse: collapse; font-family: sans-serif; font-size: 12px;">';
    let textContent = '';

    // Create header row with desired column order
    const headers = ['Date', 'Hours In Kronos', 'Hours Allocated', 'Task Hours', 'Project', 'PBI', '#', 'Task'];
    htmlContent += '<tr>';
    let textRow = '';
    for (const header of headers) {
        htmlContent += `<th style="border: 1px solid #ccc; padding: 4px; background-color: #f0f0f0; font-weight: bold;">${header}</th>`;
        textRow += header + '\t';
    }
    htmlContent += '</tr>';
    textContent += textRow.replace(/\t$/, '') + '\n';

    // Track totals for numeric columns
    let totalKronos = 0;
    let totalAllocated = 0;
    let totalTaskHours = 0;

    // Add data rows
    for (const dayData of data) {
        // Add to totals (only count each day once)
        const kronosHours = parseFloat(dayData.kronos || '0');
        const allocatedHours = parseFloat(dayData.allocated || '0');
        totalKronos += kronosHours;
        totalAllocated += allocatedHours;

        if (dayData.tasks.length === 0) {
            // Day with no tasks
            const row = [
                dayData.date,
                dayData.kronos || '0',
                dayData.allocated || '0',
                '', // Task Hours
                '', '', '', '' // Project, PBI, #, Task
            ];

            htmlContent += '<tr>';
            textRow = '';
            for (const [index, cellValue] of row.entries()) {
                const isNumeric = index === 1 || index === 2 || index === 3; // Hours columns
                const style = isNumeric ? 'text-align: center;' : '';
                htmlContent += `<td style="border: 1px solid #ccc; padding: 4px; ${style}">${cellValue}</td>`;
                textRow += cellValue + '\t';
            }
            htmlContent += '</tr>';
            textContent += textRow.replace(/\t$/, '') + '\n';
        } else {
            // Day with tasks - create one row per task
            for (const [taskIndex, task] of dayData.tasks.entries()) {
                htmlContent += '<tr>';
                textRow = '';

                // Add task hours to total
                const taskHoursNum = parseFloat(task.taskHours || '0');
                totalTaskHours += taskHoursNum;

                // Build each cell with proper formatting
                const cells = [
                    { value: taskIndex === 0 ? dayData.date : '', isNumeric: false },
                    { value: taskIndex === 0 ? (dayData.kronos || '0') : '', isNumeric: true },
                    { value: taskIndex === 0 ? (dayData.allocated || '0') : '', isNumeric: true },
                    { value: task.taskHours || '0', isNumeric: true },
                    { value: task.project || '', isNumeric: false },
                    { value: task.pbi || '', isNumeric: false },
                    { value: task.number || '', isNumeric: false, href: task.numberHref },
                    { value: task.title || '', isNumeric: false }
                ];

                for (const cell of cells) {
                    const style = cell.isNumeric ? 'text-align: center;' : '';
                    let cellContent = cell.value;

                    // Add hyperlink for task number if href is available
                    if (cell.href && cell.value) {
                        cellContent = `<a href="${cell.href}" target="_blank" style="color: #0066cc; text-decoration: none;">${cell.value}</a>`;
                    }

                    htmlContent += `<td style="border: 1px solid #ccc; padding: 4px; ${style}">${cellContent}</td>`;
                    textRow += cell.value + '\t';
                }

                htmlContent += '</tr>';
                textContent += textRow.replace(/\t$/, '') + '\n';
            }
        }
    }

    // Add totals row
    const totalRow = [
        'TOTALS',
        totalKronos.toFixed(1),
        totalAllocated.toFixed(1),
        totalTaskHours.toFixed(1),
        '', '', '', '' // Empty cells for Project, PBI, #, Task
    ];

    htmlContent += '<tr style="background-color: #e0e0e0; font-weight: bold; border-top: 2px solid #000;">';
    textRow = '';
    for (const [index, cellValue] of totalRow.entries()) {
        const isNumeric = index === 1 || index === 2 || index === 3; // Hours columns
        const style = isNumeric ? 'text-align: center; font-weight: bold;' : 'font-weight: bold;';
        htmlContent += `<td style="border: 1px solid #ccc; padding: 4px; ${style}">${cellValue}</td>`;
        textRow += cellValue + '\t';
    }
    htmlContent += '</tr>';
    textContent += textRow.replace(/\t$/, '') + '\n';

    htmlContent += '</table>';
    textContent = textContent.replace(/\n$/, ''); // Remove trailing newline

    console.debug(LOG_PREFIX + "Built clipboard content:", { htmlLength: htmlContent.length, textLength: textContent.length });

    return { htmlContent, textContent };
}

function extractGridData(table) {
    console.debug(LOG_PREFIX + "Extracting grid data from table");

    const data = [];
    const rows = Array.from(table.querySelectorAll("tr"));

    let currentDay = null;
    let dayTasks = [];

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) { // Skip header row
        const row = rows[rowIndex];
        const cells = Array.from(row.querySelectorAll("td"));

        if (cells.length === 0) continue;

        // Check if this is a new day row (has date cell)
        const dateCell = cells.find(cell => cell.classList.contains('dateCell') ||
                                         (cell.textContent && cell.textContent.match(/\w+ \d+\/\d+/)));

        if (dateCell) {
            // Save previous day if we have one
            if (currentDay) {
                data.push({
                    date: currentDay.date,
                    kronos: currentDay.kronos,
                    allocated: currentDay.allocated,
                    tasks: [...dayTasks]
                });
            }

            // Start new day
            const dateText = dateCell.textContent.trim();
            const kronosCell = cells.find(cell => {
                const text = cell.textContent.trim();
                return text && !isNaN(parseFloat(text)) && !cell.querySelector('input') && !cell.classList.contains('dateCell');
            });
            const allocatedCell = cells.find(cell => {
                const text = cell.textContent.trim();
                return text && !isNaN(parseFloat(text)) && cell !== kronosCell && !cell.querySelector('input') && !cell.classList.contains('dateCell');
            });

            currentDay = {
                date: dateText,
                kronos: kronosCell ? kronosCell.textContent.trim() : '0',
                allocated: allocatedCell ? allocatedCell.textContent.trim() : '0'
            };
            dayTasks = [];
        }

        // Extract task information from this row
        const taskInfo = extractTaskFromRow(row);
        if (taskInfo && (taskInfo.project || taskInfo.pbi || taskInfo.number || taskInfo.title)) {
            console.debug(LOG_PREFIX + "Extracted task info:", taskInfo);
            dayTasks.push(taskInfo);
        }
    }

    // Don't forget the last day
    if (currentDay) {
        data.push({
            date: currentDay.date,
            kronos: currentDay.kronos,
            allocated: currentDay.allocated,
            tasks: [...dayTasks]
        });
    }

    console.debug(LOG_PREFIX + "Extracted data:", data);
    return data;
}

function extractTaskFromRow(row) {
    const cells = Array.from(row.querySelectorAll("td"));

    let project = '';
    let pbi = '';
    let number = '';
    let numberHref = '';
    let title = '';
    let taskHours = '';

    // Get all task column cells
    const taskCells = cells.filter(cell => cell.classList.contains('taskCol'));

    // Find the hours input field
    const hoursInput = row.querySelector('input.hour-input, input[type="text"]');
    if (hoursInput) {
        taskHours = hoursInput.value || '0';
    }

    // The actual grid structure is: Project | PBI | Task (with link)
    // There is no separate task number column - the number is in the URL
    if (taskCells.length >= 3) {
        const [projCell, pbiCell, titleCell] = taskCells;

        // Extract project
        project = projCell.textContent.trim();

        // Extract PBI
        pbi = pbiCell.textContent.trim();

        // Extract title and task number from titleCell
        // The link contains the task URL with ID, and the link text is the title
        const link = titleCell.querySelector('a[href*="_workitems/edit"]');
        if (link) {
            title = link.textContent.trim();
            numberHref = link.href;
            // Extract task number from URL: .../edit/12345
            const urlMatch = numberHref.match(/_workitems\/edit\/(\d+)/);
            if (urlMatch) {
                number = urlMatch[1];
            }
        } else {
            title = titleCell.textContent.trim();
        }
    }

    return { project, pbi, number, numberHref, title, taskHours };
}

function showCopyFeedback(success) {
    const button = document.getElementById("copy-grid-btn");
    if (!button) return;

    const originalText = button.textContent;
    const originalTitle = button.title;

    if (success) {
        button.textContent = "Copied!";
        button.title = "Grid copied to clipboard";
        button.style.backgroundColor = "#4CAF50";
        button.style.color = "white";
    } else {
        button.textContent = "Failed";
        button.title = "Copy failed - check console";
        button.style.backgroundColor = "#f44336";
        button.style.color = "white";
    }

    // Reset after 2 seconds
    setTimeout(() => {
        button.textContent = originalText;
        button.title = originalTitle;
        button.style.backgroundColor = "";
        button.style.color = "";
    }, 2000);
}

async function copyPivotToClipboard() {
    console.debug(LOG_PREFIX + "START copyPivotToClipboard()");

    try {
        const timeGrid = document.getElementById("time-grid");
        if (!timeGrid) {
            console.error(LOG_PREFIX + "Time grid not found");
            return;
        }

        const table = timeGrid.querySelector("table");
        if (!table) {
            console.error(LOG_PREFIX + "Table not found in time grid");
            return;
        }

        // Build the pivoted clipboard content
        const { htmlContent, textContent } = buildPivotedClipboardContent(table);

        // Copy to clipboard using same method as regular copy
        try {
            // Try the modern ClipboardItem API with proper MIME types
            if (navigator.clipboard && window.ClipboardItem) {
                const clipboardItem = new ClipboardItem({
                    'text/html': new Blob([htmlContent], { type: 'text/html' }),
                    'text/plain': new Blob([textContent], { type: 'text/plain' })
                });
                await navigator.clipboard.write([clipboardItem]);
                console.debug(LOG_PREFIX + "Successfully copied pivot with ClipboardItem API");
            } else {
                throw new Error("ClipboardItem not available");
            }
        } catch (clipboardError) {
            console.debug(LOG_PREFIX + "ClipboardItem API failed, trying alternative method:", clipboardError.message);

            // Alternative method: Use a hidden contenteditable div
            try {
                await copyWithContentEditable(htmlContent, textContent);
                console.debug(LOG_PREFIX + "Successfully copied pivot with contenteditable method");
            } catch (fallbackError) {
                console.debug(LOG_PREFIX + "Contenteditable method failed, using plain text fallback");

                // Final fallback: just copy the text content
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(textContent);
                } else {
                    // Last resort: old execCommand method
                    const textarea = document.createElement('textarea');
                    textarea.value = textContent;
                    textarea.style.position = 'fixed';
                    textarea.style.left = '-9999px';
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textarea);
                }
            }
        }

        // Show success feedback
        showCopyPivotFeedback(true);
        console.debug(LOG_PREFIX + "Pivot copied to clipboard successfully");

    } catch (error) {
        console.error(LOG_PREFIX + "Error copying pivot to clipboard:", error);
        showCopyPivotFeedback(false);
    }
}

function buildPivotedClipboardContent(table) {
    console.debug(LOG_PREFIX + "Building pivoted clipboard content from table");

    // First get the regular grid data
    const data = extractGridData(table);

    let htmlContent = '<table border="1" style="border-collapse: collapse; font-family: sans-serif; font-size: 12px;">';
    let textContent = '';

    // Create header row - keep Date, Hours In Kronos, Hours Allocated, then add task-specific columns
    let headers = ['Date', 'Hours In Kronos', 'Hours Allocated'];
    let allTasks = [];

    // Collect all unique tasks to create columns
    for (const dayData of data) {
        for (const task of dayData.tasks) {
            if (task.title && !allTasks.find(existingTask => existingTask.number === task.number)) {
                allTasks.push(task);
            }
        }
    }

    // Add a column for each unique task (show project > PBI > task number > task title)
    for (const task of allTasks) {
        const projectPart = task.project || '';
        const pbiPart = task.pbi || '';
        const taskNumberLink = task.numberHref
            ? `<a href="${task.numberHref}" target="_blank" style="color: #0066cc; text-decoration: none;">${task.number}</a>`
            : task.number;
        const taskTitlePart = task.title || '';

        const taskLabel = `${projectPart} > ${pbiPart} > ${taskNumberLink} > ${taskTitlePart}`;
        headers.push(taskLabel);
    }

    // Build header row
    htmlContent += '<tr>';
    let textRow = '';
    for (const header of headers) {
        htmlContent += `<th style="border: 1px solid #ccc; padding: 4px; background-color: #f0f0f0; font-weight: bold;">${header}</th>`;
        textRow += header + '\t';
    }
    htmlContent += '</tr>';
    textContent += textRow.replace(/\t$/, '') + '\n';

    // Track totals
    let totalKronos = 0;
    let totalAllocated = 0;
    const taskTotals = {};

    // Add data rows - one row per day
    for (const dayData of data) {
        const kronosHours = parseFloat(dayData.kronos || '0');
        const allocatedHours = parseFloat(dayData.allocated || '0');
        totalKronos += kronosHours;
        totalAllocated += allocatedHours;

        htmlContent += '<tr>';
        textRow = '';

        // Date, Kronos, Allocated columns
        const basicCells = [
            { value: dayData.date, isNumeric: false },
            { value: dayData.kronos || '0', isNumeric: true },
            { value: dayData.allocated || '0', isNumeric: true }
        ];

        for (const cell of basicCells) {
            const style = cell.isNumeric ? 'text-align: center;' : '';
            htmlContent += `<td style="border: 1px solid #ccc; padding: 4px; ${style}">${cell.value}</td>`;
            textRow += cell.value + '\t';
        }

        // Task hours columns
        for (const task of allTasks) {
            const dayTask = dayData.tasks.find(matchingTask => matchingTask.number === task.number);
            const taskHours = dayTask ? (dayTask.taskHours || '0') : '0';
            const taskHoursNum = parseFloat(taskHours);

            if (!taskTotals[task.number]) {
                taskTotals[task.number] = 0;
            }
            taskTotals[task.number] += taskHoursNum;

            htmlContent += `<td style="border: 1px solid #ccc; padding: 4px; text-align: center;">${taskHours}</td>`;
            textRow += taskHours + '\t';
        }

        htmlContent += '</tr>';
        textContent += textRow.replace(/\t$/, '') + '\n';
    }

    // Add totals row
    htmlContent += '<tr style="background-color: #e0e0e0; font-weight: bold; border-top: 2px solid #000;">';
    textRow = '';

    // Basic totals
    const totalCells = [
        'TOTALS',
        totalKronos.toFixed(1),
        totalAllocated.toFixed(1)
    ];

    for (const cellValue of totalCells) {
        const style = cellValue === 'TOTALS' ? 'font-weight: bold;' : 'text-align: center; font-weight: bold;';
        htmlContent += `<td style="border: 1px solid #ccc; padding: 4px; ${style}">${cellValue}</td>`;
        textRow += cellValue + '\t';
    }

    // Task totals
    for (const task of allTasks) {
        const total = (taskTotals[task.number] || 0).toFixed(1);
        htmlContent += `<td style="border: 1px solid #ccc; padding: 4px; text-align: center; font-weight: bold;">${total}</td>`;
        textRow += total + '\t';
    }

    htmlContent += '</tr>';
    textContent += textRow.replace(/\t$/, '') + '\n';

    htmlContent += '</table>';
    textContent = textContent.replace(/\n$/, ''); // Remove trailing newline

    console.debug(LOG_PREFIX + "Built pivoted clipboard content:", { htmlLength: htmlContent.length, textLength: textContent.length });

    return { htmlContent, textContent };
}

function showCopyPivotFeedback(success) {
    const button = document.getElementById("copy-pivot-btn");
    if (!button) return;

    const originalText = button.textContent;
    const originalTitle = button.title;

    if (success) {
        button.textContent = "Copied!";
        button.title = "Pivot copied to clipboard";
        button.style.backgroundColor = "#4CAF50";
        button.style.color = "white";
    } else {
        button.textContent = "Failed";
        button.title = "Copy failed - check console";
        button.style.backgroundColor = "#f44336";
        button.style.color = "white";
    }

    // Reset after 2 seconds
    setTimeout(() => {
        button.textContent = originalText;
        button.title = originalTitle;
        button.style.backgroundColor = "";
        button.style.color = "";
    }, 2000);
}

// Export functions that need to be accessible from the main file
window.copyGridFunctions = {
    copyTimeGridToClipboard,
    copyPivotToClipboard
};
})();