module.exports = {
    roots: ['<rootDir>/src/tests'],
    transform: {
        '^.+\\.tsx?$': 'ts-jest'
    },
    testPathIgnorePatterns: [
        '/node_modules/',
    ],
    verbose: true,
    collectCoverage: true,
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/index.ts',
        '!src/tests/**',
        '!src/examples/**',
        '!src/tmp/**',
    ],
    coverageDirectory: '<rootDir>/coverage',
    coverageThreshold: {
        global: {
            statements: 80,
            branches: 78,
            functions: 70,
            lines: 80,
        },
    },
};
