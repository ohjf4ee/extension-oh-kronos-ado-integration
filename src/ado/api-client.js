// Azure DevOps API client for Kronos-ADO integration
// Encapsulates all ADO REST API calls

import { CONFIG } from '../config.js';
import * as storage from '../storage.js';
import { extractOrgName } from './utils.js';

/**
 * Create Basic auth headers for ADO API
 * @param {string} pat - Personal Access Token
 * @returns {Object} - Headers object with Authorization
 */
export function createAdoHeaders(pat) {
    return {
        Authorization: "Basic " + btoa(":" + pat)
    };
}

/**
 * ADO API Client class - encapsulates all Azure DevOps REST API operations
 */
export class AdoApiClient {
    constructor(orgUrl, logPrefix = "") {
        this.orgUrl = orgUrl;
        this.logPrefix = logPrefix;
        this.cachedTasks = null;
        this.taskDetailsCache = {};
        this._cachedCurrentUser = null;
    }

    /**
     * Get PAT from storage and create auth headers
     * @returns {Promise<{pat: string, headers: Object}|null>}
     */
    async _getAuthenticationHeaders() {
        const pat = await storage.loadEncrypted(CONFIG.STORAGE_KEYS.PAT);
        if (!this.orgUrl || !pat) return null;
        return { pat, headers: createAdoHeaders(pat) };
    }

