// A page call watched for a prompt on the page. A write the page asks its
// operator about would wait out its deadline in CI, where nobody answers,
// so the check fails at once instead, saying what to set (ADR 0034).

/** What the check says when the page prompts for a write. */
export const PROMPTED =
  'the page prompts for a write; set consequential or consequentialTools (ADR 0034)';

/**
 * `pending`, unless `prompted`, looked at every `everyMs` while it waits,
 * finds the page asking its operator about it first: then a failure. A look
 * that throws, such as one that finds two widgets, fails the call too.
 */
export function failOnPrompt<T>(
  pending: Promise<T>,
  prompted: () => Promise<boolean>,
  everyMs: number,
): Promise<T> {
  let settled = false;
  const done = (): void => {
    settled = true;
  };
  // Handled both ways, so a call that fails leaves no second, unhandled rejection behind.
  void pending.then(done, done);
  const watch = new Promise<never>((_resolve, reject) => {
    const look = async (): Promise<void> => {
      if (settled) return;
      if (await prompted()) {
        reject(new Error(PROMPTED));
        return;
      }
      setTimeout(next, everyMs);
    };
    const next = (): void => {
      look().catch(reject);
    };
    setTimeout(next, everyMs);
  });
  return Promise.race([pending, watch]);
}
