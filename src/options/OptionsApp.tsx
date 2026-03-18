import { useCallback, useEffect, useState } from 'preact/hooks'
import {
    ALARM_AUTO_SAVE,
    KEY_WEBDAV_ENABLED,
    KEY_WEBDAV_INTERVAL,
    KEY_WEBDAV_LAST_SAVE,
    KEY_WEBDAV_PASSWORD,
    KEY_WEBDAV_URL,
    KEY_WEBDAV_USERNAME,
} from '../shared/constants'
import { uploadToWebDAV } from '../utils/webdav'

interface Settings {
    url: string
    username: string
    password: string
    intervalMinutes: number
    enabled: boolean
}

const DEFAULT_SETTINGS: Settings = {
    url: '',
    username: '',
    password: '',
    intervalMinutes: 60,
    enabled: false,
}

function loadSettings(): Promise<Settings> {
    return new Promise((resolve) => {
        chrome.storage.local.get(
            [KEY_WEBDAV_URL, KEY_WEBDAV_USERNAME, KEY_WEBDAV_PASSWORD, KEY_WEBDAV_INTERVAL, KEY_WEBDAV_ENABLED],
            (items) => {
                resolve({
                    url: (items[KEY_WEBDAV_URL] as string) ?? DEFAULT_SETTINGS.url,
                    username: (items[KEY_WEBDAV_USERNAME] as string) ?? DEFAULT_SETTINGS.username,
                    password: (items[KEY_WEBDAV_PASSWORD] as string) ?? DEFAULT_SETTINGS.password,
                    intervalMinutes: (items[KEY_WEBDAV_INTERVAL] as number) ?? DEFAULT_SETTINGS.intervalMinutes,
                    enabled: (items[KEY_WEBDAV_ENABLED] as boolean) ?? DEFAULT_SETTINGS.enabled,
                })
            },
        )
    })
}

function saveSettings(settings: Settings): Promise<void> {
    return new Promise((resolve) => {
        chrome.storage.local.set({
            [KEY_WEBDAV_URL]: settings.url,
            [KEY_WEBDAV_USERNAME]: settings.username,
            [KEY_WEBDAV_PASSWORD]: settings.password,
            [KEY_WEBDAV_INTERVAL]: settings.intervalMinutes,
            [KEY_WEBDAV_ENABLED]: settings.enabled,
        }, resolve)
    })
}

function notifyBackground(type: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type }, (resp) => {
            if (chrome.runtime.lastError) {
                resolve({ ok: false, error: chrome.runtime.lastError.message })
            }
            else {
                resolve(resp ?? { ok: true })
            }
        })
    })
}

