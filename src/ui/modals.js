// Modal UI components for Kronos-ADO integration
// Handles toast notifications and input dialogs

/**
 * Show an info toast notification
 * @param {string} message - Message to display
 * @param {Object} options - Optional context (date, taskId, taskTitle)
 */
export function showInfoStatus(message, options = {}) {
    const { date, taskId, taskTitle } = options;
    let displayMessage = message;

    if (date || taskId || taskTitle) {
        const parts = [];
        if (taskTitle) parts.push(`Task: ${taskTitle}`);
        else if (taskId) parts.push(`Task #${taskId}`);
        if (date) parts.push(`Date: ${date}`);
        displayMessage = `${message}\n${parts.join(' | ')}`;
    }

    Toastify({
        text: displayMessage,
        duration: 4000,
        close: true,
        gravity: "bottom",
        position: "right",
        stopOnFocus: true,
        style: {
            background: "#d2ffd2ff",
            color: "#000000"
        },
        onClick: function() {}
    }).showToast();
}

/**
 * Show an error toast notification
 * @param {string} message - Error message to display
 * @param {Function} retryCallback - Optional callback for retry action
 * @param {Object} options - Optional context (date, taskId, taskTitle)
 */
export function showErrorStatus(message, retryCallback = null, options = {}) {
    const { date, taskId, taskTitle } = options;
    let displayMessage = message;

    if (date || taskId || taskTitle) {
        const parts = [];
        if (taskTitle) parts.push(`Task: ${taskTitle}`);
        else if (taskId) parts.push(`Task #${taskId}`);
        if (date) parts.push(`Date: ${date}`);
        displayMessage = `${message}\n${parts.join(' | ')}`;
    }

    if (retryCallback) {
        displayMessage += "\n(Click to retry)";
    }

    const toast = Toastify({
        text: displayMessage,
        duration: -1, // Persistent - errors stay until dismissed
        close: true,
        gravity: "bottom",
        position: "right",
        stopOnFocus: true,
        style: {
            background: "#ffd2d8ff",
            color: "#000000"
        },
        onClick: function() {
            if (retryCallback) {
                toast.hideToast();
                retryCallback();
            }
        }
    }).showToast();
}

/**
 * Show a small sync notification
 * @param {string} message - Notification message
 * @param {string} type - 'success' or 'error'
 */
export function showSyncNotification(message, type) {
    const bgColor = type === 'success' ? '#d2ffd2ff' : '#ffd2d8ff';
    Toastify({
        text: message,
        duration: 2000,
        close: false,
        gravity: "bottom",
        position: "right",
        style: {
            background: bgColor,
            color: "#000000",
            fontSize: "12px",
            padding: "4px 8px"
        }
    }).showToast();
}

/**
 * Create a modal helper factory for task creation workflow
 * @param {Object} elements - DOM elements { addTaskStep, addTaskSelected, addTaskModal }
 * @param {Object} dependencies - Dependencies { adoApi, utils }
 * @returns {Object} - Modal helper functions
 */
