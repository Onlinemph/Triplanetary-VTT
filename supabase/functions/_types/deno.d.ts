/**
 * Just enough of Deno to typecheck the referee from Node.
 *
 * The Edge Function runs on Deno, which supplies these globally. Installing
 * Deno only to typecheck two calls would be a heavy way to buy a small thing,
 * and a hand-written surface has the advantage of being a list: if the function
 * starts reaching for more of the runtime, this file has to say so out loud.
 *
 * Nothing imports it. `tsconfig.functions.json` includes it, and Deno ignores
 * it, because Deno already knows.
 */

declare namespace Deno {
  const env: {
    get(key: string): string | undefined;
  };
  function serve(handler: (request: Request) => Response | Promise<Response>): unknown;
}
