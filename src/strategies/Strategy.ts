import { RateLimiter, RateLimiterResponse } from '../RateLimiter';

export abstract class Strategy {
    limiter: RateLimiter;
    scriptSha1?: string;

    constructor(limiter: RateLimiter) {
        this.limiter = limiter;
    }

    /**
     * Wrapper for sending command to Redis
     * @param cmd {string} Redis command
     * @param args {any[]} Arguments
     * @returns {Promise<any>}
     */
    abstract sendCommand(cmd: string, ...args: any[]): Promise<any>

    /**
     * Load script on Redis cache and returns sha1 of the script
     * @returns {Promise<string>}
     */
    abstract loadScript(): Promise<string>

    /**
     * Call script execution on Redis using EVALSHA. Loads script on Redis cache if needed.
     * @param key {any}
     * @returns {Promise<RateLimiterResponse>}
     */
    abstract execScript(key: any): Promise<RateLimiterResponse>
}