    /**
     * Validate ADO connection by fetching project list
     * @param {string} pat - Personal Access Token
     * @returns {Promise<boolean>}
     */
    async validateConnection(pat) {
        try {
            const response = await fetch(`${this.orgUrl}/_apis/projects?api-version=7.0`, {
                headers: createAdoHeaders(pat)
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Load tasks assigned to current user from ADO
     * @param {boolean} forceRefresh - Force refresh even if cached
     * @param {Function} onError - Error callback (optional)
     * @returns {Promise<Array>}
     */
    async loadTasks(forceRefresh = false, onError = null) {
        if (this.cachedTasks && !forceRefresh) {
            return this.cachedTasks;
        }

        const auth = await this._getAuthenticationHeaders();
        if (!auth) {
            console.warn(this.logPrefix + "Missing orgUrl or PAT");
            return [];
        }

        try {
            const workItemQuery = `
                SELECT [System.Id],[System.Title],[System.TeamProject]
                FROM WorkItems
                WHERE [System.WorkItemType] = 'Task'
                AND [System.AssignedTo] = @Me
                AND [System.State] <> 'Done'
                AND [System.State] <> 'Removed'
                ORDER BY [System.ChangedDate] DESC`;

            const response = await fetch(`${this.orgUrl}/_apis/wit/wiql?api-version=7.0`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...auth.headers
                },
                body: JSON.stringify({ query: workItemQuery }),
            });

            const data = await response.json();
            if (!data.workItems?.length) return [];

            const ids = data.workItems.map((workItem) => workItem.id).slice(0, 50);
            const detailsResponse = await fetch(
                `${this.orgUrl}/_apis/wit/workitems?ids=${ids.join(',')}&$expand=relations&api-version=7.0`,
                { headers: auth.headers }
            );

            const detailsData = await detailsResponse.json();

            const parentIds = [];
            const taskInfo = detailsData.value.map((workItem) => {
                let parentId = null;
                const relation = workItem.relations?.find((rel) => rel.rel === "System.LinkTypes.Hierarchy-Reverse");
                if (relation) parentId = parseInt(relation.url.split('/').pop(), 10);
                if (parentId) parentIds.push(parentId);
                return {
                    id: workItem.id,
                    title: workItem.fields["System.Title"],
                    project: workItem.fields["System.TeamProject"],
                    priority: workItem.fields["Microsoft.VSTS.Common.Priority"],
                    backlogPriority: workItem.fields["Microsoft.VSTS.Common.BacklogPriority"],
                    parentId,
                };
            });

            let parentMap = {};
            if (parentIds.length) {
                const parentResponse = await fetch(
                    `${this.orgUrl}/_apis/wit/workitems?ids=${[...new Set(parentIds)].join(',')}&fields=System.Id,System.Title,System.TeamProject&api-version=7.0`,
                    { headers: auth.headers }
                );
                const parentData = await parentResponse.json();
                parentMap = Object.fromEntries(
                    parentData.value.map((parent) => [parent.id, { title: parent.fields["System.Title"], project: parent.fields["System.TeamProject"] }])
                );
            }

            this.cachedTasks = taskInfo.map((task) => ({
                id: task.id,
                title: task.title,
                project: parentMap[task.parentId]?.project || task.project,
                pbiTitle: parentMap[task.parentId]?.title || "(No PBI)",
                priority: task.priority,
                backlogPriority: task.backlogPriority,
            }));
            return this.cachedTasks;
        } catch (error) {
            console.error(this.logPrefix + "Failed to load ADO tasks:", error);
            if (onError) onError("Failed to load ADO tasks");
            return [];
        }
    }

    /**
     * Load detailed info for a specific task
     * @param {number|string} taskId - Task ID
     * @param {boolean} includeExtraFields - Include activity, assignedTo, description
     * @returns {Promise<Object|null>}
     */
    async loadTaskDetails(taskId, includeExtraFields = false) {
        const cached = this.taskDetailsCache[taskId];
        if (cached) {
            if (!includeExtraFields) {
                return cached;
            } else {
                if (cached.hasOwnProperty('activity') && cached.hasOwnProperty('assignedTo')) {
                    return cached;
                }
            }
        }

        const auth = await this._getAuthenticationHeaders();
        if (!auth || !taskId) return null;

        try {
            const detailResponse = await fetch(
                `${this.orgUrl}/_apis/wit/workitems?ids=${taskId}&$expand=relations&api-version=7.0`,
                { headers: auth.headers }
            );
            const detailData = await detailResponse.json();
            if (!detailData.value?.length) return null;
            const workItem = detailData.value[0];

            let parentProject = workItem.fields["System.TeamProject"];
            let parentTitle = "(No PBI)";
            const relation = workItem.relations?.find(rel => rel.rel === "System.LinkTypes.Hierarchy-Reverse");
            if (relation) {
                const parentId = parseInt(relation.url.split('/').pop(), 10);
                const parentResponse = await fetch(
                    `${this.orgUrl}/_apis/wit/workitems/${parentId}?fields=System.Title,System.TeamProject&api-version=7.0`,
                    { headers: auth.headers }
                );
                if (parentResponse.ok) {
                    const parentData = await parentResponse.json();
                    parentProject = parentData.fields["System.TeamProject"] || parentProject;
                    parentTitle = parentData.fields["System.Title"] || parentTitle;
                }
            }

            const info = {
                id: workItem.id,
                title: workItem.fields["System.Title"],
                project: parentProject,
                pbiTitle: parentTitle
            };

            if (includeExtraFields) {
                info.activity = workItem.fields["Custom.ODHActivity"] || workItem.fields["Microsoft.VSTS.Common.Activity"] || "";
                info.assignedTo = workItem.fields["System.AssignedTo"]?.displayName || "";
                info.description = workItem.fields["System.Description"] || "";
            }

            this.taskDetailsCache[taskId] = info;
            return info;
        } catch (error) {
            console.error(this.logPrefix + "Failed to load task", error);
            return null;
        }
    }

    /**
     * Load PBIs for a project
     * @param {string} projectName - Project name
     * @param {Object} authHeader - Auth headers
     * @param {Function} onError - Error callback
     * @returns {Promise<Array>}
     */
    async loadPbis(projectName, authHeader, onError = null) {
        const wiqlUrl = `${this.orgUrl}/${encodeURIComponent(projectName)}/_apis/wit/wiql?api-version=7.0`;
        const wiqlHeaders = { "Content-Type": "application/json", ...authHeader };

        async function executeWiqlQueryOrThrow(query) {
            const response = await fetch(wiqlUrl, {
                method: "POST",
                headers: wiqlHeaders,
                body: JSON.stringify({ query })
            });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new Error(`WIQL failed ${response.status} ${response.statusText}\n${body}`);
            }
            return response.json();
        }

        const fetchWorkItemDetailsOrThrow = async (ids, fields) => {
            const url = `${this.orgUrl}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields.join(",")}&api-version=7.0`;
            const response = await fetch(url, { headers: authHeader });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new Error(`Details fetch failed ${response.status} ${response.statusText}\n${body}`);
            }
            return response.json();
        };

        try {
            const baseWorkItemQuery = `
    SELECT [System.Id], [System.Title]
    FROM WorkItems
    WHERE [System.WorkItemType] IN ('Product Backlog Item', 'Bug')
    AND [System.ChangedDate] >= @Today - 180
    AND (
        [System.AssignedTo] = @Me
        OR [System.CreatedBy] = @Me
    )
    AND [System.State] <> 'Done'
    AND [System.State] <> 'Removed'
    ORDER BY [System.ChangedDate] DESC`;

            const linksWorkItemQuery = `
    SELECT [System.Id]
    FROM WorkItemLinks
    WHERE
        [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
        AND [Source].[System.WorkItemType] IN ('Product Backlog Item', 'Bug')
        AND [Source].[System.State] <> 'Done'
        AND [Source].[System.State] <> 'Removed'
        AND [Target].[System.WorkItemType] = 'Task'
        AND [Target].[System.AssignedTo] = @Me
        AND (
            (
                [Target].[System.State] <> 'Done'
                AND [Target].[System.State] <> 'Removed'
            )
            OR
            (
                [Target].[System.State] = 'Done'
                AND [Target].[System.ChangedDate] >= @Today - 6
            )
        )
    MODE (MustContain)`;

            const [baseData, linksData] = await Promise.all([
                executeWiqlQueryOrThrow(baseWorkItemQuery),
                executeWiqlQueryOrThrow(linksWorkItemQuery)
            ]);

            const baseIds = (baseData.workItems || []).map(workItem => workItem.id);
            const parentIdsFromTasks = new Set(
                (linksData.workItemRelations || [])
                    .map(relation => relation?.source?.id)
                    .filter(Boolean)
            );

            const allIds = Array.from(new Set([...baseIds, ...parentIdsFromTasks]));
            if (!allIds.length) return [];

            const idsToFetch = allIds.slice(0, 50);

            const detailData = await fetchWorkItemDetailsOrThrow(
                idsToFetch,
                [
                    "System.Id",
                    "System.Title",
                    "System.TeamProject",
                    "Microsoft.VSTS.Common.Priority",
                    "Microsoft.VSTS.Common.BacklogPriority"
                ]
            );

            return (detailData.value || [])
                .filter(workItem => workItem.fields["System.TeamProject"] === projectName)
                .map(workItem => ({
                    id: workItem.id,
                    title: workItem.fields["System.Title"],
                    project: workItem.fields["System.TeamProject"],
                    priority: workItem.fields["Microsoft.VSTS.Common.Priority"],
                    backlogPriority: workItem.fields["Microsoft.VSTS.Common.BacklogPriority"],
                }));

        } catch (error) {
            console.error(error);
            if (onError) onError(`Failed to load ADO PBIs: ${error.message || error}`);
            return [];
        }
    }

