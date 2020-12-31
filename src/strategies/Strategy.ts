import { RateLimiter, RateLimiterResponse } from '../RateLimiter';

export abstract class Strategy {
    limiter: RateLimiter;
    scriptSha1?: string;

    constructor(limiter: RateLimiter) {
        this.limiter = limiter;
    }

    abstract loadScript(script: string): Promise<string>
    abstract execScript(key: any): Promise<RateLimiterResponse>
}