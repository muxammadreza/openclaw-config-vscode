export function createSerializedRunner<T, TResult>(
  task: (input: T) => Promise<TResult>,
): (input: T) => Promise<TResult> {
  let queue: Promise<unknown> = Promise.resolve();

  return async (input: T): Promise<TResult> => {
    const run = queue.catch(() => undefined).then(() => task(input));
    queue = run;
    return run;
  };
}
