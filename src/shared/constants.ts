/** Constants shared between background service worker and options page. */

// Chrome storage keys for WebDAV settings
export const KEY_WEBDAV_URL = 'webdav:url'
export const KEY_WEBDAV_USERNAME = 'webdav:username'
export const KEY_WEBDAV_PASSWORD = 'webdav:password'
export const KEY_WEBDAV_INTERVAL = 'webdav:interval'
export const KEY_WEBDAV_ENABLED = 'webdav:enabled'
export const KEY_WEBDAV_LAST_SAVE = 'webdav:last_save'

// Chrome alarm name
export const ALARM_AUTO_SAVE = 'chatgpt-exporter:auto-save'

// ChatGPT API endpoints
export const API_MAPPING: Record<string, string> = {
    'https://chat.openai.com': 'https://chat.openai.com/backend-api',
    'https://chatgpt.com': 'https://chatgpt.com/backend-api',
    'https://new.oaifree.com': 'https://new.oaifree.com/backend-api',
}

export const DEFAULT_API_BASE = 'https://chatgpt.com/backend-api'