export function createModalHelpers(elements, dependencies) {
    const { addTaskStep, addTaskSelected, addTaskModal } = elements;
    const { adoApi } = dependencies;

    // Helper to hide the filter info section during creation steps
    function hideFilterInfo() {
        const modalBody = addTaskModal.querySelector('.modal-body');
        const filterInfo = modalBody?.querySelector('.filter-info');
        if (filterInfo) {
            filterInfo.style.display = 'none';
        }
    }

    function cleanup(result) {
        addTaskModal.style.display = "none";
        addTaskStep.innerHTML = "";
        return result;
    }

    async function chooseWorkItemType(projectName) {
        return new Promise((resolve) => {
            hideFilterInfo();
            addTaskStep.innerHTML = "";
            addTaskSelected.innerHTML = `Project: ${projectName}`;
            const labelElement = document.createElement("div");
            labelElement.textContent = "What type of work item do you want to create?";
            labelElement.style.marginBottom = "12px";

            const buttonContainer = document.createElement("div");
            buttonContainer.style.display = "flex";
            buttonContainer.style.gap = "12px";
            buttonContainer.style.marginBottom = "16px";

            const pbiButton = document.createElement("button");
            pbiButton.textContent = "PBI (Product Backlog Item)";
            pbiButton.style.padding = "12px 24px";
            pbiButton.style.fontSize = "1em";
            pbiButton.onclick = () => resolve('PBI');

            const bugButton = document.createElement("button");
            bugButton.textContent = "Bug";
            bugButton.style.padding = "12px 24px";
            bugButton.style.fontSize = "1em";
            bugButton.onclick = () => resolve('Bug');

            buttonContainer.append(pbiButton, bugButton);

            const footerRow = document.createElement("div");
            footerRow.style.display = "flex";
            footerRow.style.justifyContent = "flex-end";
            footerRow.style.gap = "8px";
            footerRow.style.marginTop = "16px";

            const previousButton = document.createElement("button");
            previousButton.textContent = "Previous";
            previousButton.onclick = () => resolve({ prev: true });

            const cancelButton = document.createElement("button");
            cancelButton.textContent = "Cancel";
            cancelButton.onclick = () => resolve(null);

            footerRow.append(previousButton, cancelButton);
            addTaskStep.append(labelElement, buttonContainer, footerRow);
        });
    }

    async function getNewPbiTitle(projectName, workItemType = 'PBI') {
        return new Promise((resolve) => {
            hideFilterInfo();
            addTaskStep.innerHTML = "";
            addTaskSelected.innerHTML = `Project: ${projectName}`;
            const labelElement = document.createElement("div");
            labelElement.textContent = `New ${workItemType} Title:`;
            const titleInput = document.createElement("input");
            titleInput.type = "text";
            titleInput.style.width = "100%";
            titleInput.value = "";
            const buttonRow = document.createElement("div");
            buttonRow.style.display = "flex";
            buttonRow.style.justifyContent = "flex-end";
            buttonRow.style.gap = "8px";
            buttonRow.style.width = "100%";
            const previousButton = document.createElement("button");
            previousButton.textContent = "Previous";
            const nextButton = document.createElement("button");
            nextButton.textContent = "Next";
            const cancelButton = document.createElement("button");
            cancelButton.textContent = "Cancel";
            buttonRow.append(previousButton, nextButton, cancelButton);
            addTaskStep.append(labelElement, titleInput, buttonRow);
            previousButton.onclick = () => resolve({ prev: true });
            nextButton.onclick = () => resolve({ title: titleInput.value });
            cancelButton.onclick = () => resolve(null);
        });
    }

    async function chooseValueArea(projectName, pbiTitle, authHeader) {
        const allowedValues = await adoApi.loadValueAreaOptions(projectName, authHeader);
        return new Promise((resolve) => {
            hideFilterInfo();
            addTaskStep.innerHTML = "";
            addTaskSelected.innerHTML = `Project: ${projectName}<br/>PBI: ${pbiTitle}`;
            const labelElement = document.createElement("div");
            labelElement.textContent = "New PBI Value Area:";
            const container = document.createElement("div");
            container.style.marginTop = "8px";
            const nextButton = document.createElement("button");
            nextButton.textContent = "Next";
            if (allowedValues.length) {
                allowedValues.forEach((value, index) => {
                    const labelWrapper = document.createElement("label");
                    labelWrapper.style.display = "block";
                    const radioButton = document.createElement("input");
                    radioButton.type = "radio";
                    radioButton.name = "pbi-value";
                    radioButton.value = value;
                    if (index === 0) radioButton.checked = true;
                    labelWrapper.append(radioButton, document.createTextNode(" " + value));
                    labelWrapper.ondblclick = () => { radioButton.checked = true; nextButton.click(); };
                    container.appendChild(labelWrapper);
                });
            } else {
                const emptyMessage = document.createElement("div");
                emptyMessage.textContent = "No value areas";
                container.appendChild(emptyMessage);
            }
            const buttonRow = document.createElement("div");
            buttonRow.style.display = "flex";
            buttonRow.style.justifyContent = "flex-end";
            buttonRow.style.gap = "8px";
            buttonRow.style.width = "100%";
            const previousButton = document.createElement("button");
            previousButton.textContent = "Previous";
            const cancelButton = document.createElement("button");
            cancelButton.textContent = "Cancel";
            buttonRow.append(previousButton, nextButton, cancelButton);
            addTaskStep.append(labelElement, container, buttonRow);
            previousButton.onclick = () => resolve({ prev: true });
            nextButton.onclick = () => {
                const chosen = container.querySelector('input[name="pbi-value"]:checked');
                resolve(chosen ? chosen.value : "");
            };
            cancelButton.onclick = () => resolve(null);
        });
    }

    async function getTaskTitle(projectName, pbiLabel, initialTitle) {
        return new Promise((resolve) => {
            hideFilterInfo();
            addTaskStep.innerHTML = "";
            addTaskSelected.innerHTML = `Project: ${projectName}<br/>PBI: ${pbiLabel}`;
            const titleLabelElement = document.createElement("div");
            titleLabelElement.textContent = "New Task Title:";
            const titleInput = document.createElement("input");
            titleInput.type = "text";
            titleInput.style.width = "100%";
            titleInput.value = initialTitle || "";
            const buttonRow = document.createElement("div");
            buttonRow.style.display = "flex";
            buttonRow.style.justifyContent = "flex-end";
            buttonRow.style.gap = "8px";
            buttonRow.style.width = "100%";
            const previousButton = document.createElement("button");
            previousButton.textContent = "Previous";
            const nextButton = document.createElement("button");
            nextButton.textContent = "Next";
            const cancelButton = document.createElement("button");
            cancelButton.textContent = "Cancel";
            buttonRow.append(previousButton, nextButton, cancelButton);
            addTaskStep.append(titleLabelElement, titleInput, buttonRow);
            previousButton.onclick = () => resolve({ prev: true });
            nextButton.onclick = () => resolve({ title: titleInput.value });
            cancelButton.onclick = () => resolve(null);
        });
    }

    async function chooseActivity(projectName, authHeader) {
        const activityValues = await adoApi.loadActivityOptions(projectName, authHeader);
        return new Promise((resolve) => {
            hideFilterInfo();
            addTaskStep.innerHTML = "";
            const labelElement = document.createElement("div");
            labelElement.textContent = "New Task Activity:";
            const container = document.createElement("div");
            container.style.marginTop = "8px";
            const createButton = document.createElement("button");
            createButton.textContent = "Create Task";
            if (activityValues.length) {
                activityValues.forEach((value, index) => {
                    const labelWrapper = document.createElement("label");
                    labelWrapper.style.display = "block";
                    const radioButton = document.createElement("input");
                    radioButton.type = "radio";
                    radioButton.name = "task-activity";
                    radioButton.value = value;
                    if (index === 0) radioButton.checked = true;
                    labelWrapper.append(radioButton, document.createTextNode(" " + value));
                    labelWrapper.ondblclick = () => { radioButton.checked = true; createButton.click(); };
                    container.appendChild(labelWrapper);
                });
            } else {
                const emptyMessage = document.createElement("div");
                emptyMessage.textContent = "No activity values";
                container.appendChild(emptyMessage);
            }
            const buttonRow = document.createElement("div");
            buttonRow.style.display = "flex";
            buttonRow.style.justifyContent = "flex-end";
            buttonRow.style.gap = "8px";
            buttonRow.style.width = "100%";
            const previousButton = document.createElement("button");
            previousButton.textContent = "Previous";
            const cancelButton = document.createElement("button");
            cancelButton.textContent = "Cancel";
            buttonRow.append(previousButton, createButton, cancelButton);
            addTaskStep.append(labelElement, container, buttonRow);
            previousButton.onclick = () => resolve({ prev: true });
            createButton.onclick = () => {
                const chosen = container.querySelector('input[name="task-activity"]:checked');
                resolve(chosen ? chosen.value : "");
            };
            cancelButton.onclick = () => resolve(null);
        });
    }

    async function chooseProject(projects) {
        return new Promise((resolve) => {
            addTaskStep.innerHTML = "";
            const labelElement = document.createElement("div");
            labelElement.textContent = "Choose project:";
            const container = document.createElement("div");
            const nextButton = document.createElement("button");
            nextButton.textContent = "Next";
            projects.forEach((project, index) => {
                const labelWrapper = document.createElement("label");
                labelWrapper.style.display = "block";
                const radioButton = document.createElement("input");
                radioButton.type = "radio";
                radioButton.name = "proj-radio";
                radioButton.value = project.name;
                if (index === 0) radioButton.checked = true;
                labelWrapper.append(radioButton, document.createTextNode(" " + project.name));
                labelWrapper.ondblclick = () => {
                    radioButton.checked = true;
                    nextButton.click();
                };
                container.appendChild(labelWrapper);
            });
            const buttonRow = document.createElement("div");
            buttonRow.style.display = "flex";
            buttonRow.style.justifyContent = "flex-end";
            buttonRow.style.gap = "8px";
            buttonRow.style.width = "100%";
            const cancelButton = document.createElement("button");
            cancelButton.textContent = "Cancel";
            buttonRow.append(nextButton, cancelButton);
            addTaskStep.append(labelElement, container, buttonRow);
            nextButton.onclick = () => {
                const chosen = container.querySelector('input[name="proj-radio"]:checked');
                resolve(chosen ? chosen.value : null);
            };
            cancelButton.onclick = () => resolve(null);
        });
    }

    async function choosePbi(projectName, pbis) {
        return new Promise((resolve) => {
            addTaskStep.innerHTML = "";
            addTaskSelected.innerHTML = `Project: ${projectName}`;
            const labelElement = document.createElement("div");
            labelElement.textContent = "Choose PBI (or create new):";
            const container = document.createElement("div");
            container.style.maxHeight = "200px";
            container.style.overflowY = "auto";
            const nextButton = document.createElement("button");
            nextButton.textContent = "Next";

            // Add "Create new PBI" option first
            const newPbiLabel = document.createElement("label");
            newPbiLabel.style.display = "block";
            newPbiLabel.style.fontWeight = "bold";
            const newPbiRadio = document.createElement("input");
            newPbiRadio.type = "radio";
            newPbiRadio.name = "pbi-radio";
            newPbiRadio.value = "__new__";
            newPbiRadio.checked = true;
            newPbiLabel.append(newPbiRadio, document.createTextNode(" [Create New PBI]"));
            newPbiLabel.ondblclick = () => { newPbiRadio.checked = true; nextButton.click(); };
            container.appendChild(newPbiLabel);

            pbis.forEach((pbi) => {
                const labelWrapper = document.createElement("label");
                labelWrapper.style.display = "block";
                const radioButton = document.createElement("input");
                radioButton.type = "radio";
                radioButton.name = "pbi-radio";
                radioButton.value = pbi.id;
                labelWrapper.append(radioButton, document.createTextNode(` ${pbi.id}: ${pbi.title}`));
                labelWrapper.ondblclick = () => { radioButton.checked = true; nextButton.click(); };
                container.appendChild(labelWrapper);
            });

            const buttonRow = document.createElement("div");
            buttonRow.style.display = "flex";
            buttonRow.style.justifyContent = "flex-end";
            buttonRow.style.gap = "8px";
            buttonRow.style.width = "100%";
            const previousButton = document.createElement("button");
            previousButton.textContent = "Previous";
            const cancelButton = document.createElement("button");
            cancelButton.textContent = "Cancel";
            buttonRow.append(previousButton, nextButton, cancelButton);
            addTaskStep.append(labelElement, container, buttonRow);
            previousButton.onclick = () => resolve({ prev: true });
            nextButton.onclick = () => {
                const chosen = container.querySelector('input[name="pbi-radio"]:checked');
                if (!chosen) resolve(null);
                else if (chosen.value === "__new__") resolve({ createNew: true });
                else {
                    const pbi = pbis.find(matchingPbi => String(matchingPbi.id) === chosen.value);
                    resolve(pbi || null);
                }
            };
            cancelButton.onclick = () => resolve(null);
        });
    }

    return {
        cleanup,
        chooseWorkItemType,
        getNewPbiTitle,
        chooseValueArea,
        getTaskTitle,
        chooseActivity,
        chooseProject,
        choosePbi
    };
}
