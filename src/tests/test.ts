// // import { RedisClient } from 'redis';
// // import Redis from 'ioredis';
// // import { promisify } from 'util';
//
// const script = `
//     local key1 = KEYS[1]
//     local key2 = KEYS[2]
//     local arg1 = ARGV[1]
//     local arg2 = ARGV[2]
//
//     return {key1, key2, arg1, arg2}
// `;
//
// const scriptArguments = [2, 'key1', 'key2', 11, 22];
//
//
// type SendCommandAsync = (...args: any[]) => Promise<any>;
// type SendCommandCallback = (cmd: string, args?: any[], cb?: (err: Error | null, res: any) => any) => any;
//
// interface RedisClient {
//     send_command: SendCommandAsync | SendCommandCallback;
// }
//
// export class RateLimiter {
//     public client: RedisClient;
//
//     constructor(client: RedisClient) {
//         this.client = client;
//     }
//
//     exec = async (): Promise<any> => {
//         switch (this.client.send_command.length) {
//             case 0:
//             case 1:
//                 console.log('ioredis');
//                 break;
//             case 3:
//                 console.log('redis');
//                 break;
//             default:
//                 console.log('unknown');
//         }
//     }
// }

export enum WindowUnit {
    MILLISECOND = -3,
    CENTISECOND = -2,
    DECISECOND = -1,
    SECOND = 0,
    MINUTE = 1,
    HOUR = 2,
    DAY = 3,
    WEEK = 4,
    MONTH = 5,
    YEAR = 6,
}

export const WindowUnitToResolution = {
    [`${WindowUnit.MILLISECOND}:${WindowUnit.MILLISECOND}`]: 1,

    [`${WindowUnit.CENTISECOND}:${WindowUnit.CENTISECOND}`]: 1,
    [`${WindowUnit.CENTISECOND}:${WindowUnit.MILLISECOND}`]: 10,

    [`${WindowUnit.DECISECOND}:${WindowUnit.DECISECOND}`]: 1,
    [`${WindowUnit.DECISECOND}:${WindowUnit.CENTISECOND}`]: 10,
    [`${WindowUnit.DECISECOND}:${WindowUnit.MILLISECOND}`]: 100,

    [`${WindowUnit.SECOND}:${WindowUnit.SECOND}`]: 1,
    [`${WindowUnit.SECOND}:${WindowUnit.DECISECOND}`]: 10,
    [`${WindowUnit.SECOND}:${WindowUnit.CENTISECOND}`]: 100,
    [`${WindowUnit.SECOND}:${WindowUnit.MILLISECOND}`]: 1000,
}

console.log(WindowUnitToResolution[`${WindowUnit.SECOND}:${WindowUnit.CENTISECOND}`])
console.log(WindowUnitToResolution[`${WindowUnit.DECISECOND}:${WindowUnit.CENTISECOND}`])
console.log(WindowUnitToResolution[`${WindowUnit.CENTISECOND}:${WindowUnit.CENTISECOND}`])