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

// Single source of truth for window durations.
// A MONTH is 30 days and a YEAR is 365 days.
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
