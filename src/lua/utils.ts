type FactorMapper = { [key in Unit]: number }

export enum Unit {
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
    [Unit.MILLISECOND]: 1,
    [Unit.CENTISECOND]: 10,
    [Unit.DECISECOND]: 100,
    [Unit.SECOND]: 1000,
    [Unit.MINUTE]: 1000 * 60,
    [Unit.HOUR]: 1000 * 60 * 60,
    [Unit.DAY]: 1000 * 60 * 60 * 24,
    [Unit.WEEK]: 1000 * 60 * 60 * 24 * 7,
    [Unit.MONTH]: 1000 * 60 * 60 * 24 * 30,
    [Unit.YEAR]: 1000 * 60 * 60 * 24 * 365,
};

export const MicrosecondsToWindowSubdivision: FactorMapper = {
    [Unit.MILLISECOND]: 1 / 1000,
    [Unit.CENTISECOND]: 1 / 10000,
    [Unit.DECISECOND]: 1 / 100000,
    [Unit.SECOND]: 1 / 1000000,
    [Unit.MINUTE]: 1 / (1000000 * 60),
    [Unit.HOUR]: 1 / (1000000 * 60 * 60),
    [Unit.DAY]: 1 / (1000000 * 60 * 60 * 24),
    [Unit.WEEK]: 1 / (1000000 * 60 * 60 * 24 * 7),
    [Unit.MONTH]: 1 / (1000000 * 60 * 60 * 24 * 30),
    [Unit.YEAR]: 1 / (1000000 * 60 * 60 * 365),
};

const WindowUnitToSubdivision = {
    [`${Unit.MILLISECOND}:${Unit.MILLISECOND}`]: 1,

    [`${Unit.CENTISECOND}:${Unit.CENTISECOND}`]: 1,
    [`${Unit.CENTISECOND}:${Unit.MILLISECOND}`]: 10,

    [`${Unit.DECISECOND}:${Unit.DECISECOND}`]: 1,
    [`${Unit.DECISECOND}:${Unit.CENTISECOND}`]: 10,
    [`${Unit.DECISECOND}:${Unit.MILLISECOND}`]: 100,

    [`${Unit.SECOND}:${Unit.SECOND}`]: 1,
    [`${Unit.SECOND}:${Unit.DECISECOND}`]: 10,
    [`${Unit.SECOND}:${Unit.CENTISECOND}`]: 100,
    [`${Unit.SECOND}:${Unit.MILLISECOND}`]: 1000,

    [`${Unit.MINUTE}:${Unit.MINUTE}`]: 1,
    [`${Unit.MINUTE}:${Unit.SECOND}`]: 60,
    [`${Unit.MINUTE}:${Unit.DECISECOND}`]: 60 * 10,
    [`${Unit.MINUTE}:${Unit.CENTISECOND}`]: 60 * 100,
    [`${Unit.MINUTE}:${Unit.MILLISECOND}`]: 60 * 1000,

    [`${Unit.HOUR}:${Unit.HOUR}`]: 1,
    [`${Unit.HOUR}:${Unit.MINUTE}`]: 60,
    [`${Unit.HOUR}:${Unit.SECOND}`]: 60 * 60,
    [`${Unit.HOUR}:${Unit.DECISECOND}`]: 60 * 60 * 10,
    [`${Unit.HOUR}:${Unit.CENTISECOND}`]: 60 * 60 * 100,
    [`${Unit.HOUR}:${Unit.MILLISECOND}`]: 60 * 60 * 1000,

    [`${Unit.DAY}:${Unit.DAY}`]: 1,
    [`${Unit.DAY}:${Unit.HOUR}`]: 24,
    [`${Unit.DAY}:${Unit.MINUTE}`]: 24 * 60,
    [`${Unit.DAY}:${Unit.SECOND}`]: 24 * 60 * 60,
    [`${Unit.DAY}:${Unit.DECISECOND}`]: 24 * 60 * 60 * 10,
    [`${Unit.DAY}:${Unit.CENTISECOND}`]: 24 * 60 * 60 * 100,
    [`${Unit.DAY}:${Unit.MILLISECOND}`]: 24 * 60 * 60 * 1000,

    [`${Unit.WEEK}:${Unit.WEEK}`]: 1,
    [`${Unit.WEEK}:${Unit.DAY}`]: 7,
    [`${Unit.WEEK}:${Unit.HOUR}`]: 7 * 24,
    [`${Unit.WEEK}:${Unit.MINUTE}`]: 7 * 24 * 60,
    [`${Unit.WEEK}:${Unit.SECOND}`]: 7 * 24 * 60 * 60,
    [`${Unit.WEEK}:${Unit.DECISECOND}`]: 7 * 24 * 60 * 60 * 10,
    [`${Unit.WEEK}:${Unit.CENTISECOND}`]: 7 * 24 * 60 * 60 * 100,
    [`${Unit.WEEK}:${Unit.MILLISECOND}`]: 7 * 24 * 60 * 60 * 1000,

    [`${Unit.MONTH}:${Unit.MONTH}`]: 1,
    [`${Unit.MONTH}:${Unit.WEEK}`]: 4,
    [`${Unit.MONTH}:${Unit.DAY}`]: 30,
    [`${Unit.MONTH}:${Unit.HOUR}`]: 30 * 24,
    [`${Unit.MONTH}:${Unit.MINUTE}`]: 30 * 24 * 60,
    [`${Unit.MONTH}:${Unit.SECOND}`]: 30 * 24 * 60 * 60,
    [`${Unit.MONTH}:${Unit.DECISECOND}`]: 30 * 24 * 60 * 60 * 10,
    [`${Unit.MONTH}:${Unit.CENTISECOND}`]: 30 * 24 * 60 * 60 * 100,
    [`${Unit.MONTH}:${Unit.MILLISECOND}`]: 30 * 24 * 60 * 60 * 1000,

    [`${Unit.YEAR}:${Unit.YEAR}`]: 1,
    [`${Unit.YEAR}:${Unit.MONTH}`]: 12,
    [`${Unit.YEAR}:${Unit.WEEK}`]: 52,
    [`${Unit.YEAR}:${Unit.DAY}`]: 365,
    [`${Unit.YEAR}:${Unit.HOUR}`]: 365 * 24,
    [`${Unit.YEAR}:${Unit.MINUTE}`]: 365 * 24 * 60,
    [`${Unit.YEAR}:${Unit.SECOND}`]: 365 * 24 * 60 * 60,
    [`${Unit.YEAR}:${Unit.DECISECOND}`]: 365 * 24 * 60 * 60 * 10,
    [`${Unit.YEAR}:${Unit.CENTISECOND}`]: 365 * 24 * 60 * 60 * 100,
    [`${Unit.YEAR}:${Unit.MILLISECOND}`]: 365 * 24 * 60 * 60 * 1000,
}

export const convertWindowUnitToSubdivision = (windowUnit: Unit, subdivision: Unit): number => {
    // @ts-ignore
    return WindowUnitToSubdivision[`${windowUnit}:${subdivision}`];
}