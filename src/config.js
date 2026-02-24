// Configuration constants for Kronos-ADO integration
// This file centralizes all magic strings and config values

export const CONFIG = {
    STORAGE_KEYS: {
        ORG_URL: 'adoOrgUrl',
        PAT: 'adoPAT',
        ORG_URL_RAW: 'adoOrgUrlInputRaw',
        HOURS_BY_DAY: 'kronos_hoursByDay',
        ALLOCATIONS_BY_DAY: 'kronos_allocationsByDay',
        TASK_TREE_STATE: 'kronos_taskTreeState'
    },
    API_VERSION: '7.0',
    // May 18, 2025 - first Sunday of a pay period (used for payroll period calculations)
    PAYROLL_FIRST_DAY: new Date(2025, 4, 18),
    // Note added to hours tracking comment (warns users not to edit)
    HOURS_COMMENT_NOTE: 'Do not manually edit this comment that is for relating hours in Kronos to task "Completed Work".'
};
