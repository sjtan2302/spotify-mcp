/** Result helpers shared by the servers in this repo. */

export type TextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Uniform text result. */
export const text = (body: string): TextResult => ({
  content: [{ type: "text" as const, text: body }],
});

/**
 * Handlers throw freely; this turns a failure into a result the model can read
 * and recover from, instead of an exception that kills the connection.
 */
export function guard<A>(fn: (args: A) => Promise<TextResult>) {
  return async (args: A): Promise<TextResult> => {
    try {
      return await fn(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...text(`Error: ${message}`), isError: true };
    }
  };
}

/** Join non-empty sections with blank lines between them. */
export const sections = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join("\n\n");
