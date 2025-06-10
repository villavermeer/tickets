import Redis from 'ioredis';
import {singleton} from "tsyringe";

export interface IRedis {
    getClient(): Redis;
}

@singleton()
export default class RedisClient {
    private static instance: Redis;

    public static getClient(): Redis {
        if (!RedisClient.instance) {
            RedisClient.instance = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
            RedisClient.instance.on('error', (err) => console.error('Redis Client Error', err));
            RedisClient.instance.on('connect', () => console.log('Connected to Redis'));
        }

        return RedisClient.instance;
    }
}