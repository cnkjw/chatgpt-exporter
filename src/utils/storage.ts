export class LocalStorage {
    static supported = typeof localStorage === 'object'

    static get<T>(key: string): T | null {
        const item = localStorage.getItem(key)
        if (item) {
            try {
                return JSON.parse(item)
            }
            catch {
                return null
            }
        }
        return null
    }

    static set<T>(key: string, value: T): void {
        const item = JSON.stringify(value)
        localStorage.setItem(key, item)
    }

    static delete(key: string): void {
        localStorage.removeItem(key)
    }
}

export class MemoryStorage {
    private static map = new Map<string, any>()

    static supported = true

    static get<T>(key: string): T | null {
        const item = this.map.get(key)
        if (!item) return null
        return item
    }

    static set<T>(key: string, value: T): void {
        this.map.set(key, value)
    }

    static delete(key: string): void {
        this.map.delete(key)
    }
}

export class ScriptStorage {
    static get<T>(key: string): T | null {
        if (LocalStorage.supported) {
            try {
                return LocalStorage.get<T>(key)
            }
            catch {
                // ignore, fallback to next storage
            }
        }

        return MemoryStorage.get<T>(key)
    }

    static set<T>(key: string, value: T): void {
        if (LocalStorage.supported) {
            try {
                return LocalStorage.set<T>(key, value)
            }
            catch {
                // ignore, fallback to next storage
            }
        }

        return MemoryStorage.set<T>(key, value)
    }

    static delete(key: string): void {
        if (LocalStorage.supported) {
            try {
                return LocalStorage.delete(key)
            }
            catch {
                // ignore, fallback to next storage
            }
        }

        return MemoryStorage.delete(key)
    }
}