    /**
     * Load Activity options for a project (from Custom.ODHActivity field)
     * @param {string} projectName
     * @param {Object} authHeader
     * @param {Function} onError
     * @returns {Promise<Array<string>>}
     */
    async loadActivityOptions(projectName, authHeader, onError = null) {
        const fallback = [
            "Administration",
            "Code Review",
            "COVID Administration",
            "COVID Call Center",
            "COVID Enhancement",
            "COVID Testing",
            "Data Maintenance",
            "Development-Defect",
            "Development-Enhancement",
            "End User Support",
            "Infrastructure Change",
            "Paid Time Off",
            "Requirements",
            "Testing",
            "Training"
        ];
        try {
            const url = `${this.orgUrl}/${encodeURIComponent(projectName)}/_apis/wit/workitemtypes/Task?api-version=7.0`;
            console.debug(`${this.logPrefix}Fetching Activity values from`, url);
            let response = await fetch(url, { headers: authHeader });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`${this.logPrefix}HTTP ${response.status}: ${response.statusText}`, errorText);
            } else {
                const data = await response.json();
                console.debug(`${this.logPrefix}Work item type response:`, data);

                let field = data.fields?.find(fieldDef => fieldDef.referenceName === "Custom.ODHActivity");
                let allowedValues = field?.allowedValues || [];
                if (!allowedValues.length) {
                    console.warn(`${this.logPrefix}No allowedValues found in response`, data);
                }
                if (allowedValues.length) return allowedValues;
            }

