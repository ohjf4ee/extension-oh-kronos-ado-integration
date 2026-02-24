// ADO module re-exports for clean imports
// Central entry point for all ADO-related functionality

export { AdoApiClient, createAdoHeaders } from './api-client.js';
export * as adoUtils from './utils.js';
export { updateTaskHours, syncAllocationsWithAdo, extractDailyHoursFromTask } from './hours-sync.js';
