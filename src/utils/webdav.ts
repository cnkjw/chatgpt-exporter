export interface WebDAVConfig {
    url: string
    username: string
    password: string
}

export interface WebDAVUploadResult {
    success: boolean
    error?: string
    statusCode?: number
}

function buildAuthHeader(username: string, password: string): string {
    return `Basic ${btoa(`${username}:${password}`)}`
}

/** Ensure the WebDAV base path exists by creating directories recursively. */
async function ensureDirectory(baseUrl: string, auth: string): Promise<void> {
    const url = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    const response = await fetch(url, {
        method: 'MKCOL',
        headers: { Authorization: auth },
    })
    // 201 = created, 405 = already exists – both are fine
    if (!response.ok && response.status !== 405 && response.status !== 301) {
        console.warn(`[WebDAV] MKCOL returned ${response.status} for ${url}`)
    }
}

/**
 * Upload text content to a WebDAV server via HTTP PUT.
 * Creates parent directories with MKCOL if needed.
 */
export async function uploadToWebDAV(
    config: WebDAVConfig,
    remotePath: string,
    content: string,
    mimeType = 'text/markdown; charset=utf-8',
): Promise<WebDAVUploadResult> {
    const base = config.url.replace(/\/$/, '')
    const path = remotePath.startsWith('/') ? remotePath : `/${remotePath}`
    const fullUrl = `${base}${path}`
    const auth = buildAuthHeader(config.username, config.password)

    // Ensure parent directory exists
    const parentPath = path.split('/').slice(0, -1).join('/')
    if (parentPath) {
        try {
            await ensureDirectory(`${base}${parentPath}`, auth)
        }
        catch {
            // Non-fatal: proceed with PUT and let the server return an error if needed
        }
    }

    let response: Response
    try {
        response = await fetch(fullUrl, {
            method: 'PUT',
            headers: {
                'Authorization': auth,
                'Content-Type': mimeType,
            },
            body: content,
        })
    }
    catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: `Network error: ${msg}` }
    }

    if (!response.ok) {
        const body = await response.text().catch(() => '')
        return {
            success: false,
            statusCode: response.status,
            error: `HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`,
        }
    }

    return { success: true, statusCode: response.status }
}
