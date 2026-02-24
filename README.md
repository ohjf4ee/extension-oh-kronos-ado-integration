# Kronos-ADO Integration

This repo is for a browser extension for a Kronos timecard page. The extension adds the day's target out time and displays a sidebar to help the user allocate hours in Kronos to Azure DevOps (ADO) task work items.

**Supported Browsers**: Microsoft Edge, Google Chrome (Manifest v3)

## Features

- **Target Out Time**: Shows when you should clock out today to hit 40 hours for the week (based on 8 hours a day for any remaining days in the week)
- **Hour Allocation**: Allocate your daily Kronos hours to ADO Task work items
  - Create new PBIs or Bugs for a project
  - Create new Tasks under a PBI or Bug
  - Easily close, complete, or mark work items as done
- **Copy to Clipboard**: Copy the week's hours by Project, PBI/Bug, and Task for pasting into Excel or email

## Installation

### Microsoft Edge

Install from the [Edge Add-ons store](https://microsoftedge.microsoft.com/addons/) (pending publication).

For development/testing:

1. Open `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

### Google Chrome

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

## Configuring the ADO PAT and URL

1. Navigate to the Kronos My Timecard page and click the extension icon to open the sidebar.
2. Expand the **ADO Org** section.
3. Enter an ADO organization URL (for example `https://dev.azure.com/<org>`).
4. Use the **Open PAT page** link to create a Personal Access Token with **Work Items (Read & write)** permission.
5. Paste the PAT into the field and click **Save**.

## Toggling the sidebar

The sidebar is open by default on the Kronos My Timecard page. You can close or reopen it by clicking the extension icon.

## Testing

Run `npm test` before committing. The current script simply prints `"No tests"`.

## Repo Folders and Files

```text
Extension-Kronos-ADO-integration/
├── manifest.json           # Chrome extension manifest (v3)
├── background.js           # Service worker for extension actions
├── contentScript.js        # Injected into Kronos pages
├── package.json            # npm configuration
├── README.md               # This file
├── CLAUDE.md               # Claude Code instructions
│
├── icons/                  # Extension icons
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
│
├── lib/                    # Third-party libraries
│   ├── toastify.min.js
│   └── toastify.min.css
│
├── docs/
│   └── screenshot.png      # Documentation assets
│
└── src/
    ├── config.js           # Centralized configuration constants
    ├── utils.js            # Pure utility functions
    ├── storage.js          # Chrome storage wrapper
    ├── timecard-sidebar.html   # Sidebar UI template
    ├── timecard-sidebar.js     # Main orchestrator
    ├── ado/                # Azure DevOps integration
    │   ├── api-client.js   # ADO REST API client
    │   ├── hours-sync.js   # Hours synchronization logic
    │   ├── utils.js        # ADO-specific utilities
    │   └── index.js        # Module exports
    └── ui/
        ├── time-grid.js    # Weekly time grid component
        ├── task-tree.js    # Project/PBI/Task tree selector
        ├── modals.js       # Toast notifications and dialogs
        ├── config-panel.js # ADO configuration panel
        └── copy-grid.js    # Copy grid to clipboard
```

## Permissions & Privacy

This extension requests minimal permissions required for its functionality:

| Permission | Justification                                                                                                     |
|------------|-------------------------------------------------------------------------------------------------------------------|
| `storage`  | Store user settings (ADO org URL) and timecard data locally in the browser. No data is sent to external servers. |
| `tabs`     | Open the Azure DevOps PAT creation page in a new tab when the user clicks "Open PAT page".                        |

### Content Script Scope

The extension **only activates** on a single, specific URL:

- `https://stateofohiodas-sso.prd.mykronos.com/timekeeping`

This is the relevant Kronos timecard page. The extension does not run on any other websites.

The `all_frames: true` setting is required because the Kronos application uses internal frames, and the extension needs to read timecard data from within those frames.

### Data Handling

| Data                  | Storage                           | Transmission                              |
|-----------------------|-----------------------------------|-------------------------------------------|
| ADO Organization URL  | Browser local storage (plaintext) | Never transmitted externally              |
| Personal Access Token | Browser local storage (encrypted) | Sent only to user's configured ADO org    |
| Timecard hours        | Browser local storage (plaintext) | Optionally written to ADO task comments   |
| Task allocations      | Browser local storage (plaintext) | Optionally written to ADO task comments   |
| Task tree UI state    | Browser local storage (plaintext) | Never transmitted                         |

### Local Storage Structure

All data is stored in `chrome.storage.local` using the following keys:

| Storage Key                 | Description                                                                 |
|-----------------------------|-----------------------------------------------------------------------------|
| `adoOrgUrl`                 | Normalized ADO organization URL (e.g., `https://dev.azure.com/myorg`)       |
| `adoOrgUrlInputRaw`         | Original URL as entered by the user (before normalization)                  |
| `adoPAT`                    | Personal Access Token (AES-256-GCM encrypted)                               |
| `kronos_hoursByDay`         | Hours scraped from Kronos, keyed by date                                    |
| `kronos_allocationsByDay`   | Task hour allocations, keyed by date                                        |
| `kronos_taskTreeState`      | Expand/collapse state of projects and PBIs in the task tree UI              |

**Example data structures:**

```javascript
// kronos_hoursByDay
{
  "2025-01-15": { "hours": "8.0" },
  "2025-01-16": { "hours": "7.5" }
}

// kronos_allocationsByDay
{
  "2025-01-15": [
    { "taskId": 12345, "hours": 4.0, "confirmed": true, "source": "ado" },
    { "taskId": 12346, "hours": 4.0, "confirmed": true, "source": "manual" }
  ]
}

// kronos_taskTreeState
{
  "projects": {
    "MyProject": {
      "expanded": true,
      "pbis": { "98765": true, "98766": false }
    }
  }
}
```

### External Communications

This extension communicates **only** with:

- **Azure DevOps REST API** (`https://dev.azure.com/{user-configured-org}`) — for task queries and updates
- **Azure DevOps Identity API** (`https://vssps.dev.azure.com/{user-configured-org}`) — for user authentication validation

The extension does **not**:

- Use analytics or telemetry services
- Contact any third-party servers
- Share data with anyone other than the user's own ADO organization
- Collect browsing history or activity outside the Kronos timecard page

### Security Measures

- **PAT Encryption**: Personal Access Tokens are encrypted using AES-256-GCM with PBKDF2 key derivation (100,000 iterations) before storage
- **Content Security Policy**: Explicitly disallows `eval()` and inline scripts
- **HTTPS Only**: All API communications use HTTPS
- **No Remote Code**: All JavaScript is bundled locally; no external scripts are loaded

### Data Deletion

Users can delete all stored data at any time:

1. Open the sidebar on the Kronos timecard page
2. Expand the configuration section
3. Click "Clear All Data"

Alternatively, uninstalling the extension removes all stored data.

For complete privacy details, see [PRIVACY.md](PRIVACY.md).
