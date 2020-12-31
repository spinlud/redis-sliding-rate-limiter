import { RateLimiter, RateLimiterResponse } from '../RateLimiter';

export abstract class Strategy {
    limiter: RateLimiter;
    scriptSha1?: string;

    constructor(limiter: RateLimiter) {
        this.limiter = limiter;
    }

    /**
     * Load script on Redis cache and returns sha1 of the script
     * @returns {Promise<string>}
     */
    abstract loadScript(): Promise<string>

    /**
     * Call script execution on Redis using EVALSHA. Loads script on Redis cache if needed.
     * @param {any} key
     * @returns {Promise<RateLimiterResponse>}
     */
    abstract execScript(key: any): Promise<RateLimiterResponse>
}