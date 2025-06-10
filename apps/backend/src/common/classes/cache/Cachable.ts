import RedisClient from "./RedisClient";
import Redis from "ioredis";

class Cachable {
    protected redis: Redis = RedisClient.getClient()

    public static async deleteMany(prefixes: string[]): Promise<void> {
        const redis = RedisClient.getClient();
        try {
            for (const prefix of prefixes) {
                const keys = await redis.keys(`${prefix}*`);
                if (keys.length > 0) {
                    await redis.del(keys);
                }
            }
        } catch (error) {
            console.error("Error deleting keys by prefixes:", error);
        }
    }

    public async findCacheEntry<T>(key: string): Promise<T | null> {
        try {
            const cached = await this.redis.get(key)
            return cached ? JSON.parse(cached) : null
        } catch (error) {
            console.error(`Error getting cache for key "${key}":`, error)
            return null
        }
    }

    protected async withCache<T>(
        key: string,
        fetchFn: () => Promise<T>,
        options: { ttl?: number } = {}
    ): Promise<T> {
        const cached = await this.findCacheEntry<T>(key)
        if (cached !== null) return cached

        const data = await fetchFn()
        if (data !== null && data !== undefined) {
            await this.setCacheEntry(key, data, options.ttl)
        }

        return data
    }

    protected async setCacheEntry(key: string, value: any, ttl?: number): Promise<void> {
        try {
            const stringValue = JSON.stringify(value)
            if (ttl) {
                await this.redis.set(key, stringValue, 'EX', ttl)
            } else {
                await this.redis.set(key, stringValue)
            }
        } catch (error) {
            console.error(`Error setting cache for key "${key}":`, error)
        }
    }

    protected async deleteFromCache(key: string): Promise<void> {
        try {
            await this.redis.del(key)
        } catch (error) {
            console.error(`Error deleting cache for key "${key}":`, error)
        }
    }
}

export default Cachable