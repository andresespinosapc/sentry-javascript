/* eslint-disable @typescript-eslint/no-explicit-any */
import { hasTracingEnabled } from '@sentry/tracing';
import { Transaction } from '@sentry/types';
import { fill } from '@sentry/utils';
import * as http from 'http';
import { default as createNextServer } from 'next';
import * as url from 'url';

import * as Sentry from '../index.server';

interface NextServer {
  server: Server;
  reqHandlerPromise: Promise<ReqHandler>;
  createServer: (options: { [key: string]: any }) => Server;
}

interface Server {
  dir: string;
  publicDir: string;
  generatePublicRoutes: () => Route[];
}

interface Route {
  match: (url: string) => boolean | { path: string[] };
  fn: (req: http.IncomingMessage, ...args: unknown[]) => Promise<{ finished: boolean }>;
}

type HandlerGetter = () => Promise<ReqHandler>;
type ReqHandler = (req: NextRequest, res: NextResponse, parsedUrl?: url.UrlWithParsedQuery) => Promise<void>;
type RenderArgs = [NextRequest, NextResponse, string, { query: Record<string, string> }];
type Renderer = (...args: RenderArgs) => Promise<string | null>;

// these aliases are purely to make the function signatures more easily understandable
type WrappedHandlerGetter = HandlerGetter;
type WrappedReqHandler = ReqHandler;
type WrappedRenderer = Renderer;

interface NextRequest extends http.IncomingMessage {
  cookies: Record<string, string>;
  url: string;
}

interface NextResponse extends http.ServerResponse {
  // __sentry_transaction__?: Transaction;
  __sentry__: {
    transaction?: Transaction;
    parameterizedPath?: string;
    params?: Record<string, string>;
    request: {
      url: string;
      headers: http.IncomingHttpHeaders;
      cookies: Record<string, string>;
      // TODO is data actually supposed to be the request body?
      // data?: { path: string; query: Record<string, string> };
    };
  };
}

// TODO is it necessary for this to be an object?
const closure: Record<string, any> = {};

/**
 * Do the monkeypatching and wrapping necessary to create a transaction for each request, and name it with the
 * parameterized path. Run by the plugin at server start up. Along the way, as a bonus, it grabs (and returns) the path
 * of the project root, for use in `RewriteFrames`.
 *
 * @returns The absolute path of the project root directory
 *
 */
export function instrumentServerForTracing(): string {
  const nextServerPrototype = Object.getPrototypeOf(createNextServer({}));

  // wrap this getter because it runs before the request handler runs, which gives us a chance to wrap that request
  // handler before it's called the first time
  fill(nextServerPrototype, 'getServerRequestHandler', makeWrappedHandlerGetter);

  return closure.projectRootDir;
}

/**
 * Create a wrapped version of Nextjs's `NextServer.getServerRequestHandler` method, as a way to access the running
 * `Server` instance and monkeypatch its prototype.
 *
 * @param origHandlerGetter Nextjs's `NextServer.getServerRequestHandler` method
 * @returns A wrapped version of the same method, to monkeypatch in at server startup
 */
function makeWrappedHandlerGetter(origHandlerGetter: HandlerGetter): WrappedHandlerGetter {
  // We wrap this purely in order to be able to grab data and do further monkeypatching the first time it runs.
  // Otherwise, it's just a pass-through to the original method.
  const wrappedHandlerGetter = async function(this: NextServer): Promise<ReqHandler> {
    if (!closure.wrappingComplete) {
      closure.server = this.server;
      closure.projectRootDir = this.server.dir;
      process.env.__SENTRY_PROJECT_ROOT = this.server.dir;

      const serverPrototype = Object.getPrototypeOf(this.server);

      // wrap the render method on the `Server` prototype to store the parameterized path on the request
      fill(serverPrototype, 'renderToHTMLWithComponents', makeWrappedRenderer);

      // wrap the request handler to create request transactions
      fill(serverPrototype, 'handleRequest', makeWrappedReqHandler);

      closure.wrappingComplete = true;
    }

    return origHandlerGetter.call(this);
  };

  return wrappedHandlerGetter;
}

/**
 * Create a wrapped version of `Server.handleRequest`, in order to create request transactions
 *
 * @param origReqHandler Nextjs's `Server.handleRequest` method
 * @returns A wrapped version of the method, to monkeypatch in at server startup
 */
