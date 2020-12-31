// import * as redis from 'redis';
// import { RedisClient } from 'redis';
// import Redis, {ValueType} from 'ioredis';
// import { RateLimiter } from './test';
//
// const sleep = (ms: number) => { new Promise<void>((resolve) => setTimeout(resolve, ms)) }
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
// function redisTest() {
//     return new Promise((resolve, reject) => {
//         const client = redis.createClient({
//             host: 'localhost',
//             port: 6379
//         });
//
//         console.log('redis', client.send_command.length);
//         console.log('redis', client instanceof RedisClient);
//         console.log('redis', client instanceof Redis);
//
//         client.send_command('SCRIPT', ['LOAD', script], (err, sha1) => {
//             if (err) {
//                 client.quit();
//                 return reject(err);
//             }
//
//             console.log(sha1);
//
//             client.EVALSHA(sha1, ...scriptArguments, (err, res) => {
//                 if (err) {
//                     client.quit();
//                     return reject(err);
//                 }
//
//                 client.quit();
//                 return resolve(res);
//             });
//         });
//     });
// }
//
// async function ioredisTest() {
//     const client = new Redis({
//         host: 'localhost',
//         port: 6379
//     });
//
//     console.log(client.send_command.toString());
//     return;
//
//     console.log('ioredis', client.send_command.length);
//     console.log('ioredis', client instanceof RedisClient);
//     console.log('ioredis', client instanceof Redis);
//
//     console.log()
//
//     const sha1 = await client.script('LOAD', script);
//     console.log(sha1);
//     const res = await client.send_command('EVALSHA', sha1, ...scriptArguments);
//
//     // client.send_command('EVALSHA', sha1, ...scriptArguments, (err, res) => {})
//
//     await client.quit();
//
//     return res;
// }
//
// async function testLimiter() {
//     const client1 = new Redis({
//         host: 'localhost',
//         port: 6379
//     });
//
//     let limiter = new RateLimiter(client1);
//     await limiter.exec();
//
//     const client2 = redis.createClient({
//         host: 'localhost',
//         port: 6379
//     });
//
//     limiter = new RateLimiter(client2);
//     await limiter.exec();
// }
//
// (async () => {
//     try {
//         // const res1 = await redisTest();
//         // console.log(res1);
//
//         // const res2 = await ioredisTest();
//         // console.log(res2);
//
//         await testLimiter();
//     }
//     catch(err) {
//         console.error(err);
//     }
//
//     // const send_command = async (command: string, ...args: ValueType[]): Promise<any> => {  }
//     // console.log(send_command.length)
//
// })();
