// Test-only lifecycle tracking. Keep interception registered until callbacks,
// including requests arriving during teardown, have finished their work.
export function trackPageRoutes(page, {timeout = 5000} = {}) {
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 30000)
    throw new Error('Route drain needs a positive bounded timeout.');
  const originalRoute = page.route,
    originalUnroute = page.unroute,
    wrappers = new WeakMap(),
    registrations = [],
    pending = new Set(),
    errors = [];
  let draining = false;
  page.route = function (url, handler, options) {
    if (draining)
      throw new Error('Cannot register mock routes during teardown.');
    if (typeof handler !== 'function')
      throw new TypeError('Mock route handler must be a function.');
    let wrapped = wrappers.get(handler);
    if (!wrapped) {
      wrapped = async (route, request) => {
        const closing = draining;
        const completion = Promise.resolve().then(() =>
          closing ? route.abort() : handler(route, request),
        );
        pending.add(completion);
        try {
          return await completion;
        } catch (error) {
          errors.push(error);
          throw error;
        } finally {
          pending.delete(completion);
        }
      };
      wrappers.set(handler, wrapped);
    }
    registrations.push({url, wrapped});
    return originalRoute.call(page, url, wrapped, options);
  };
  page.unroute = function (url, handler) {
    return originalUnroute.call(page, url, wrappers.get(handler) || handler);
  };
  let disposal;
  return {
    dispose() {
      if (disposal) return disposal;
      disposal = (async () => {
        draining = true;
        let timer,
          expired = false;
        try {
          await Promise.race([
            (async () => {
              while (pending.size && !expired)
                await Promise.allSettled([...pending]);
              if (expired) return;
              let removalError;
              try {
                // Keep the page interceptor installed through context close.
                // Removing its last route can automatically continue a request
                // whose page callback already fell back to the context guard.
                await originalRoute.call(page, '**/*', (route) =>
                  route.fallback(),
                );
                for (const {url, wrapped} of registrations) {
                  if (expired) return;
                  await originalUnroute.call(page, url, wrapped);
                }
              } catch (error) {
                removalError = error;
              }
              // Include callbacks dispatched while the barrier was installed,
              // even if removing an owned registration failed.
              while (pending.size && !expired)
                await Promise.allSettled([...pending]);
              if (expired) return;
              const failures = removalError
                ? [...errors, removalError]
                : errors;
              if (failures.length)
                throw new AggregateError(
                  failures,
                  'Mock route callback or cleanup failed.',
                );
            })(),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                expired = true;
                reject(
                  new Error(
                    'Mock routes did not drain and unregister before teardown.',
                  ),
                );
              }, timeout);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          page.route = originalRoute;
          page.unroute = originalUnroute;
        }
      })();
      return disposal;
    },
  };
}
