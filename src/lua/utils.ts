type FactorMapper = { [key in WindowUnit]: number }

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

export const WindowUnitToMilliseconds: FactorMapper = {
    [WindowUnit.MILLISECOND]: 1,
    [WindowUnit.CENTISECOND]: 10,
    [WindowUnit.DECISECOND]: 100,
    [WindowUnit.SECOND]: 1000,
    [WindowUnit.MINUTE]: 1000 * 60,
    [WindowUnit.HOUR]: 1000 * 60 * 60,
    [WindowUnit.DAY]: 1000 * 60 * 60 * 24,
    [WindowUnit.WEEK]: 1000 * 60 * 60 * 24 * 7,
    [WindowUnit.MONTH]: 1000 * 60 * 60 * 24 * 30,
    [WindowUnit.YEAR]: 1000 * 60 * 60 * 24 * 365,
};

export const MicrosecondsToWindowResolution: FactorMapper = {
    [WindowUnit.MILLISECOND]: 1 / 1000,
    [WindowUnit.CENTISECOND]: 1 / 10000,
    [WindowUnit.DECISECOND]: 1 / 100000,
    [WindowUnit.SECOND]: 1 / 1000000,
    [WindowUnit.MINUTE]: 1 / (1000000 * 60),
    [WindowUnit.HOUR]: 1 / (1000000 * 60 * 60),
    [WindowUnit.DAY]: 1 / (1000000 * 60 * 60 * 24),
    [WindowUnit.WEEK]: 1 / (1000000 * 60 * 60 * 24 * 7),
    [WindowUnit.MONTH]: 1 / (1000000 * 60 * 60 * 24 * 30),
    [WindowUnit.YEAR]: 1 / (1000000 * 60 * 60 * 365),
};

const WindowUnitToResolution = {
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

    [`${WindowUnit.MINUTE}:${WindowUnit.MINUTE}`]: 1,
    [`${WindowUnit.MINUTE}:${WindowUnit.SECOND}`]: 60,
    [`${WindowUnit.MINUTE}:${WindowUnit.DECISECOND}`]: 60 * 10,
    [`${WindowUnit.MINUTE}:${WindowUnit.CENTISECOND}`]: 60 * 100,
    [`${WindowUnit.MINUTE}:${WindowUnit.MILLISECOND}`]: 60 * 1000,

    [`${WindowUnit.HOUR}:${WindowUnit.HOUR}`]: 1,
    [`${WindowUnit.HOUR}:${WindowUnit.MINUTE}`]: 60,
    [`${WindowUnit.HOUR}:${WindowUnit.SECOND}`]: 60 * 60,
    [`${WindowUnit.HOUR}:${WindowUnit.DECISECOND}`]: 60 * 60 * 10,
    [`${WindowUnit.HOUR}:${WindowUnit.CENTISECOND}`]: 60 * 60 * 100,
    [`${WindowUnit.HOUR}:${WindowUnit.MILLISECOND}`]: 60 * 60 * 1000,

    [`${WindowUnit.DAY}:${WindowUnit.DAY}`]: 1,
    [`${WindowUnit.DAY}:${WindowUnit.HOUR}`]: 24,
    [`${WindowUnit.DAY}:${WindowUnit.MINUTE}`]: 24 * 60,
    [`${WindowUnit.DAY}:${WindowUnit.SECOND}`]: 24 * 60 * 60,
    [`${WindowUnit.DAY}:${WindowUnit.DECISECOND}`]: 24 * 60 * 60 * 10,
    [`${WindowUnit.DAY}:${WindowUnit.CENTISECOND}`]: 24 * 60 * 60 * 100,
    [`${WindowUnit.DAY}:${WindowUnit.MILLISECOND}`]: 24 * 60 * 60 * 1000,

    [`${WindowUnit.WEEK}:${WindowUnit.WEEK}`]: 1,
    [`${WindowUnit.WEEK}:${WindowUnit.DAY}`]: 7,
    [`${WindowUnit.WEEK}:${WindowUnit.HOUR}`]: 7 * 24,
    [`${WindowUnit.WEEK}:${WindowUnit.MINUTE}`]: 7 * 24 * 60,
    [`${WindowUnit.WEEK}:${WindowUnit.SECOND}`]: 7 * 24 * 60 * 60,
    [`${WindowUnit.WEEK}:${WindowUnit.DECISECOND}`]: 7 * 24 * 60 * 60 * 10,
    [`${WindowUnit.WEEK}:${WindowUnit.CENTISECOND}`]: 7 * 24 * 60 * 60 * 100,
    [`${WindowUnit.WEEK}:${WindowUnit.MILLISECOND}`]: 7 * 24 * 60 * 60 * 1000,

    [`${WindowUnit.MONTH}:${WindowUnit.MONTH}`]: 1,
    [`${WindowUnit.MONTH}:${WindowUnit.WEEK}`]: 4,
    [`${WindowUnit.MONTH}:${WindowUnit.DAY}`]: 30,
    [`${WindowUnit.MONTH}:${WindowUnit.HOUR}`]: 30 * 24,
    [`${WindowUnit.MONTH}:${WindowUnit.MINUTE}`]: 30 * 24 * 60,
    [`${WindowUnit.MONTH}:${WindowUnit.SECOND}`]: 30 * 24 * 60 * 60,
    [`${WindowUnit.MONTH}:${WindowUnit.DECISECOND}`]: 30 * 24 * 60 * 60 * 10,
    [`${WindowUnit.MONTH}:${WindowUnit.CENTISECOND}`]: 30 * 24 * 60 * 60 * 100,
    [`${WindowUnit.MONTH}:${WindowUnit.MILLISECOND}`]: 30 * 24 * 60 * 60 * 1000,

    [`${WindowUnit.YEAR}:${WindowUnit.YEAR}`]: 1,
    [`${WindowUnit.YEAR}:${WindowUnit.MONTH}`]: 12,
    [`${WindowUnit.YEAR}:${WindowUnit.WEEK}`]: 52,
    [`${WindowUnit.YEAR}:${WindowUnit.DAY}`]: 365,
    [`${WindowUnit.YEAR}:${WindowUnit.HOUR}`]: 365 * 24,
    [`${WindowUnit.YEAR}:${WindowUnit.MINUTE}`]: 365 * 24 * 60,
    [`${WindowUnit.YEAR}:${WindowUnit.SECOND}`]: 365 * 24 * 60 * 60,
    [`${WindowUnit.YEAR}:${WindowUnit.DECISECOND}`]: 365 * 24 * 60 * 60 * 10,
    [`${WindowUnit.YEAR}:${WindowUnit.CENTISECOND}`]: 365 * 24 * 60 * 60 * 100,
    [`${WindowUnit.YEAR}:${WindowUnit.MILLISECOND}`]: 365 * 24 * 60 * 60 * 1000,
}

export const convertUnitToResolution = (unit: WindowUnit, resolution: WindowUnit): number => {
    return WindowUnitToResolution[`${unit}:${resolution}`];
}