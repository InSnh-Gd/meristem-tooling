declare module 'bun:test' {
  export type TestFunction = (name: string, fn: () => void | Promise<void>) => void;
  export type DescribeFunction = (name: string, fn: () => void | Promise<void>) => void;

  export type ExpectMatcher<T> = {
    toBe(expected: T): void;
  };

  export const describe: DescribeFunction;
  export const test: TestFunction;
  export const it: TestFunction;
  export const expect: <T>(actual: T) => ExpectMatcher<T>;
}
