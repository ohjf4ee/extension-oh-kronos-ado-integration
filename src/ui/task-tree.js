// Task tree UI component for Kronos-ADO integration
// Handles project/PBI/task hierarchy display and selection

/**
 * Create a task tree selector factory
 * @param {Object} dependencies - Dependencies
 * @param {string} dependencies.orgUrl - ADO organization URL
 * @param {Object} dependencies.storage - Storage module
 * @param {Object} dependencies.CONFIG - Configuration constants
 * @param {Object} dependencies.adoApi - ADO API client
 * @param {Function} dependencies.showErrorStatus - Error toast function
 * @param {Function} dependencies.createAdoHeaders - Auth header creator
 * @param {Object} dependencies.modalHelpers - Modal helper functions
 * @param {string} dependencies.LOG_PREFIX - Logging prefix
 * @param {Object} dependencies.modalElements - DOM elements { addTaskModal, addTaskSelected, addTaskStep }
 * @returns {Function} - selectTaskViaTree(date) function
 */
export function createTaskTreeSelector(dependencies) {
    const {
        orgUrl,
        storage,
        CONFIG,
        adoApi,
        showErrorStatus,
        createAdoHeaders,
        modalHelpers,
        LOG_PREFIX,
        modalElements
    } = dependencies;

    const { addTaskModal, addTaskSelected, addTaskStep } = modalElements;

    async function selectTaskViaTree(date) {
        const pat = await storage.loadEncrypted(CONFIG.STORAGE_KEYS.PAT);
        if (!orgUrl || !pat) {
            showErrorStatus("Please configure your ADO org URL and PAT first.");
            return null;
        }
        const authHeader = createAdoHeaders(pat);

        // Get tasks already added to this day to grey them out
        const allocations = (await storage.loadLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY)) || {};
        const dayAllocations = allocations[date] || [];
        const taskIdsAlreadyOnDay = new Set(dayAllocations.filter(allocation => allocation.confirmed).map(allocation => String(allocation.taskId)));

        // Modal elements
        addTaskModal.style.display = "flex";
        addTaskSelected.textContent = "";
        addTaskStep.innerHTML = "";
        // Add an X close button on the title bar (idempotent)
        const titleBar = addTaskModal.querySelector('.modal-title');
        if (titleBar && !titleBar.querySelector('.close-modal-x')) {
            const closeButton = document.createElement('button');
            closeButton.className = 'close-modal-x';
            closeButton.textContent = 'X';
            closeButton.style.float = 'right';
            closeButton.style.background = 'transparent';
            closeButton.style.border = 'none';
            closeButton.style.color = '#fff';
            closeButton.style.fontWeight = 'bold';
            closeButton.style.cursor = 'pointer';
            closeButton.title = 'Close';
            titleBar.appendChild(closeButton);
            closeButton.onclick = () => closeModal(null);
        }

        // Update modal title with date information
        if (titleBar) {
            const dateObj = new Date(date + 'T00:00:00');
            const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
            const monthDay = `${dateObj.getMonth() + 1}/${dateObj.getDate()}`;
            // Clear existing content first
            const existingX = titleBar.querySelector('.close-modal-x');
            titleBar.textContent = `Add New Task to Day (${dayOfWeek}, ${monthDay})`;
            if (existingX) titleBar.appendChild(existingX);
        }

        // Add filter criteria info section at the top of modal body (persists across steps)
        const modalBody = addTaskModal.querySelector('.modal-body');
        let filterInfo = modalBody.querySelector('.filter-info');
        if (!filterInfo) {
            filterInfo = document.createElement('div');
            filterInfo.className = 'filter-info';
            filterInfo.style.cssText = 'background: #f0f8ff; border: 1px solid #b0d4f1; border-radius: 4px; padding: 10px; margin-bottom: 16px; font-size: 0.85em; color: #333;';
            filterInfo.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 6px; color: #16488A;">The work items shown below are:</div>
                <div style="margin-left: 12px;">
                    <div style="margin-bottom: 4px;"><strong>PBIs and Bugs</strong> that are:</div>
                    <ul style="margin: 4px 0 8px 20px; padding: 0;">
                        <li>Changed in the last 180 days</li>
                        <li>Assigned to you or created by you</li>
                        <li>State is not Done or Removed</li>
                    </ul>
                    <div style="margin-bottom: 4px;"><strong>OR</strong> have a <strong>Task</strong> that is:</div>
                    <ul style="margin: 4px 0 0 20px; padding: 0;">
                        <li>Assigned to you</li>
                        <li>State is not Done or Removed, or was changed to Done or Removed within the past 6 days</li>
                    </ul>
                </div>
            `;
            modalBody.insertBefore(filterInfo, modalBody.firstChild);
        }

        // Load persisted expand/collapse state
        let treeState = (await storage.loadLocal(CONFIG.STORAGE_KEYS.TASK_TREE_STATE)) || { projects: {} };
        const getProjState = (name) => treeState.projects?.[name] || { expanded: false, pbis: {} };
        const isProjectExpanded = (name) => !!getProjState(name).expanded;
        const isPbiExpanded = (name, pbiId) => !!getProjState(name).pbis?.[pbiId];
        const setProjectExpanded = async (name, expanded) => {
            treeState.projects = treeState.projects || {};
            treeState.projects[name] = treeState.projects[name] || { expanded: false, pbis: {} };
            treeState.projects[name].expanded = !!expanded;
            await storage.saveLocal(CONFIG.STORAGE_KEYS.TASK_TREE_STATE, treeState);
        };
        const setPbiExpanded = async (name, pbiId, expanded) => {
            treeState.projects = treeState.projects || {};
            treeState.projects[name] = treeState.projects[name] || { expanded: false, pbis: {} };
            treeState.projects[name].pbis = treeState.projects[name].pbis || {};
            treeState.projects[name].pbis[pbiId] = !!expanded;
            await storage.saveLocal(CONFIG.STORAGE_KEYS.TASK_TREE_STATE, treeState);
        };

        // Build tree container
        const container = document.createElement("div");
        // Make the layout vertical and let the tree take remaining space between title and buttons
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.gap = "8px";
        container.style.minHeight = "60vh";

        // No bottom controls; selection or creation resolves immediately; close via title bar X

        const tree = document.createElement("div");
        tree.setAttribute("role", "tree");
        tree.style.border = "none"; // Remove border as requested
        tree.style.padding = "8px";
        tree.style.margin = "8px 0";
        // Let the tree grow and scroll to fill remaining space
        tree.style.flex = "1 1 auto";
        tree.style.minHeight = "300px";
        tree.style.overflow = "auto";

        addTaskStep.append(container);
        container.append(tree);

        let resolveModal;
        const modalPromise = new Promise(resolve => { resolveModal = resolve; });

        function closeModal(result) {
            addTaskModal.style.display = "none";
            addTaskStep.innerHTML = "";
            if (resolveModal) resolveModal(result);
            return result;
        }
        // Helper to resolve selection instantly
        function selectTask(id) {
            closeModal(id);
        }

        // Helper to mark a work item as Done with confirmation/validation
        async function handleMarkAsDone(workItemId, title, workItemType, projectName) {
            const currentUser = await adoApi.getCurrentUser(authHeader);

            // For PBIs/Bugs, check for open child tasks assigned to others
            if (workItemType === 'PBI' || workItemType === 'Bug') {
                const childTasks = await adoApi.getChildTasks(workItemId);
                const openTasksAssignedToOthers = childTasks.filter(task => {
                    const isOpen = task.state !== 'Done' && task.state !== 'Removed';
                    const isAssignedToOther = task.assignedTo && task.assignedTo !== currentUser;
                    return isOpen && isAssignedToOther;
                });

                if (openTasksAssignedToOthers.length > 0) {
                    // Show blocking message
                    const taskList = openTasksAssignedToOthers
                        .map(task => `• Task #${task.id} "${task.title}" (${task.assignedTo})`)
                        .join('\n');
                    alert(`Cannot change to Done.\n\nThis ${workItemType} has open tasks assigned to others:\n\n${taskList}`);
                    return;
                }
            }

            // Show confirmation dialog
            const confirmed = confirm(`Change ${workItemType} #${workItemId} "${title}" to Done?`);
            if (!confirmed) return;

            // Update the work item state to Done
            const result = await adoApi.updateWorkItem(projectName, workItemId, [
                { op: "add", path: "/fields/System.State", value: "Done" }
            ]);

            if (result) {
                // Refresh the tree to reflect the change
                await renderAllProjects();
            } else {
                alert(`Failed to change ${workItemType} #${workItemId} to Done. Please try again.`);
            }
        }

        // Utility: CSS chevrons (right/down) built with borders for universal rendering
        function setChevron(element, expanded, hasChildren = true) {
            element.style.width = '0';
            element.style.height = '0';
            element.style.display = 'inline-block';
            element.style.marginRight = '6px';
            element.style.borderStyle = 'solid';

            const color = hasChildren ? '#333' : '#999'; // Grey for no children

            if (expanded) {
                // down triangle
                element.style.borderWidth = '6px 6px 0 6px';
                element.style.borderColor = `${color} transparent transparent transparent`;
            } else {
                // right triangle
                element.style.borderWidth = '6px 0 6px 6px';
                element.style.borderColor = `transparent transparent transparent ${color}`;
            }
        }

        // Helper: render PBI nodes into a container
        // Extracted to allow lazy loading of PBIs
        function renderPbiNodes(pbis, pbiList, project) {
            for (const pbi of pbis) {
                const pbiWrapper = document.createElement("div");
                const pbiHeaderElement = document.createElement("div");
                pbiHeaderElement.setAttribute("role", "treeitem");
                pbiHeaderElement.setAttribute("aria-level", "2");
                pbiHeaderElement.style.display = "flex";
                pbiHeaderElement.style.alignItems = "center";
                pbiHeaderElement.style.justifyContent = "space-between";
                pbiHeaderElement.style.margin = "4px 0";
                pbiHeaderElement.style.cursor = "pointer";

                const pbiLeftContent = document.createElement("div");
                pbiLeftContent.style.display = "flex";
                pbiLeftContent.style.alignItems = "center";

                const pbiExpandIcon = document.createElement("span");
                pbiExpandIcon.style.display = 'inline-block';
                pbiExpandIcon.style.width = '12px';
                pbiExpandIcon.style.marginRight = '8px';

                const pbiTitleElement = document.createElement("span");
                const pbiIdHyperlink = document.createElement("a");
                pbiIdHyperlink.href = `${orgUrl}/_workitems/edit/${pbi.id}`;
                pbiIdHyperlink.target = "_blank";
                pbiIdHyperlink.textContent = `${pbi.id}`;
                const pbiTextAfter = document.createTextNode(` > ${pbi.title}`);
                pbiTitleElement.append(pbiIdHyperlink, pbiTextAfter);

                const pbiTaskCount = document.createElement("span");
                pbiTaskCount.textContent = " (...)";
                pbiTaskCount.style.color = "#555";
                pbiTaskCount.style.marginLeft = "8px";

                const createTaskButton = document.createElement("a");
                createTaskButton.textContent = "+";
                createTaskButton.title = "Create New Task";
                createTaskButton.style.cursor = "pointer";
                createTaskButton.style.fontSize = "1.2em";
                createTaskButton.style.fontWeight = "bold";
                createTaskButton.style.color = "#007acc";
                createTaskButton.style.textDecoration = "none";
                createTaskButton.style.marginLeft = "8px";

                pbiLeftContent.append(pbiExpandIcon, pbiTitleElement, pbiTaskCount, createTaskButton);

                const pbiButtonContainer = document.createElement("div");
                pbiButtonContainer.style.display = "flex";
                pbiButtonContainer.style.gap = "4px";
                pbiButtonContainer.style.flexShrink = "0";

                const pbiDoneButton = document.createElement("button");
                pbiDoneButton.textContent = "Done?";
                pbiDoneButton.style.fontSize = "0.85em";
                pbiDoneButton.onclick = async (event) => {
                    event.stopPropagation();
                    await handleMarkAsDone(pbi.id, pbi.title, 'PBI', project.name);
                };

                pbiButtonContainer.append(pbiDoneButton);
                pbiHeaderElement.append(pbiLeftContent, pbiButtonContainer);
                pbiWrapper.appendChild(pbiHeaderElement);

                const taskList = document.createElement("div");
                taskList.setAttribute("role", "group");
                taskList.style.marginLeft = "48px";
                taskList.style.display = "none";

                async function ensureTasksRendered() {
                    if (taskList.dataset.loaded === '1') return;
                    const allTasks = (await adoApi.loadTasks(false, showErrorStatus)).filter(task => task.project === project.name && task.parentId === pbi.id);
                    const tasks = allTasks.length ? allTasks : (await adoApi.loadTasks(false, showErrorStatus)).filter(task => task.project === project.name && task.pbiTitle === pbi.title);
                    const taskSortKey = (task) => ({
                        priority: Number(task.priority ?? Infinity),
                        backlog: Number(task.backlogPriority ?? Infinity),
                        title: task.title || ''
                    });
                    tasks.sort((taskA, taskB) => {
                        const sortKeyA = taskSortKey(taskA), sortKeyB = taskSortKey(taskB);
                        if (sortKeyA.priority !== sortKeyB.priority) return sortKeyA.priority - sortKeyB.priority;
                        if (sortKeyA.backlog !== sortKeyB.backlog) return sortKeyA.backlog - sortKeyB.backlog;
                        return sortKeyA.title.localeCompare(sortKeyB.title);
                    });
                    pbiTaskCount.textContent = ` (${tasks.length})`;
                    tasks.forEach(task => {
                        const taskListItem = document.createElement("div");
                        taskListItem.setAttribute("role", "treeitem");
                        taskListItem.setAttribute("aria-level", "3");
                        taskListItem.style.display = "flex";
                        taskListItem.style.alignItems = "center";
                        taskListItem.style.justifyContent = "space-between";
                        taskListItem.style.padding = "2px 0";

                        const alreadyAddedToDay = taskIdsAlreadyOnDay.has(String(task.id));

                        const taskLeftContent = document.createElement("div");
                        if (alreadyAddedToDay) {
                            taskLeftContent.style.opacity = "0.5";
                            taskLeftContent.title = "This task is already added to this day";
                        }
                        const taskIdLink = document.createElement("a");
                        taskIdLink.href = `${orgUrl}/_workitems/edit/${task.id}`;
                        taskIdLink.target = "_blank";
                        taskIdLink.textContent = `${task.id}`;
                        const taskTitleText = document.createTextNode(` > ${task.title}`);
                        taskLeftContent.append(taskIdLink, taskTitleText);

                        const buttonContainer = document.createElement("div");
                        buttonContainer.style.display = "flex";
                        buttonContainer.style.gap = "4px";

                        const addButton = document.createElement("button");
                        addButton.textContent = "Add";
                        addButton.style.fontSize = "0.85em";
                        addButton.disabled = alreadyAddedToDay;
                        if (alreadyAddedToDay) {
                            addButton.title = "This task is already added to this day";
                        }
                        addButton.onclick = (event) => {
                            event.stopPropagation();
                            selectTask(task.id);
                        };

                        const doneButton = document.createElement("button");
                        doneButton.textContent = "Done?";
                        doneButton.style.fontSize = "0.85em";
                        doneButton.onclick = async (event) => {
                            event.stopPropagation();
                            await handleMarkAsDone(task.id, task.title, 'Task', project.name);
                        };

                        buttonContainer.append(addButton, doneButton);

                        taskListItem.onclick = (event) => {
                            if (alreadyAddedToDay || event.target === taskIdLink || event.target.tagName === 'BUTTON') return;
                            selectTask(task.id);
                        };
                        taskListItem.append(taskLeftContent, buttonContainer);
                        taskList.appendChild(taskListItem);
                    });
                    taskList.dataset.loaded = '1';
                }

                createTaskButton.onclick = async () => {
                    let step = 0;
                    let taskTitle = null;
                    let activity = null;

                    while (step >= 0) {
                        if (step === 0) {
                            taskTitle = await modalHelpers.getTaskTitle(project.name, `${pbi.id} > ${pbi.title}`, null);
                            if (!taskTitle) { await renderAllProjects(); return; }
                            if (taskTitle.prev) { await renderAllProjects(); return; }
                            step = 1;
                        } else if (step === 1) {
                            activity = await modalHelpers.chooseActivity(project.name, authHeader);
                            if (activity === null) { await renderAllProjects(); return; }
                            if (activity.prev) { step = 0; continue; }
                            step = 2;
                        } else {
                            break;
                        }
                    }

                    const assignTo = await adoApi.getCurrentUser(authHeader);
                    const taskId = await adoApi.createWorkItem(project.name, "Task", [
                        { op: "add", path: "/fields/System.Title", value: taskTitle.title },
                        { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 4 },
                        { op: "add", path: "/fields/Custom.ODHActivity", value: activity },
                        { op: "add", path: "/fields/System.AssignedTo", value: assignTo },
                        { op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${orgUrl}/_apis/wit/workItems/${pbi.id}` } }
                    ], authHeader);
                    await renderAllProjects();
                    selectTask(taskId);
                };

                pbiWrapper.appendChild(taskList);
                pbiList.appendChild(pbiWrapper);

                const initialPbiExpanded = isPbiExpanded(project.name, pbi.id);
                setChevron(pbiExpandIcon, false, true);
                taskList.style.display = initialPbiExpanded ? '' : 'none';
                if (initialPbiExpanded) {
                    ensureTasksRendered().then(() => {
                        const hasTasks = taskList.querySelector('[role="treeitem"]') !== null;
                        setChevron(pbiExpandIcon, hasTasks ? initialPbiExpanded : false, hasTasks);
                    });
                }

                pbiHeaderElement.onclick = async (event) => {
                    if (event.target.tagName === 'A') return;
                    const nowExpanded = taskList.style.display === 'none';
                    taskList.style.display = nowExpanded ? '' : 'none';
                    await setPbiExpanded(project.name, pbi.id, nowExpanded);
                    if (nowExpanded) {
                        await ensureTasksRendered();
                        const hasTasks = taskList.querySelector('[role="treeitem"]') !== null;
                        setChevron(pbiExpandIcon, hasTasks ? nowExpanded : false, hasTasks);
                    } else {
                        setChevron(pbiExpandIcon, false, true);
                    }
                };
            }
        }

        // Helper: render a single project node with its PBIs and Tasks (collapsible)
        // PBIs are lazy-loaded only when the project is expanded
        // Returns the rendered DOM element instead of appending directly to tree
        function renderProjectNode(project, isFirstProject = false, appendToTree = true) {
            const projectWrapper = document.createElement("div");
            const projectHeader = document.createElement("div");
            projectHeader.setAttribute("role", "treeitem");
            projectHeader.setAttribute("aria-level", "1");
            projectHeader.style.display = "flex";
            projectHeader.style.alignItems = "center";
            projectHeader.style.justifyContent = "space-between";
            projectHeader.style.fontWeight = "bold";
            projectHeader.style.marginTop = "6px";
            projectHeader.style.cursor = "pointer";

            const projectLeftContent = document.createElement("div");
            projectLeftContent.style.display = "flex";
            projectLeftContent.style.alignItems = "center";

            const projectExpandIcon = document.createElement("span");
            projectExpandIcon.style.display = 'inline-block';
            projectExpandIcon.style.width = '12px';
            projectExpandIcon.style.marginRight = '8px';

            const projectTitleLink = document.createElement("a");
            projectTitleLink.textContent = project.name;
            projectTitleLink.href = `${orgUrl}/${encodeURIComponent(project.name)}/_backlogs`;
            projectTitleLink.target = "_blank";
            projectTitleLink.style.textDecoration = "none";
            projectTitleLink.style.color = "inherit";
            projectTitleLink.onclick = (event) => event.stopPropagation(); // Prevent triggering expand/collapse

            const projectPbiCount = document.createElement("span");
            projectPbiCount.style.color = "#555";
            projectPbiCount.style.marginLeft = "8px";

            // Create New PBI/Bug (+ indicator) - inline after count
            const createWorkItemButton = document.createElement("a");
            createWorkItemButton.textContent = "+";
            createWorkItemButton.title = "Create New PBI or Bug";
            createWorkItemButton.style.cursor = "pointer";
            createWorkItemButton.style.fontSize = "1.2em";
            createWorkItemButton.style.fontWeight = "bold";
            createWorkItemButton.style.color = "#007acc";
            createWorkItemButton.style.textDecoration = "none";
            createWorkItemButton.style.marginLeft = "8px";

            // Add inline hint for the first project only
            const hintText = document.createElement("span");
            if (isFirstProject) {
                hintText.innerHTML = ' <span style="font-size: 1.2em; vertical-align: middle;">🡰</span> use "+" buttons to add a PBI, Bug, or Task';
                hintText.style.color = "#888";
                hintText.style.fontWeight = "normal";
                hintText.style.fontSize = "0.85em";
                hintText.style.marginLeft = "6px";
            }

            projectLeftContent.append(projectExpandIcon, projectTitleLink, projectPbiCount, createWorkItemButton, hintText);

            projectHeader.append(projectLeftContent);
            projectWrapper.appendChild(projectHeader);

            // PBI list container - starts empty, lazy-loaded on expand
            const pbiList = document.createElement("div");
            pbiList.style.marginLeft = "24px";
            pbiList.style.display = "none";

            // Track loading state
            let pbisLoaded = false;
            let pbisLoading = false;
            let loadError = false;
            let pbis = [];

            // Initialize chevron as collapsed
            setChevron(projectExpandIcon, false, true);

            // Lazy load PBIs when project is expanded
            async function ensurePbisLoaded() {
                if (pbisLoaded) return true;
                if (pbisLoading) return false; // Already loading, wait
                pbisLoading = true;
                loadError = false;

                // Show loading indicator
                projectPbiCount.textContent = " (loading...)";
                projectPbiCount.style.fontStyle = "italic";

                try {
                    let loadedPbis = await adoApi.loadPbis(project.name, authHeader, null);
                    loadedPbis = loadedPbis.filter(pbi => pbi.project === project.name);

                    // Sort PBIs
                    const pbiSortKey = (pbi) => ({
                        priority: Number(pbi.priority ?? Infinity),
                        backlog: Number(pbi.backlogPriority ?? Infinity),
                        title: pbi.title || ''
                    });
                    loadedPbis.sort((pbiA, pbiB) => {
                        const sortKeyA = pbiSortKey(pbiA), sortKeyB = pbiSortKey(pbiB);
                        if (sortKeyA.priority !== sortKeyB.priority) return sortKeyA.priority - sortKeyB.priority;
                        if (sortKeyA.backlog !== sortKeyB.backlog) return sortKeyA.backlog - sortKeyB.backlog;
                        return sortKeyA.title.localeCompare(sortKeyB.title);
                    });

                    pbis = loadedPbis;
                    pbisLoaded = true;
                    projectPbiCount.textContent = ` (${pbis.length})`;
                    projectPbiCount.style.fontStyle = "normal";
                    projectPbiCount.style.color = "#555";

                    // Render PBI nodes
                    pbiList.innerHTML = "";
                    renderPbiNodes(pbis, pbiList, project);

                    // Update chevron
                    const isExpanded = pbiList.style.display !== 'none';
                    setChevron(projectExpandIcon, pbis.length > 0 ? isExpanded : false, pbis.length > 0);
                    projectHeader.style.cursor = pbis.length > 0 ? 'pointer' : 'default';

                    return true;
                } catch (err) {
                    console.error(LOG_PREFIX + `Failed to load PBIs for ${project.name}:`, err);
                    loadError = true;
                    pbisLoading = false;
                    projectPbiCount.innerHTML = ` <span style="color: #c00; cursor: pointer;" title="Click to retry">(failed - retry?)</span>`;
                    projectPbiCount.style.fontStyle = "normal";

                    const retrySpan = projectPbiCount.querySelector('span');
                    if (retrySpan) {
                        retrySpan.onclick = async (event) => {
                            event.stopPropagation();
                            pbisLoading = false;
                            loadError = false;
                            const success = await ensurePbisLoaded();
                            if (success && pbiList.style.display === 'none') {
                                pbiList.style.display = '';
                                setChevron(projectExpandIcon, pbis.length > 0, pbis.length > 0);
                                await setProjectExpanded(project.name, true);
                            }
                        };
                    }
                    return false;
                } finally {
                    if (!loadError) pbisLoading = false;
                }
            }

            // Create New PBI/Bug flow with proper Previous button support
            createWorkItemButton.onclick = async () => {
                // Track wizard state to support Previous navigation
                let step = 0;
                let workItemType = null;
                let workItemTypeApiName = null;
                let workItemTypeDisplayName = null;
                let titleRes = null;
                let valueArea = null;
                let taskTitle = null;
                let activity = null;

                while (step >= 0) {
                    if (step === 0) {
                        // Step 0: Choose work item type
                        workItemType = await modalHelpers.chooseWorkItemType(project.name);
                        if (!workItemType) { await renderAllProjects(); return; } // user canceled
                        if (workItemType.prev) { await renderAllProjects(); return; } // go back to tree (first step)
                        workItemTypeApiName = workItemType === 'PBI' ? 'Product%20Backlog%20Item' : 'Bug';
                        workItemTypeDisplayName = workItemType === 'PBI' ? 'PBI' : 'Bug';
                        step = 1;
                    } else if (step === 1) {
                        // Step 1: Get PBI/Bug title
                        titleRes = await modalHelpers.getNewPbiTitle(project.name, workItemTypeDisplayName);
                        if (!titleRes) { await renderAllProjects(); return; } // user canceled
                        if (titleRes.prev) { step = 0; continue; } // go back to work item type
                        step = 2;
                    } else if (step === 2) {
                        // Step 2: Choose value area
                        valueArea = await modalHelpers.chooseValueArea(project.name, titleRes.title, authHeader);
                        if (valueArea === null) { await renderAllProjects(); return; } // user canceled
                        if (valueArea.prev) { step = 1; continue; } // go back to title
                        step = 3;
                    } else if (step === 3) {
                        // Step 3: Get task title
                        taskTitle = await modalHelpers.getTaskTitle(project.name, `(new) > ${titleRes.title}`, titleRes.title);
                        if (!taskTitle) { await renderAllProjects(); return; } // user canceled
                        if (taskTitle.prev) { step = 2; continue; } // go back to value area
                        step = 4;
                    } else if (step === 4) {
                        // Step 4: Choose activity
                        activity = await modalHelpers.chooseActivity(project.name, authHeader);
                        if (activity === null) { await renderAllProjects(); return; } // user canceled
                        if (activity.prev) { step = 3; continue; } // go back to task title
                        step = 5; // Done with wizard steps
                    } else {
                        break; // Exit the loop to proceed with creation
                    }
                }

                const assignTo = await adoApi.getCurrentUser(authHeader);
                if (!assignTo) { showErrorStatus("Failed to get current user"); return; }

                // Now create the PBI/Bug and then the Task
                let parentId = null;
                try {
                    parentId = await adoApi.createWorkItem(project.name, workItemTypeApiName, [
                        { op: "add", path: "/fields/System.Title", value: titleRes.title },
                        { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 4 },
                        { op: "add", path: "/fields/Microsoft.VSTS.Common.ValueArea", value: valueArea }
                    ], authHeader);
                } catch (err) {
                    console.error(LOG_PREFIX + `Failed to create ${workItemTypeDisplayName}`, err);
                    showErrorStatus(`Failed to create ${workItemTypeDisplayName}`);
                    return;
                }

                try {
                    const taskId = await adoApi.createWorkItem(project.name, "Task", [
                        { op: "add", path: "/fields/System.Title", value: taskTitle.title },
                        { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 4 },
                        { op: "add", path: "/fields/Custom.ODHActivity", value: activity },
                        { op: "add", path: "/fields/System.AssignedTo", value: assignTo },
                        { op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${orgUrl}/_apis/wit/workItems/${parentId}` } }
                    ], authHeader);
                    // Refresh tree to show newly created items
                    await renderAllProjects();
                    selectTask(taskId);
                } catch (err) {
                    console.error(LOG_PREFIX + `Failed to create Task after creating ${workItemTypeDisplayName}`, err);
                    showErrorStatus("Failed to create Task");
                    // Best-effort cleanup: delete the newly created parent since task creation did not complete
                    try {
                        await adoApi.deleteWorkItem(parentId, authHeader);
                    } catch (cleanupErr) {
                        console.warn(LOG_PREFIX + "Cleanup failed (delete parent)", cleanupErr);
                    }
                }
            };

            projectWrapper.appendChild(pbiList);
            if (appendToTree) {
                tree.appendChild(projectWrapper);
            }

            // Handle project expand/collapse with lazy loading
            projectHeader.onclick = async (event) => {
                if (event.target.tagName === 'A') return;

                const nowExpanded = pbiList.style.display === 'none';

                if (nowExpanded) {
                    // Expanding - load PBIs if not yet loaded
                    pbiList.style.display = '';
                    const success = await ensurePbisLoaded();
                    if (success) {
                        setChevron(projectExpandIcon, pbis.length > 0, pbis.length > 0);
                        await setProjectExpanded(project.name, true);
                    } else {
                        // Loading failed, collapse back
                        pbiList.style.display = 'none';
                        setChevron(projectExpandIcon, false, true);
                    }
                } else {
                    // Collapsing
                    pbiList.style.display = 'none';
                    setChevron(projectExpandIcon, false, pbisLoaded ? pbis.length > 0 : true);
                    await setProjectExpanded(project.name, false);
                }
            };

            // Check if this project should be auto-expanded (was expanded before)
            const shouldAutoExpand = isProjectExpanded(project.name);
            if (shouldAutoExpand) {
                // Trigger expansion asynchronously
                pbiList.style.display = '';
                ensurePbisLoaded().then(success => {
                    if (success) {
                        setChevron(projectExpandIcon, pbis.length > 0, pbis.length > 0);
                    } else {
                        pbiList.style.display = 'none';
                        setChevron(projectExpandIcon, false, true);
                    }
                });
            }

            return projectWrapper;
        }

        async function renderAllProjects() {
            // Clear any selection breadcrumb text
            addTaskSelected.textContent = "";
            // Show the filter info when returning to the tree view
            const modalBody = addTaskModal.querySelector('.modal-body');
            const filterInfo = modalBody?.querySelector('.filter-info');
            if (filterInfo) {
                filterInfo.style.display = '';
            }
            // Ensure container and tree are in the DOM (they may have been cleared by helper functions)
            if (!addTaskStep.contains(container)) {
                addTaskStep.innerHTML = "";
                addTaskStep.append(container);
                if (!container.contains(tree)) {
                    container.innerHTML = "";
                    container.append(tree);
                }
            }
            tree.innerHTML = "";
            const projectsRes = await fetch(`${orgUrl}/_apis/projects?api-version=7.0`, { headers: authHeader });
            const projectsData = await projectsRes.json();
            if (!projectsData.value?.length) return;

            // Sort projects alphabetically by name
            const sortedProjects = projectsData.value.sort((projectA, projectB) => projectA.name.localeCompare(projectB.name));

            // Render all project nodes immediately (PBIs are lazy-loaded on expand)
            sortedProjects.forEach((project, index) => {
                const projectNode = renderProjectNode(project, index === 0, false);
                tree.appendChild(projectNode);
            });
        }

        await renderAllProjects();

        // Promise resolves when a task is selected/created or the X is clicked
        return await modalPromise;
    }

    return selectTaskViaTree;
}