            const alternateUrl = `${this.orgUrl}/_apis/wit/fields/Custom.ODHActivity?api-version=7.0`;
            console.debug(`${this.logPrefix}Attempting alternate field API`, alternateUrl);
            response = await fetch(alternateUrl, { headers: authHeader });
            if (response.ok) {
                const data = await response.json();
                console.debug(`${this.logPrefix}Field metadata response:`, data);
                const allowedValues = data.allowedValues || [];
                if (allowedValues.length) return allowedValues;
            }

            return fallback;
        } catch (error) {
            console.error(this.logPrefix + "Failed to load Activity values", error);
            if (onError) onError("Failed to load Activity values");
            return fallback;
        }
    }

    /**
     * Load Value Area options for a project
     * @param {string} projectName
     * @param {Object} authHeader
     * @param {Function} onError
     * @returns {Promise<Array<string>>}
     */
    async loadValueAreaOptions(projectName, authHeader, onError = null) {
        const fallback = ["Business", "Architectural"];
        try {
            const url = `${this.orgUrl}/${encodeURIComponent(projectName)}/_apis/wit/workitemtypes/Product%20Backlog%20Item?api-version=7.0`;
            console.debug(`${this.logPrefix}Fetching Value Area values from`, url);
            let response = await fetch(url, { headers: authHeader });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`${this.logPrefix}HTTP ${response.status}: ${response.statusText}`, errorText);
            } else {
                const data = await response.json();
                console.debug(`${this.logPrefix}Work item type response:`, data);
                let field = data.fields?.find(fieldDef => fieldDef.referenceName === "Microsoft.VSTS.Common.ValueArea");
                let allowedValues = field?.allowedValues || [];
                if (!allowedValues.length) {
                    console.warn(`${this.logPrefix}No allowedValues found in response`, data);
                }
                if (allowedValues.length) return allowedValues;
            }

            const alternateUrl = `${this.orgUrl}/_apis/wit/fields/Microsoft.VSTS.Common.ValueArea?api-version=7.0`;
            console.debug(`${this.logPrefix}Attempting alternate field API`, alternateUrl);
            response = await fetch(alternateUrl, { headers: authHeader });
            if (response.ok) {
                const data = await response.json();
                console.debug(`${this.logPrefix}Field metadata response:`, data);
                const allowedValues = data.allowedValues || [];
                if (allowedValues.length) return allowedValues;
            }

            return fallback;
        } catch (error) {
            console.error(this.logPrefix + "Failed to load Value Area values", error);
            if (onError) onError("Failed to load Value Area values");
            return fallback;
        }
    }

    /**
     * Create a new work item (PBI or Task)
     * @param {string} projectName
     * @param {string} type - Work item type (e.g., "Product Backlog Item", "Task")
     * @param {Array} operations - JSON Patch operations
     * @param {Object} authHeader
     * @returns {Promise<number>} - Created work item ID
     */
    async createWorkItem(projectName, type, operations, authHeader) {
        const response = await fetch(`${this.orgUrl}/${encodeURIComponent(projectName)}/_apis/wit/workitems/$${type}?api-version=7.0`, {
            method: "POST",
            headers: { "Content-Type": "application/json-patch+json", ...authHeader },
            body: JSON.stringify(operations)
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`Failed to create work item: ${response.status} ${response.statusText}\n${body}`);
        }
        const data = await response.json();
        return data.id;
    }

    /**
     * Delete a work item (soft delete to recycle bin)
     * @param {number} id - Work item ID
     * @param {Object} authHeader
     */
    async deleteWorkItem(id, authHeader) {
        if (!id) return;
        try {
            const response = await fetch(`${this.orgUrl}/_apis/wit/workitems/${id}?api-version=7.0`, {
                method: 'DELETE',
                headers: authHeader
            });
            if (!response.ok) {
                console.warn(`${this.logPrefix}Failed to delete work item ${id}`, await response.text());
            }
        } catch (error) {
            console.warn(`${this.logPrefix}Error deleting work item ${id}`, error);
        }
    }

    /**
     * Get the current authenticated user
     * @param {Object} authHeader
     * @returns {Promise<string>} - User account name
     */
    async getCurrentUser(authHeader) {
        if (this._cachedCurrentUser) return this._cachedCurrentUser;
        try {
            const orgName = extractOrgName(this.orgUrl);
            const response = await fetch(
                `https://vssps.dev.azure.com/${orgName}/_apis/connectionData?api-version=7.0-preview`,
                {
                    headers: {
                        ...authHeader,
                        Accept: "application/json"
                    }
                }
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            this._cachedCurrentUser = data.authorizedUser.properties.Account.$value;
            return this._cachedCurrentUser;
        } catch (error) {
            console.error(this.logPrefix + "Failed to fetch current user", error);
            return "";
        }
    }

    /**
     * Clear task caches (useful after creating new tasks)
     */
    clearCache() {
        this.cachedTasks = null;
        this.taskDetailsCache = {};
    }

    /**
     * Get all comments on a work item
     * @param {string} project - Project name
     * @param {number|string} workItemId - Work item ID
     * @returns {Promise<Array>} - Array of comment objects with id, text, etc.
     */
    async getWorkItemComments(project, workItemId) {
        const auth = await this._getAuthenticationHeaders();
        if (!auth || !workItemId) return [];

        try {
            const response = await fetch(
                `${this.orgUrl}/${encodeURIComponent(project)}/_apis/wit/workItems/${workItemId}/comments?api-version=7.0-preview.3`,
                { headers: auth.headers }
            );
            if (!response.ok) {
                console.error(`${this.logPrefix}Failed to fetch comments: ${response.status}`);
                return [];
            }
            const data = await response.json();
            return data.comments || [];
        } catch (error) {
            console.error(`${this.logPrefix}Error fetching comments:`, error);
            return [];
        }
    }

    /**
     * Add a new comment to a work item
     * @param {string} project - Project name
     * @param {number|string} workItemId - Work item ID
     * @param {string} text - Comment text (can include HTML)
     * @returns {Promise<Object|null>} - Created comment object or null on failure
     */
    async addWorkItemComment(project, workItemId, text) {
        const auth = await this._getAuthenticationHeaders();
        if (!auth || !workItemId) return null;

        try {
            const response = await fetch(
                `${this.orgUrl}/${encodeURIComponent(project)}/_apis/wit/workItems/${workItemId}/comments?api-version=7.0-preview.3`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...auth.headers
                    },
                    body: JSON.stringify({ text })
                }
            );
            if (!response.ok) {
                console.error(`${this.logPrefix}Failed to add comment: ${response.status}`);
                return null;
            }
            return await response.json();
        } catch (error) {
            console.error(`${this.logPrefix}Error adding comment:`, error);
            return null;
        }
    }

    /**
     * Update an existing comment on a work item
     * @param {string} project - Project name
     * @param {number|string} workItemId - Work item ID
     * @param {number} commentId - Comment ID to update
     * @param {string} text - New comment text (can include HTML)
     * @returns {Promise<Object|null>} - Updated comment object or null on failure
     */
    async updateWorkItemComment(project, workItemId, commentId, text) {
        const auth = await this._getAuthenticationHeaders();
        if (!auth || !workItemId || !commentId) return null;

        try {
            const response = await fetch(
                `${this.orgUrl}/${encodeURIComponent(project)}/_apis/wit/workItems/${workItemId}/comments/${commentId}?api-version=7.0-preview.3`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        ...auth.headers
                    },
                    body: JSON.stringify({ text })
                }
            );
            if (!response.ok) {
                console.error(`${this.logPrefix}Failed to update comment: ${response.status}`);
                return null;
            }
            return await response.json();
        } catch (error) {
            console.error(`${this.logPrefix}Error updating comment:`, error);
            return null;
        }
    }

    /**
     * Update work item fields
     * @param {string} project - Project name
     * @param {number|string} workItemId - Work item ID
     * @param {Array} operations - JSON Patch operations
     * @returns {Promise<Object|null>} - Updated work item or null on failure
     */
    async updateWorkItem(project, workItemId, operations) {
        const auth = await this._getAuthenticationHeaders();
        if (!auth || !workItemId) return null;

        try {
            const response = await fetch(
                `${this.orgUrl}/${encodeURIComponent(project)}/_apis/wit/workitems/${workItemId}?api-version=7.0`,
                {
                    method: "PATCH",
                    headers: {
                        "Content-Type": "application/json-patch+json",
                        ...auth.headers
                    },
                    body: JSON.stringify(operations)
                }
            );
            if (!response.ok) {
                console.error(`${this.logPrefix}Failed to update work item: ${response.status}`);
                return null;
            }
            return await response.json();
        } catch (error) {
            console.error(`${this.logPrefix}Error updating work item:`, error);
            return null;
        }
    }

    /**
     * Get child tasks of a work item (PBI/Bug) with their state and assignee info
     * @param {number|string} workItemId - Parent work item ID
     * @returns {Promise<Array>} - Array of {id, title, state, assignedTo} or empty array
     */
    async getChildTasks(workItemId) {
        const auth = await this._getAuthenticationHeaders();
        if (!auth || !workItemId) return [];

        try {
            // First get the work item with relations
            const response = await fetch(
                `${this.orgUrl}/_apis/wit/workitems/${workItemId}?$expand=relations&api-version=7.0`,
                { headers: auth.headers }
            );
            if (!response.ok) return [];
            const data = await response.json();

            // Find child task IDs (Hierarchy-Forward relations)
            const childIds = (data.relations || [])
                .filter(rel => rel.rel === "System.LinkTypes.Hierarchy-Forward")
                .map(rel => parseInt(rel.url.split('/').pop(), 10))
                .filter(id => !isNaN(id));

            if (childIds.length === 0) return [];

            // Fetch details for all child tasks
            const detailsResponse = await fetch(
                `${this.orgUrl}/_apis/wit/workitems?ids=${childIds.join(',')}&fields=System.Id,System.Title,System.State,System.AssignedTo,System.WorkItemType&api-version=7.0`,
                { headers: auth.headers }
            );
            if (!detailsResponse.ok) return [];
            const detailsData = await detailsResponse.json();

            return (detailsData.value || [])
                .filter(item => item.fields["System.WorkItemType"] === "Task")
                .map(item => ({
                    id: item.id,
                    title: item.fields["System.Title"],
                    state: item.fields["System.State"],
                    assignedTo: item.fields["System.AssignedTo"]?.displayName || null
                }));
        } catch (error) {
            console.error(`${this.logPrefix}Error fetching child tasks:`, error);
            return [];
        }
    }

    /**
     * Get work item description
     * @param {string} project - Project name
     * @param {number|string} workItemId - Work item ID
     * @returns {Promise<string>} - Description HTML or empty string
     */
    async getWorkItemDescription(project, workItemId) {
        const auth = await this._getAuthenticationHeaders();
        if (!auth || !workItemId) return "";

        try {
            const response = await fetch(
                `${this.orgUrl}/${encodeURIComponent(project)}/_apis/wit/workitems/${workItemId}?fields=System.Description&api-version=7.0`,
                { headers: auth.headers }
            );
            if (!response.ok) return "";
            const data = await response.json();
            return data.fields?.["System.Description"] || "";
        } catch (error) {
            console.error(`${this.logPrefix}Error fetching description:`, error);
            return "";
        }
    }

    /**
     * Find tasks with hours-tracking comments for recovery purposes.
     *
     * When local storage is cleared, this method searches ADO for tasks that have
     * hours-tracking comments (created by this extension) so the allocation data
     * can be reconstructed.
     *
     * Strategy:
     * 1. Query tasks assigned to current user that were changed recently
     * 2. For each task, fetch comments and check for hours tables
     * 3. Return tasks that have hours data in their comments
     *
     * @param {number} daysBack - How many days to search back (default 14 = one pay period)
     * @returns {Promise<Array<{taskId: number, project: string, commentText: string}>>}
     */
    async findRecentHoursComments(daysBack = 14) {
        const auth = await this._getAuthenticationHeaders();
        if (!auth) {
            console.warn(this.logPrefix + "Missing auth for findRecentHoursComments");
            return [];
        }

        try {
            // Query tasks assigned to me that were changed within the lookback period.
            // We include Done tasks because hours may have been logged before completion.
            const workItemQuery = `
                SELECT [System.Id], [System.Title], [System.TeamProject]
                FROM WorkItems
                WHERE [System.WorkItemType] = 'Task'
                AND [System.AssignedTo] = @Me
                AND [System.ChangedDate] >= @Today - ${daysBack}
                ORDER BY [System.ChangedDate] DESC`;

            const response = await fetch(`${this.orgUrl}/_apis/wit/wiql?api-version=7.0`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...auth.headers
                },
                body: JSON.stringify({ query: workItemQuery }),
            });

            if (!response.ok) {
                console.error(`${this.logPrefix}WIQL query failed: ${response.status}`);
                return [];
            }

            const data = await response.json();
            if (!data.workItems?.length) {
                console.debug(`${this.logPrefix}No tasks found in last ${daysBack} days`);
                return [];
            }

            // Limit to first 50 tasks to avoid excessive API calls
            const taskIds = data.workItems.map(wi => wi.id).slice(0, 50);
            console.debug(`${this.logPrefix}Found ${taskIds.length} tasks to check for hours comments`);

            // Fetch basic details for all tasks (we need project name for comment API)
            const detailsResponse = await fetch(
                `${this.orgUrl}/_apis/wit/workitems?ids=${taskIds.join(',')}&fields=System.Id,System.Title,System.TeamProject&api-version=7.0`,
                { headers: auth.headers }
            );

            if (!detailsResponse.ok) {
                console.error(`${this.logPrefix}Failed to fetch task details: ${detailsResponse.status}`);
                return [];
            }

            const detailsData = await detailsResponse.json();
            const taskMap = new Map(
                detailsData.value.map(wi => [wi.id, {
                    id: wi.id,
                    title: wi.fields["System.Title"],
                    project: wi.fields["System.TeamProject"]
                }])
            );

            // For each task, fetch comments and look for hours tables.
            // We import findHoursComment dynamically to avoid circular dependency issues.
            const { findHoursComment } = await import('./utils.js');

            const results = [];
            for (const taskId of taskIds) {
                const task = taskMap.get(taskId);
                if (!task) continue;

                const comments = await this.getWorkItemComments(task.project, taskId);
                const hoursComment = findHoursComment(comments);

                if (hoursComment) {
                    results.push({
                        taskId: task.id,
                        project: task.project,
                        commentText: hoursComment.comment.text
                    });
                }
            }

            console.debug(`${this.logPrefix}Found ${results.length} tasks with hours comments`);
            return results;

        } catch (error) {
            console.error(`${this.logPrefix}Error in findRecentHoursComments:`, error);
            return [];
        }
    }
}
