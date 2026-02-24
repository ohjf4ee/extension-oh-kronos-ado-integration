# Privacy Policy

**Kronos-ADO Integration**
**Last Updated**: February 2026

## Overview

This browser extension integrates a Kronos timecard system with Azure DevOps for task time tracking. This privacy policy explains what data the extension collects, how it is stored, and how it is used.

## Data Collection

The extension collects and stores the following information locally in your browser:

| Data Type                     | Purpose                                      | Storage Location                  |
|-------------------------------|----------------------------------------------|-----------------------------------|
| Azure DevOps Organization URL | Connect to your ADO instance                 | Browser local storage             |
| Personal Access Token (PAT)   | Authenticate with Azure DevOps API           | Browser local storage (encrypted) |
| Timecard hours by day         | Track daily work hours from Kronos           | Browser local storage             |
| Task allocations              | Record hours allocated to specific ADO tasks | Browser local storage             |
| Task tree state               | Remember expanded/collapsed UI state         | Browser local storage             |

## Data Storage

- All data is stored **locally in your browser** using Chrome's `chrome.storage.local` API
- Your Personal Access Token is **encrypted** before storage using AES-256-GCM encryption
- No data is stored on external servers controlled by this extension
- Data persists until you clear it or uninstall the extension

## Data Transmission

- Your Personal Access Token is transmitted **only** to the Azure DevOps organization URL that you configure
- The extension communicates with Azure DevOps APIs to:
  - Validate your connection
  - Load your assigned tasks
  - Create, update, and query work items
  - Retrieve user information
- **No data is transmitted to any third parties**
- **No analytics or tracking services are used**

## Data Sharing

This extension does **not**:

- Share your data with third parties
- Sell or monetize your data
- Use analytics or telemetry services
- Track your browsing activity outside of the Kronos timecard page

## Data Retention

- Data is retained in your browser until you explicitly delete it
- Use the "Clear All Data" button in the extension settings to delete all stored information
- Uninstalling the extension will remove all stored data

## How to Delete Your Data

1. Open the extension sidebar on the Kronos timecard page
2. Click the settings/configuration icon
3. Click "Clear All Data"
4. Confirm the deletion

Alternatively, you can:

- Clear browser data for this extension through Chrome/Edge settings
- Uninstall the extension

## Security

- Personal Access Tokens are encrypted using industry-standard AES-256-GCM encryption
- The encryption key is derived using PBKDF2 with 100,000 iterations
- All communication with Azure DevOps uses HTTPS

## Permissions

The extension requires the following browser permissions:

| Permission | Why It's Needed                                   |
|------------|---------------------------------------------------|
| `storage`  | Store your settings and timecard data locally     |
| `tabs`     | Open Azure DevOps pages (e.g., PAT creation page) |

The extension only activates on the Kronos timecard page (`https://stateofohiodas-sso.prd.mykronos.com/timekeeping`).

## Scope

This extension is intended for internal use by employees and contractors who use both Kronos for timekeeping and Azure DevOps for task management.

## Changes to This Policy

If this privacy policy is updated, the "Last Updated" date at the top will be changed. Continued use of the extension after changes constitutes acceptance of the updated policy.

## Contact

For questions about this privacy policy or the extension's data practices, please contact your IT department or the extension maintainer.

---

*This extension is not endorsed by or sponsored by Microsoft, Kronos, or UKG.*
