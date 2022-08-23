module.exports = {
    roots: ['<rootDir>/src/tests'],
    transform: {
        '^.+\\.tsx?$': 'ts-jest'
    },
    testPathIgnorePatterns: [
        '/node_modules/',
    ],
    verbose: true,
};