function makeWrappedReqHandler(origReqHandler: ReqHandler): WrappedReqHandler {
  const liveServer = closure.server as Server;

  // make a route for the `public` folder, which holds static resources like images
  // use a different `this`, so that the route's `fn` function can't cause side effects in the real server
  const dummyThis = {
    publicDir: liveServer.publicDir,
    nextConfig: {},
    // sub in a noop so that when we get a route match (independent of the real router; ours is just for filtering
    // transactions), we don't actually serve up any files
    serveStatic: async () => {
      /** noop */
    },
  };
  const publicRoute = (liveServer.generatePublicRoutes.call(dummyThis) as Route[])[0];

  // add tracing to the normal request handling
  const wrappedReqHandler = async function(
    this: Server,
    req: NextRequest,
    res: NextResponse,
    parsedUrl?: url.UrlWithParsedQuery,
  ): Promise<void> {
    res.__sentry__ = { request: { url: req.url, headers: req.headers, cookies: req.cookies } };

    if (hasTracingEnabled() && (await _shouldTraceRequest(req, publicRoute))) {
      debugger;
      const transaction = Sentry.startTransaction({
        name: `${(req.method || 'GET').toUpperCase()} ${req.url}`,
        op: 'http.server',
      });
      // TODO - how to keep scope data from leaking between requests?
      Sentry.getCurrentHub()
        .getScope()
        ?.setSpan(transaction);
      res.__sentry__.transaction = transaction;
    }

    res.once('finish', () => {
      const transaction = res.__sentry__.transaction;
      if (transaction) {
        // Push `transaction.finish` to the next event loop so open spans have a chance to finish before the transaction
        // closes
        setImmediate(() => {
          // TODO
          // addExpressReqToTransaction(transaction, req);
          transaction.name = transaction.name.replace(req.url, res.__sentry__.parameterizedPath!);
          transaction.data = {
            request: res.__sentry__.request,
            ...(res.__sentry__.params && { pathParams: res.__sentry__.params }),
          };
          transaction.setHttpStatus(res.statusCode);
          transaction.finish();
        });
      }
    });

    return origReqHandler.call(this, req, res, parsedUrl);
  };

  return wrappedReqHandler;
}

/**
 * Create a wrapped version of `Server.renderToHTMLWithComponents`, which is the first spot in the request handling
 * pipeline where the parameterized url is available, in order to harvest that data for the transaction name.
 *
 * @param origRender Nextjs's `Server.renderToHTMLWithComponents` method
 * @returns A wrapped version of the method, to monkeypatch in at server startup
 */
function makeWrappedRenderer(origRender: Renderer): WrappedRenderer {
  const wrappedRender = function(this: Server, ...args: RenderArgs): Promise<string | null> {
    // if (res.__sentry_transaction__) {
    // }
    // addDataToRequest(args);
    const [req, res, pathname, { query }] = args;
    debugger;
    res.__sentry__.parameterizedPath = pathname;
    if (pathname !== req.url.split('&')[0]) {
      // TODO
    }
    res.__sentry__.params = query;
    return origRender.call(this, ...args);
  };

  return wrappedRender;
}

/**
 * Filter out background requests madw by the Nextjs front end, as well as static resource requests.
 *
 * @param req The `Request` object
 * @param publicRoute A copy of the route Nextjs uses to match static resource requests
 * @returns A resolved promise of a boolean
 */
async function _shouldTraceRequest(req: NextRequest, publicRoute: Route): Promise<boolean> {
  if (
    // requests by next itself for bundles and the like
    req.url.startsWith('/_next/') ||
    // static resources (deprecated but still-functional location)
    req.url.startsWith('/static/') ||
    // more static resources - technically async, but with its async innards replaced with a noop, so effectively sync
    (await _isStaticResourceRequest(req, publicRoute))
  ) {
    return false;
  }

  return true;
}

/**
 * Determine if this request matches the route for static resources
 *
 * @param req The `Request` object
 * @param publicRoute A copy of the route Nextjs uses to match static resource requests
 * @returns A resolved promise of a boolean
 */
async function _isStaticResourceRequest(req: NextRequest, publicRoute: Route): Promise<boolean> {
  if (req.url === '/') {
    return false;
  }

  const { match: regexMatcher, fn: filenameMatcher } = publicRoute;

  const regexMatch = regexMatcher(req.url);

  if (!regexMatch) {
    return false;
  }

  // technically async, but with the async part of its innards replaced with a noop, so effectively sync
  return filenameMatcher(req, {}, regexMatch).then(
    // next only sets `finished` to `true` if there's a match
    result => result.finished,
  );
}

// /**
//  *
//  */
// function addRequestDataToTransaction[req, res, pathname, { query }]: RenderArgs): void {
//   if (!res.__sentry_transaction__) {
//     return;
//   }

//   const transaction = res.__sentry_transaction__;

//   const { cookies, headers, url } = req;

//   transcaction.name = transaction.name.replace(url, pathname);
//   transaction.data = { ...transaction.data, request: { url, headers, cookies, data: { query } } };
// }
