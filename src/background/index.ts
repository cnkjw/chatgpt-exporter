/**
 * Background service worker for ChatGPT Exporter Chrome Extension.
 *
 * Responsibilities:
 * - Schedule periodic auto-save alarms via chrome.alarms
 * - On each alarm tick: fetch recent conversations from the ChatGPT API,
 *   convert them to Markdown, and upload to the configured WebDAV server
 * - Listen for settings updates from the options page via chrome.runtime messages
 */

import {
    ALARM_AUTO_SAVE,
    API_MAPPING,
    DEFAULT_API_BASE,
    KEY_WEBDAV_ENABLED,
    KEY_WEBDAV_INTERVAL,
    KEY_WEBDAV_LAST_SAVE,
    KEY_WEBDAV_PASSWORD,
    KEY_WEBDAV_URL,
    KEY_WEBDAV_USERNAME,
} from '../shared/constants'
import { uploadToWebDAV } from '../utils/webdav'

// ─── Types ───────────────────────────────────────────────────────────────────

interface WebDAVSettings {
    url: string
    username: string
    password: string
    intervalMinutes: number
    enabled: boolean
}

interface ApiConversationItem {
    id: string
    title: string
    create_time: number
    update_time: number
}

interface ApiConversations {
    items: ApiConversationItem[]
    total: number | null
    limit: number
    offset: number
    cursor?: string | null
}

interface ConversationNode {
    id: string
    parent?: string
    children: string[]
    message?: {
        id: string
        author: { role: string }
        content: {
            content_type: string
            parts?: string[]
            text?: string
        }
        create_time?: number
    }
}

interface ApiConversation {
    title: string
    create_time: number
    update_time: number
    current_node: string
    mapping: Record<string, ConversationNode>
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getWebDAVSettings(): Promise<WebDAVSettings | null> {
    return new Promise((resolve) => {
        chrome.storage.local.get(
            [KEY_WEBDAV_URL, KEY_WEBDAV_USERNAME, KEY_WEBDAV_PASSWORD, KEY_WEBDAV_INTERVAL, KEY_WEBDAV_ENABLED],
            (items: Record<string, unknown>) => {
                const url = items[KEY_WEBDAV_URL] as string | undefined
                const enabled = items[KEY_WEBDAV_ENABLED] as boolean | undefined
                if (!url || !enabled) {
                    resolve(null)
                    return
                }
                resolve({
                    url,
                    username: (items[KEY_WEBDAV_USERNAME] as string) ?? '',
                    password: (items[KEY_WEBDAV_PASSWORD] as string) ?? '',
                    intervalMinutes: (items[KEY_WEBDAV_INTERVAL] as number) ?? 60,
                    enabled: enabled ?? false,
                })
            },
        )
    })
}

function getApiBase(origin: string): string {
    return API_MAPPING[origin] ?? DEFAULT_API_BASE
}

async function fetchSession(apiBase: string): Promise<string | null> {
    try {
        const resp = await fetch(`${apiBase.replace('/backend-api', '')}/api/auth/session`)
        if (!resp.ok) return null
        const data = await resp.json() as { accessToken?: string }
        return data.accessToken ?? null
    }
    catch {
        return null
    }
}

async function fetchConversations(
    apiBase: string,
    token: string,
    since: number,
): Promise<ApiConversationItem[]> {
    const items: ApiConversationItem[] = []
    let offset = 0
    const limit = 20

    while (true) {
        const url = `${apiBase}/conversations?offset=${offset}&limit=${limit}`
        const resp = await fetch(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Authorization': `Bearer ${token}`,
            },
        })
        if (!resp.ok) break

        const data = await resp.json() as ApiConversations
        if (!data.items || data.items.length === 0) break

        const filtered = data.items.filter(c => (c.update_time ?? c.create_time ?? 0) > since)
        items.push(...filtered)

        // If the earliest item in this batch is older than `since`, stop paginating
        const oldest = data.items[data.items.length - 1]
        if ((oldest.update_time ?? oldest.create_time ?? 0) <= since) break

        if (data.total !== null && offset + limit >= data.total) break
        if (!data.cursor && data.items.length < limit) break

        offset += limit
    }

    return items
}

