import { getSentryRelease } from '@sentry/node';
import { logger } from '@sentry/utils';
import defaultWebpackPlugin, { SentryCliPluginOptions } from '@sentry/webpack-plugin';
import * as SentryWebpackPlugin from '@sentry/webpack-plugin';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlainObject<T = any> = { [key: string]: T };

// Man are these types hard to name well. "Entry" = an item in some collection of items, but in our case, one of the
// things we're worried about here is property (entry) in an object called... entry. So henceforth, the specific
// proptery we're modifying is going to be known as an EntryProperty, or EP for short.

// The function which is ultimately going to be exported from `next.config.js` under the name `webpack`
type WebpackExport = (config: WebpackConfig, options: WebpackOptions) => WebpackConfig;
// type WebpackExport = (config: WebpackConfig, options: WebpackOptions) => Promise<WebpackConfig>;

// The two arguments passed to the exported `webpack` function, as well as the thing it returns
type WebpackConfig = { devtool: string; plugins: PlainObject[]; entry: EntryProperty };
type WebpackOptions = { dev: boolean; isServer: boolean };

// For our purposes, the value for `entry` is either an object, or a function which returns such an object
type EntryProperty = (() => Promise<EntryPropertyObject>) | EntryPropertyObject;

// Each value in that object is either a string representing a single entry point, an array of such strings, or an
// object containing either of those, along with other configuration options. In that third case, the entry point(s) are
// listed under the key `import`.
type EntryPropertyObject = PlainObject<string | Array<string> | EntryPointObject>;
type EntryPointObject = { import: string | Array<string> };

// const injectSentry = async (origEntryProperty: EntryProperty, isServer: boolean): Promise<EntryPropertyObject> => {
const injectSentry = async (origEntryProperty: EntryProperty, isServer: boolean): Promise<EntryProperty> => {
  // Out of the box, nextjs uses the `() => Promise<EntryPropertyObject>)` flavor of EntryProperty, where the returned
  // object has string arrays for values. But because we don't know whether someone else has come along before us and
  // changed that, we need to check a few things along the way.

  // The `entry` entry in a webpack config can be a string, array of strings, object, or function. By default, nextjs
  // sets it to an async function which returns the promise of an object of string arrays. Because we don't know whether
  // someone else has come along before us and changed that, we need to check a few things along the way. The one thing
  // we know is that it won't have gotten *simpler* in form, so we only need to worry about the object and function
  // options. See https://webpack.js.org/configuration/entry-context/#entry.

  let newEntryProperty = origEntryProperty;

  console.log(origEntryProperty);

  if (typeof origEntryProperty === 'function') {
    newEntryProperty = await origEntryProperty();
  }

  newEntryProperty = newEntryProperty as EntryPropertyObject;

  // according to vercel, we only need to inject Sentry in one spot for server and one spot for client, and because
  // those are used as bases, it will apply everywhere
  const injectionPoint = isServer ? 'pages/_document' : 'main';
  console.log('injectionPoint:', injectionPoint);
  const injectee = isServer ? './sentry.server.config.js' : './sentry.client.config.js';

  // can be a string, array of strings, or object whose `import` property is one of those two
  let injectedInto = newEntryProperty[injectionPoint];

  // whatever the format, add in the sentry file
  injectedInto =
    typeof injectedInto === 'string'
      ? // string case
        [injectee, injectedInto]
      : // not a string, must be an array or object
      Array.isArray(injectedInto)
      ? // array case
        [injectee, ...injectedInto]
      : // object case
        {
          ...injectedInto,
          import:
            typeof injectedInto.import === 'string'
              ? // string case for inner property
                [injectee, injectedInto.import]
              : // array case for inner property
                [injectee, ...injectedInto.import],
        };

  newEntryProperty[injectionPoint] = injectedInto;

  // TODO: hack made necessary because promises are currently kicking my butt
  if ('main.js' in newEntryProperty) {
    delete newEntryProperty['main.js'];
  }

  return newEntryProperty;
};

type NextConfigExports = {
  experimental?: { plugins: boolean };
  plugins?: string[];
  productionBrowserSourceMaps?: boolean;
  webpack?: WebpackExport;
};

export function withSentryConfig(
  providedExports: NextConfigExports = {},
  providedWebpackPluginOptions: Partial<SentryCliPluginOptions> = {},
): NextConfigExports {
  const defaultWebpackPluginOptions = {
    release: getSentryRelease(),
    url: process.env.SENTRY_URL,
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    configFile: 'sentry.properties',
    stripPrefix: ['webpack://_N_E/'],
    urlPrefix: `~/_next`,
    include: '.next/',
    ignore: ['node_modules', 'webpack.config.js'],
  };

  // warn if any of the default options for the webpack plugin are getting overridden
  const webpackPluginOptionOverrides = Object.keys(defaultWebpackPluginOptions)
    .concat('dryrun')
    .map(key => key in Object.keys(providedWebpackPluginOptions));
  if (webpackPluginOptionOverrides.length > 0) {
    logger.warn(
      '[next-plugin-sentry] You are overriding the following automatically-set SentryWebpackPlugin config options:\n' +
        `\t${webpackPluginOptionOverrides.toString()},\n` +
        "which has the possibility of breaking source map upload and application. This is only a good idea if you know what you're doing.",
    );
  }

  // const newWebpackExport = async (config: WebpackConfig, options: WebpackOptions): Promise<WebpackConfig> => {
  const newWebpackExport = (config: WebpackConfig, options: WebpackOptions): WebpackConfig => {
    let newConfig = config;

    if (typeof providedExports.webpack === 'function') {
      newConfig = providedExports.webpack(config, options);
      // newConfig = await providedExports.webpack(config, options);
    }

    // Ensure quality source maps in production. (Source maps aren't uploaded in dev, and besides, Next doesn't let you
    // change this is dev even if you want to - see
    // https://github.com/vercel/next.js/blob/master/errors/improper-devtool.md.)
    if (!options.dev) {
      newConfig.devtool = 'source-map';
    }

    // Inject user config files (`sentry.client.confg.js` and `sentry.server.config.js`), which is where `Sentry.init()`
    // is called. By adding them here, we ensure that they're bundled by webpack as part of both server code and client code.
    newConfig.entry = (injectSentry(newConfig.entry, options.isServer) as unknown) as EntryProperty;
    // newConfig.entry = await injectSentry(newConfig.entry, options.isServer);
    // newConfig.entry = async () => injectSentry(newConfig.entry, options.isServer);

    // Add the Sentry plugin, which uploads source maps to Sentry when not in dev
    newConfig.plugins.push(
      // TODO it's not clear how to do this better, but there *must* be a better way
      new ((SentryWebpackPlugin as unknown) as typeof defaultWebpackPlugin)({
        dryRun: options.dev,
        ...defaultWebpackPluginOptions,
        ...providedWebpackPluginOptions,
      }),
    );

    return newConfig;
  };

  return {
    ...providedExports,
    productionBrowserSourceMaps: true,
    webpack: newWebpackExport,
  };
}
