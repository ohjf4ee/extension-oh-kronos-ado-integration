// Chrome storage service for Kronos-ADO integration
// Wraps chrome.storage.local operations with proper error handling

import { CONFIG } from './config.js';

// ============================================================================
// Encryption utilities for sensitive data (PAT tokens)
// Uses Web Crypto API with AES-256-GCM
// ============================================================================

const ENCRYPTION_SALT = new Uint8Array([
    0x4b, 0x72, 0x6f, 0x6e, 0x6f, 0x73, 0x41, 0x44,
    0x4f, 0x53, 0x61, 0x6c, 0x74, 0x56, 0x31, 0x00
]); // "KronosADOSaltV1\0"

/**
 * Derive an encryption key from the extension ID
 * @returns {Promise<CryptoKey>}
 */
async function deriveEncryptionKey() {
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(chrome.runtime.id),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: ENCRYPTION_SALT,
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt a string value
 * @param {string} plaintext - The value to encrypt
 * @returns {Promise<string>} - Base64-encoded encrypted data with IV prefix
 */
async function encryptValue(plaintext) {
    const key = await deriveEncryptionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoded
    );

    // Combine IV + ciphertext and encode as base64
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);

    return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a string value
 * @param {string} encryptedBase64 - Base64-encoded encrypted data with IV prefix
 * @returns {Promise<string>} - Decrypted plaintext
 */
async function decryptValue(encryptedBase64) {
    const key = await deriveEncryptionKey();
    const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));

    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
    );

    return new TextDecoder().decode(decrypted);
}

/**
 * Save an encrypted value to Chrome local storage
 * @param {string} key - The storage key
 * @param {string} value - The plaintext value to encrypt and store
 * @returns {Promise<void>}
 */
export async function saveEncrypted(key, value) {
    if (!value) {
        await saveLocal(key, null);
        return;
    }
    const encrypted = await encryptValue(value);
    await saveLocal(key, { encrypted: true, data: encrypted });
}

/**
 * Load and decrypt a value from Chrome local storage
 * @param {string} key - The storage key
 * @returns {Promise<string|null>} - The decrypted value or null
 */
export async function loadEncrypted(key) {
    const stored = await loadLocal(key);
    if (!stored) return null;

    if (stored.encrypted && stored.data) {
        try {
            return await decryptValue(stored.data);
        } catch (error) {
            console.error('Failed to decrypt value:', error);
            return null;
        }
    }

    // Unrecognized format - return null (user will need to re-enter)
    return null;
}

// ============================================================================
// Basic storage operations
// ============================================================================

/**
 * Load a value from Chrome local storage
 * @param {string} key - The storage key
 * @returns {Promise<any>} - The stored value or undefined
 */
export function loadLocal(key) {
    return new Promise((resolve, reject) => {
        if (!chrome.runtime?.id) {
            reject(new Error("Extension context invalidated. Please reload the page."));
            return;
        }
        chrome.storage.local.get(key, (result) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(result[key]);
            }
        });
    });
}

/**
 * Save a value to Chrome local storage
 * @param {string} key - The storage key
 * @param {any} value - The value to store
 * @returns {Promise<void>}
 */
export function saveLocal(key, value) {
    return new Promise((resolve, reject) => {
        if (!chrome.runtime?.id) {
            reject(new Error("Extension context invalidated. Please reload the page."));
            return;
        }
        chrome.storage.local.set({ [key]: value }, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve();
            }
        });
    });
}

/**
 * Load the ADO configuration (org URL and PAT)
 * @returns {Promise<{orgUrl: string, pat: string, orgUrlRaw: string}>}
 */
export async function loadConfig() {
    const [orgUrl, pat, orgUrlRaw] = await Promise.all([
        loadLocal(CONFIG.STORAGE_KEYS.ORG_URL),
        loadEncrypted(CONFIG.STORAGE_KEYS.PAT),
        loadLocal(CONFIG.STORAGE_KEYS.ORG_URL_RAW)
    ]);
    return { orgUrl, pat, orgUrlRaw };
}

/**
 * Load hours worked from Kronos for all days
 * @returns {Promise<Object>} - Object keyed by date string
 */
export async function loadHoursByDay() {
    return (await loadLocal(CONFIG.STORAGE_KEYS.HOURS_BY_DAY)) || {};
}

/**
 * Load task allocations for all days
 * @returns {Promise<Object>} - Object keyed by date string
 */
export async function loadAllocations() {
    return (await loadLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY)) || {};
}

/**
 * Save task allocations for all days
 * @param {Object} allocations - Object keyed by date string
 * @returns {Promise<void>}
 */
export async function saveAllocations(allocations) {
    await saveLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY, allocations);
}

/**
 * Load allocations for a specific day
 * @param {string} dateKey - Date string (YYYY-MM-DD)
 * @returns {Promise<Array>} - Array of allocations for that day
 */
export async function loadDayAllocations(dateKey) {
    const data = await loadLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY);
    return data?.[dateKey] || [];
}

/**
 * Save allocations for a specific day
 * @param {string} dateKey - Date string (YYYY-MM-DD)
 * @param {Array} dayAllocations - Array of allocations for that day
 * @returns {Promise<void>}
 */
export async function saveDayAllocations(dateKey, dayAllocations) {
    const data = (await loadLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY)) || {};
    data[dateKey] = dayAllocations;
    await saveLocal(CONFIG.STORAGE_KEYS.ALLOCATIONS_BY_DAY, data);
}

/**
 * Load the task tree UI state (expanded/collapsed nodes)
 * @returns {Promise<Object>}
 */
export async function loadTaskTreeState() {
    return (await loadLocal(CONFIG.STORAGE_KEYS.TASK_TREE_STATE)) || { projects: {} };
}

/**
 * Save the task tree UI state
 * @param {Object} state
 * @returns {Promise<void>}
 */
export async function saveTaskTreeState(state) {
    await saveLocal(CONFIG.STORAGE_KEYS.TASK_TREE_STATE, state);
}

/**
 * Clear all extension data from storage
 * @returns {Promise<void>}
 */
export async function clearAllData() {
    const keys = Object.values(CONFIG.STORAGE_KEYS);
    return new Promise((resolve, reject) => {
        if (!chrome.runtime?.id) {
            reject(new Error("Extension context invalidated. Please reload the page."));
            return;
        }
        chrome.storage.local.remove(keys, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve();
            }
        });
    });
}