async function fetchConversationDetail(
    apiBase: string,
    token: string,
    id: string,
): Promise<ApiConversation | null> {
    try {
        const resp = await fetch(`${apiBase}/conversation/${id}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Authorization': `Bearer ${token}`,
            },
        })
        if (!resp.ok) return null
        return resp.json() as Promise<ApiConversation>
    }
    catch {
        return null
    }
}

/** Convert a conversation to a simple Markdown string. */
function conversationToMarkdown(id: string, conv: ApiConversation): string {
    const title = conv.title ?? 'Untitled'
    const lines: string[] = [
        `# ${title}`,
        '',
        `- **Chat ID**: ${id}`,
        `- **Created**: ${new Date(conv.create_time * 1000).toISOString()}`,
        `- **Updated**: ${new Date(conv.update_time * 1000).toISOString()}`,
        '',
        '---',
        '',
    ]

    // Walk the conversation tree from current_node to root
    const path: ConversationNode[] = []
    let nodeId: string | undefined = conv.current_node
    while (nodeId) {
        const node: ConversationNode | undefined = conv.mapping[nodeId]
        if (!node) break
        path.unshift(node)
        nodeId = node.parent
    }

    for (const node of path) {
        const msg = node.message
        if (!msg) continue
        const role = msg.author?.role ?? 'unknown'
        if (role === 'system') continue

        const prefix = role === 'user' ? '**You**' : '**Assistant**'
        let text = ''
        if (msg.content.content_type === 'text' && msg.content.parts) {
            text = msg.content.parts.filter((p): p is string => typeof p === 'string').join('\n')
        }
        else if (msg.content.text) {
            text = msg.content.text
        }
        if (!text) continue

        lines.push(`${prefix}:`, '', text, '', '---', '')
    }

    return lines.join('\n')
}

function sanitizeFilename(name: string): string {
    return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_').slice(0, 100)
}

// ─── Core auto-save logic ─────────────────────────────────────────────────────

async function runAutoSave(): Promise<void> {
    const settings = await getWebDAVSettings()
    if (!settings) {
        console.log('[AutoSave] Skipped: WebDAV not configured or disabled.')
        return
    }

    // Determine last save time from storage
    const lastSaveResult = await new Promise<Record<string, unknown>>((resolve) => {
        chrome.storage.local.get(
            [KEY_WEBDAV_LAST_SAVE],
            (items: Record<string, unknown>) => resolve(items),
        )
    })
    const lastSave = (lastSaveResult[KEY_WEBDAV_LAST_SAVE] as number | undefined) ?? 0

    // Try each known ChatGPT origin
    const apiBase = DEFAULT_API_BASE
    let token: string | null = null
    for (const origin of Object.keys(API_MAPPING)) {
        token = await fetchSession(getApiBase(origin))
        if (token) break
    }

    if (!token) {
        console.warn('[AutoSave] Could not obtain access token. Are you logged in to ChatGPT?')
        return
    }

    let conversations: ApiConversationItem[]
    try {
        conversations = await fetchConversations(apiBase, token, lastSave)
    }
    catch (err) {
        console.error('[AutoSave] Failed to fetch conversations list:', err)
        return
    }

    if (conversations.length === 0) {
        console.log('[AutoSave] No conversations updated since last save.')
        chrome.storage.local.set({ [KEY_WEBDAV_LAST_SAVE]: Math.floor(Date.now() / 1000) })
        return
    }

    console.log(`[AutoSave] Found ${conversations.length} conversation(s) to save.`)

    const errors: string[] = []
    let saved = 0

    for (const item of conversations) {
        const conv = await fetchConversationDetail(apiBase, token, item.id)
        if (!conv) {
            errors.push(`Failed to fetch conversation ${item.id}`)
            continue
        }

        const markdown = conversationToMarkdown(item.id, conv)
        const safeTitle = sanitizeFilename(conv.title || item.id)
        const dateStr = new Date(conv.update_time * 1000).toISOString().split('T')[0]
        const remotePath = `/chatgpt-export/${dateStr}/${safeTitle}-${item.id.slice(0, 8)}.md`

        const result = await uploadToWebDAV(
            { url: settings.url, username: settings.username, password: settings.password },
            remotePath,
            markdown,
        )

        if (result.success) {
            saved++
        }
        else {
            errors.push(`Failed to upload "${conv.title}": ${result.error}`)
        }
    }

    // Update last save timestamp
    chrome.storage.local.set({ [KEY_WEBDAV_LAST_SAVE]: Math.floor(Date.now() / 1000) })

    if (errors.length > 0) {
        console.error('[AutoSave] Errors during save:', errors)
        // Show a notification so the user knows something went wrong
        chrome.notifications?.create?.('auto-save-error', {
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: 'ChatGPT Exporter – Auto-save error',
            message: `Saved ${saved} conversation(s). ${errors.length} error(s): ${errors[0]}`,
        })
    }
    else {
        console.log(`[AutoSave] Successfully saved ${saved} conversation(s) to WebDAV.`)
    }
}

// ─── Alarm scheduling ─────────────────────────────────────────────────────────

async function scheduleAlarm(intervalMinutes: number): Promise<void> {
    await chrome.alarms.clear(ALARM_AUTO_SAVE)
    if (intervalMinutes > 0) {
        chrome.alarms.create(ALARM_AUTO_SAVE, {
            delayInMinutes: intervalMinutes,
            periodInMinutes: intervalMinutes,
        })
        console.log(`[AutoSave] Alarm scheduled every ${intervalMinutes} minute(s).`)
    }
}

async function refreshAlarm(): Promise<void> {
    const settings = await getWebDAVSettings()
    if (settings?.enabled && settings.intervalMinutes > 0) {
        await scheduleAlarm(settings.intervalMinutes)
    }
    else {
        await chrome.alarms.clear(ALARM_AUTO_SAVE)
    }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_AUTO_SAVE) {
        runAutoSave().catch(err => console.error('[AutoSave] Unexpected error:', err))
    }
})

// Re-schedule alarm on extension startup
chrome.runtime.onStartup.addListener(() => {
    refreshAlarm().catch(err => console.error('[Background] onStartup error:', err))
})

// Re-schedule alarm on install/update
chrome.runtime.onInstalled.addListener(() => {
    refreshAlarm().catch(err => console.error('[Background] onInstalled error:', err))
})

// Listen for messages from the options page to refresh the alarm schedule
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (typeof message === 'object' && message !== null) {
        const msg = message as Record<string, unknown>
        if (msg.type === 'SETTINGS_UPDATED') {
            refreshAlarm()
                .then(() => sendResponse({ ok: true }))
                .catch(err => sendResponse({ ok: false, error: String(err) }))
            return true // keep channel open for async response
        }
        if (msg.type === 'RUN_AUTO_SAVE_NOW') {
            runAutoSave()
                .then(() => sendResponse({ ok: true }))
                .catch(err => sendResponse({ ok: false, error: String(err) }))
            return true
        }
    }
    return false
})
