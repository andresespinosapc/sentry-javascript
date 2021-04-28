// there's apparently no way to get at this with `import`
// TODO - really?
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

import { NextApiRequest, NextApiResponse } from 'next';

import * as Sentry from '../index.server';

type ModuleObject = {
  _compile: (code: string, filename: string) => void;
  exports: { default: unknown };
};

type LoaderContext = { resource: string; loaders: Loader[] };
type Loader = { options: LoaderOptions; path: string };
type LoaderOptions = { sdkPath: string };

type RequestHandler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
type WrappedRequestHandler = RequestHandler; // purely for ease of reading

/**
 * Replace the API route handler in the given code with a wrapped version.
 *
 * @param this Context data passed to the loader
 * @param rawInput The stringified code we're modifying
 * @returns Modified stringified code
 */
export default function load(this: LoaderContext, rawInput: string): string {
  const options = getOptions(this.loaders) as LoaderOptions;

  // Wherever this is running, it can't seem to resolve the Sentry SDK when referred to by
  // name (which it will have to do below when it compiles the stringified code into an actual module). Fortunately,
  // we're able to do so from within our config file, so we just pass the absolute path through in `options`
  const origCode = rawInput.replace('@sentry/nextjs', options.sdkPath);

  // `module.parent` comes back as `null` rather than `undefined` when there is no parent, but the `Module` constructor
  // below needs `undefined` instead. Because reasons.
  const parent = module.parent || undefined;
  // It's unclear what this does for us, if anything
  const filename = 'lookIMadeAModule';

  // Compile the stringified code into an actual Module object so we can grab its default export (the route handler) for
  // wrapping
  const routeModule = new Module(filename, parent) as ModuleObject;
  routeModule._compile(origCode, filename);
  const origHandler = routeModule.exports.default;

  if (typeof origHandler !== 'function') {
    // eslint-disable-next-line no-console
    console.warn(`[Sentry] Could not wrap ${this.resource} for error handling. Default export is not a function.`);
    return rawInput;
  }

  // Wrap the route handler in a try/catch to catch any errors which it generates
  const newHandler = makeWrappedRequestHandler(origHandler as RequestHandler);

  // Ultimately we have to return a string, and we need the wrapped handler to take the place of the original one (as
  // the default export) so literally substitute it in
  let newCode = origCode.replace(origHandler.toString(), newHandler.toString());

  // The new function we just subbed in is, character for character, the code written below as the return value of
  // `makeWrappedRequestHandler`, which means we have to define `origHandler`, since its code has now been replaced
  newCode = `${newCode}\n\nconst origHandler = ${origHandler.toString()}`;

  return newCode;
}

/** Extract the options for this loader out of the array of loaders in scope */
function getOptions(loaders: Loader[]): LoaderOptions | undefined {
  for (const loader of loaders) {
    if (loader.path.includes('nextjs/dist/utils/api-wrapping-loader')) {
      return loader.options;
    }
  }
  // we shouldn't ever get here - one of the given loaders should be this loader
  return undefined;
}

/** Wrap the given request handler for error-catching purposes */
function makeWrappedRequestHandler(origHandler: RequestHandler): WrappedRequestHandler {
  // TODO are there any overloads we need to worry about?
  return async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
    try {
      return await origHandler(req, res);
    } catch (err) {
      Sentry.captureException(err);
      await Sentry.flush(2000);
      throw err;
    }
  };
}
