/** Makes Express 4 handle async route handlers safely.
 *
 * Express 4 predates async/await: it calls a handler and ignores whatever
 * it returns. A handler declared `async` that throws therefore produces a
 * rejected promise nobody is watching - which on modern Node terminates
 * the process. Every route in this app now awaits a database on another
 * machine, so that failure mode is one dropped connection away from
 * turning a blip into a restart loop.
 *
 * Rather than wrapping 40-odd handlers by hand (and relying on nobody
 * forgetting the wrapper on the next route added), this patches the
 * router's registration methods once: any handler declared with `async`
 * gets its rejection routed to next(), so it lands in the normal error
 * middleware and returns a 500 like any other failure.
 *
 * Sync handlers pass through untouched. Four-argument error middleware
 * also passes through untouched - it is registered as a plain function in
 * this codebase, and wrapping would change its arity and stop Express
 * recognising it as an error handler.
 */
function autoWrapAsync(target) {
  for (const method of ["get", "post", "put", "patch", "delete", "all", "use"]) {
    const original = target[method].bind(target);
    target[method] = (...args) => original(...args.map((arg) => {
      if (typeof arg !== "function") return arg;
      if (arg.constructor.name !== "AsyncFunction") return arg;
      // Arity 4 means error middleware; leave its shape alone.
      if (arg.length === 4) return arg;
      return function wrappedAsyncHandler(req, res, next) {
        return Promise.resolve(arg(req, res, next)).catch(next);
      };
    }));
  }
  return target;
}

module.exports = { autoWrapAsync };