export function OptionsApp() {
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
    const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null)
    const [isSaving, setIsSaving] = useState(false)
    const [isTesting, setIsTesting] = useState(false)
    const [isRunning, setIsRunning] = useState(false)
    const [lastSave, setLastSave] = useState<Date | null>(null)
    const [nextAlarm, setNextAlarm] = useState<Date | null>(null)
    const [showPassword, setShowPassword] = useState(false)

    useEffect(() => {
        loadSettings().then(setSettings)

        chrome.storage.local.get(KEY_WEBDAV_LAST_SAVE, (items) => {
            const ts = items[KEY_WEBDAV_LAST_SAVE] as number | undefined
            if (ts) setLastSave(new Date(ts * 1000))
        })

        chrome.alarms.get(ALARM_AUTO_SAVE, (alarm) => {
            if (alarm?.scheduledTime) {
                setNextAlarm(new Date(alarm.scheduledTime))
            }
        })
    }, [])

    const handleSave = useCallback(async () => {
        setIsSaving(true)
        setStatus(null)
        try {
            // Request optional host permission for the WebDAV server before saving
            if (settings.url) {
                try {
                    const origin = new URL(settings.url).origin
                    await chrome.permissions.request({ origins: [`${origin}/*`] })
                }
                catch {
                    // Non-fatal: the user may have denied or the URL is invalid
                }
            }

            await saveSettings(settings)
            const resp = await notifyBackground('SETTINGS_UPDATED')
            if (!resp.ok) throw new Error(resp.error ?? 'Unknown error')

            // Refresh next alarm display
            chrome.alarms.get(ALARM_AUTO_SAVE, (alarm) => {
                setNextAlarm(alarm?.scheduledTime ? new Date(alarm.scheduledTime) : null)
            })

            setStatus({ type: 'success', message: '✅ Settings saved successfully!' })
        }
        catch (err) {
            setStatus({ type: 'error', message: `❌ Failed to save: ${String(err)}` })
        }
        finally {
            setIsSaving(false)
        }
    }, [settings])

    const handleTest = useCallback(async () => {
        if (!settings.url) {
            setStatus({ type: 'error', message: '❌ Please enter a WebDAV URL first.' })
            return
        }
        setIsTesting(true)
        setStatus({ type: 'info', message: '⏳ Testing WebDAV connection…' })
        try {
            const result = await uploadToWebDAV(
                { url: settings.url, username: settings.username, password: settings.password },
                '/chatgpt-export/.test',
                `Connection test at ${new Date().toISOString()}`,
                'text/plain',
            )
            if (result.success) {
                setStatus({ type: 'success', message: `✅ Connection successful! (HTTP ${result.statusCode})` })
            }
            else {
                setStatus({ type: 'error', message: `❌ Connection failed: ${result.error}` })
            }
        }
        catch (err) {
            setStatus({ type: 'error', message: `❌ Error: ${String(err)}` })
        }
        finally {
            setIsTesting(false)
        }
    }, [settings])

    const handleRunNow = useCallback(async () => {
        setIsRunning(true)
        setStatus({ type: 'info', message: '⏳ Running auto-save…' })
        try {
            const resp = await notifyBackground('RUN_AUTO_SAVE_NOW')
            if (resp.ok) {
                setStatus({ type: 'success', message: '✅ Auto-save completed. Check the console for details.' })
                chrome.storage.local.get(KEY_WEBDAV_LAST_SAVE, (items) => {
                    const ts = items[KEY_WEBDAV_LAST_SAVE] as number | undefined
                    if (ts) setLastSave(new Date(ts * 1000))
                })
            }
            else {
                setStatus({ type: 'error', message: `❌ Auto-save failed: ${resp.error}` })
            }
        }
        catch (err) {
            setStatus({ type: 'error', message: `❌ Error: ${String(err)}` })
        }
        finally {
            setIsRunning(false)
        }
    }, [])

    const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }))
        setStatus(null)
    }

    return (
        <div style={styles.page}>
            <div style={styles.container}>
                <header style={styles.header}>
                    <h1 style={styles.title}>ChatGPT Exporter</h1>
                    <p style={styles.subtitle}>Extension Settings</p>
                </header>

                {/* ── WebDAV Configuration ── */}
                <section style={styles.section}>
                    <h2 style={styles.sectionTitle}>WebDAV Auto-Save</h2>
                    <p style={styles.sectionDesc}>
                        Configure a WebDAV server to automatically save your ChatGPT conversations.
                    </p>

                    <div style={styles.field}>
                        <label style={styles.label} htmlFor="webdav-enabled">
                            Enable Auto-Save
                        </label>
                        <input
                            id="webdav-enabled"
                            type="checkbox"
                            style={styles.checkbox}
                            checked={settings.enabled}
                            onChange={e => update('enabled', (e.target as HTMLInputElement).checked)}
                        />
                    </div>

                    <div style={styles.field}>
                        <label style={styles.label} htmlFor="webdav-url">
                            WebDAV Server URL
                        </label>
                        <input
                            id="webdav-url"
                            type="url"
                            placeholder="https://your-webdav-server.com/dav"
                            style={styles.input}
                            value={settings.url}
                            onInput={e => update('url', (e.target as HTMLInputElement).value.trim())}
                        />
                        <small style={styles.hint}>
                            Full URL to your WebDAV endpoint (e.g. Nextcloud: https://cloud.example.com/remote.php/dav/files/user/)
                        </small>
                    </div>

                    <div style={styles.field}>
                        <label style={styles.label} htmlFor="webdav-username">
                            Username
                        </label>
                        <input
                            id="webdav-username"
                            type="text"
                            placeholder="your-username"
                            style={styles.input}
                            autoComplete="off"
                            value={settings.username}
                            onInput={e => update('username', (e.target as HTMLInputElement).value)}
                        />
                    </div>

                    <div style={styles.field}>
                        <label style={styles.label} htmlFor="webdav-password">
                            Password / Access Token
                        </label>
                        <div style={styles.passwordWrapper}>
                            <input
                                id="webdav-password"
                                type={showPassword ? 'text' : 'password'}
                                placeholder="••••••••"
                                style={{ ...styles.input, flex: 1 }}
                                autoComplete="new-password"
                                value={settings.password}
                                onInput={e => update('password', (e.target as HTMLInputElement).value)}
                            />
                            <button
                                type="button"
                                style={styles.toggleBtn}
                                onClick={() => setShowPassword(v => !v)}
                                title={showPassword ? 'Hide password' : 'Show password'}
                            >
                                {showPassword ? '🙈' : '👁️'}
                            </button>
                        </div>
                        <small style={styles.hint}>
                            Your password is stored locally in Chrome's extension storage, not synced or sent anywhere except your WebDAV server.
                        </small>
                    </div>

                    <div style={styles.field}>
                        <label style={styles.label} htmlFor="webdav-interval">
                            Auto-Save Interval (minutes)
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <input
                                id="webdav-interval"
                                type="range"
                                min="1"
                                max="1440"
                                step="1"
                                style={styles.range}
                                value={settings.intervalMinutes}
                                onChange={e => update('intervalMinutes', Number((e.target as HTMLInputElement).value))}
                            />
                            <span style={styles.rangeValue}>{settings.intervalMinutes} min</span>
                        </div>
                        <small style={styles.hint}>
                            Conversations updated since the last save will be exported.
                            Minimum: 1 minute. Set to a higher value to reduce API calls.
                        </small>
                    </div>
                </section>

                {/* ── Save Status ── */}
                {lastSave && (
                    <section style={styles.statusSection}>
                        <p style={styles.statusText}>
                            🕐 Last auto-save: <strong>{lastSave.toLocaleString()}</strong>
                        </p>
                        {nextAlarm && (
                            <p style={styles.statusText}>
                                ⏰ Next scheduled save: <strong>{nextAlarm.toLocaleString()}</strong>
                            </p>
                        )}
                    </section>
                )}

                {/* ── Feedback ── */}
                {status && (
                    <div style={{
                        ...styles.alert,
                        background: status.type === 'error'
                            ? '#fee2e2'
                            : status.type === 'success'
                                ? '#dcfce7'
                                : '#dbeafe',
                        borderColor: status.type === 'error'
                            ? '#fca5a5'
                            : status.type === 'success'
                                ? '#86efac'
                                : '#93c5fd',
                    }}>
                        {status.message}
                    </div>
                )}

                {/* ── Actions ── */}
                <div style={styles.actions}>
                    <button
                        style={styles.primaryBtn}
                        onClick={handleSave}
                        disabled={isSaving}
                    >
                        {isSaving ? 'Saving…' : 'Save Settings'}
                    </button>
                    <button
                        style={styles.secondaryBtn}
                        onClick={handleTest}
                        disabled={isTesting || !settings.url}
                        title="Upload a test file to verify your WebDAV settings"
                    >
                        {isTesting ? 'Testing…' : 'Test Connection'}
                    </button>
                    <button
                        style={styles.secondaryBtn}
                        onClick={handleRunNow}
                        disabled={isRunning || !settings.enabled}
                        title="Run auto-save now without waiting for the next scheduled interval"
                    >
                        {isRunning ? 'Running…' : 'Save Now'}
                    </button>
                </div>

                <footer style={styles.footer}>
                    <p>
                        Files are saved to <code>/chatgpt-export/YYYY-MM-DD/title-id.md</code> on your WebDAV server.
                    </p>
                </footer>
            </div>
        </div>
    )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, preact.JSX.CSSProperties> = {
    page: {
        minHeight: '100vh',
        background: '#f9fafb',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: '#1f2937',
    },
    container: {
        maxWidth: 640,
        margin: '0 auto',
        padding: '32px 24px',
    },
    header: {
        marginBottom: 32,
        borderBottom: '1px solid #e5e7eb',
        paddingBottom: 16,
    },
    title: {
        fontSize: 28,
        fontWeight: 700,
        margin: 0,
        color: '#111827',
    },
    subtitle: {
        margin: '4px 0 0',
        color: '#6b7280',
        fontSize: 14,
    },
    section: {
        background: '#fff',
        borderRadius: 12,
        border: '1px solid #e5e7eb',
        padding: 24,
        marginBottom: 20,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: 600,
        margin: '0 0 4px',
    },
    sectionDesc: {
        color: '#6b7280',
        fontSize: 14,
        margin: '0 0 20px',
    },
    field: {
        marginBottom: 18,
    },
    label: {
        display: 'block',
        fontSize: 14,
        fontWeight: 500,
        marginBottom: 6,
        color: '#374151',
    },
    input: {
        width: '100%',
        padding: '8px 12px',
        border: '1px solid #d1d5db',
        borderRadius: 8,
        fontSize: 14,
        boxSizing: 'border-box',
        outline: 'none',
    },
    checkbox: {
        width: 18,
        height: 18,
        cursor: 'pointer',
    },
    passwordWrapper: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
    },
    toggleBtn: {
        background: 'none',
        border: '1px solid #d1d5db',
        borderRadius: 8,
        padding: '8px 10px',
        cursor: 'pointer',
        fontSize: 16,
        lineHeight: 1,
    },
    hint: {
        display: 'block',
        marginTop: 4,
        color: '#9ca3af',
        fontSize: 12,
    },
    range: {
        flex: 1,
        cursor: 'pointer',
    },
    rangeValue: {
        minWidth: 60,
        textAlign: 'right',
        fontSize: 14,
        fontWeight: 500,
        color: '#374151',
    },
    alert: {
        border: '1px solid',
        borderRadius: 8,
        padding: '10px 14px',
        marginBottom: 16,
        fontSize: 14,
    },
    statusSection: {
        background: '#f3f4f6',
        borderRadius: 8,
        padding: '12px 16px',
        marginBottom: 20,
        fontSize: 13,
        color: '#4b5563',
    },
    statusText: {
        margin: '2px 0',
    },
    actions: {
        display: 'flex',
        gap: 10,
        flexWrap: 'wrap',
    },
    primaryBtn: {
        background: '#10a37f',
        color: '#fff',
        border: 'none',
        borderRadius: 8,
        padding: '10px 22px',
        fontSize: 14,
        fontWeight: 600,
        cursor: 'pointer',
    },
    secondaryBtn: {
        background: '#fff',
        color: '#374151',
        border: '1px solid #d1d5db',
        borderRadius: 8,
        padding: '10px 18px',
        fontSize: 14,
        fontWeight: 500,
        cursor: 'pointer',
    },
    footer: {
        marginTop: 32,
        color: '#9ca3af',
        fontSize: 12,
        textAlign: 'center',
    },
}
