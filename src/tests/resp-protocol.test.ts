import {
    RateLimiter,
    Unit,
} from '..';

import { SendCommandFn } from '../RateLimiter';

import {
    createRedisClientWithProtocol,
    createIORedisClientWithProtocol,
    toSendCommand,
    parseNegotiatedProtocol,
    flushRedis,
    validateLimiterResponse,
    RespProtocol,
} from './shared';

interface LiveConnection {
    send: SendCommandFn;
    close: () => Promise<void>;
}

interface ProtocolCase {
    clientName: string;
    protocol: RespProtocol;
    connect: () => Promise<LiveConnection>;
}

const protocolCases: ProtocolCase[] = [
    {
        clientName: 'redis',
        protocol: 2,
        connect: async () => {
            const client = createRedisClientWithProtocol(2);
            await client.connect();
            return { send: toSendCommand(client), close: async () => { await client.quit(); } };
        },
    },
    {
        clientName: 'redis',
        protocol: 3,
        connect: async () => {
            const client = createRedisClientWithProtocol(3);
            await client.connect();
            return { send: toSendCommand(client), close: async () => { await client.quit(); } };
        },
    },
    {
        clientName: 'ioredis',
        protocol: 2,
        connect: async () => {
            const client = createIORedisClientWithProtocol(2);
            return { send: toSendCommand(client), close: async () => { await client.quit(); } };
        },
    },
    {
        clientName: 'ioredis',
        protocol: 3,
        connect: async () => {
            const client = createIORedisClientWithProtocol(3);
            return { send: toSendCommand(client), close: async () => { await client.quit(); } };
        },
    },
];

describe('RESP protocol matrix', () => {
    jest.setTimeout(60000);

    for (const testCase of protocolCases) {
        const tag = `[${testCase.clientName} RESP${testCase.protocol}]`;

        /**
         * The reply shape is protocol-independent (the Lua script returns a flat
         * integer array), so admit-then-deny must behave identically on RESP2 and
         * RESP3. Combos the installed client major cannot negotiate are skipped.
         */
        it(`${tag} admits then denies and negotiates the protocol`, async () => {
            const connection = await testCase.connect();

            try {
                const negotiated = parseNegotiatedProtocol(await connection.send('CLIENT', 'INFO'));

                if (negotiated !== testCase.protocol) {
                    console.log(`${tag} SKIPPED: connection negotiated resp=${negotiated}; the installed client major does not support RESP${testCase.protocol}`);
                    return;
                }

                const limiter = new RateLimiter({
                    sendCommand: connection.send,
                    window: { unit: Unit.SECOND, size: 1 },
                    limit: 2,
                });

                await flushRedis(limiter);

                const key = `${tag} resp-matrix`;

                const first = await limiter.get(key);
                const second = await limiter.get(key);
                const third = await limiter.get(key);

                validateLimiterResponse(first, { allowed: true, remaining: 1 });
                validateLimiterResponse(second, { allowed: true, remaining: 0 });
                expect(third.allowed).toBe(false);

                // Confirm the live connection is still speaking the negotiated protocol
                const info = String(await connection.send('CLIENT', 'INFO'));
                expect(info).toContain(`resp=${testCase.protocol}`);
            }
            finally {
                try {
                    await connection.close();
                }
                catch (err) { console.log(err) }
            }
        });
    }
});
